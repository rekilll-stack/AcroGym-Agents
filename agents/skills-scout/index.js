'use strict';
/* Skills-scout: раз в неделю ищет новые скиллы для Claude Code, проверяет их в песочнице (файлы, сеть, хуки, инъекции),
   оценивает пользу для НАШЕГО стека подписочным шимом и присылает владельцу короткий отчёт.
   САМ НИЧЕГО НЕ ВКЛЮЧАЕТ: замороженная копия кандидата ложится в ~/.claude/skills-staging/<name>/ (протокол #38: читать целиком,
   замораживать, ставить только по ОК владельца). Запуск: node agents/skills-scout/index.js [--now] [--dry] [--limit N]
   ponytail: GitHub без токена = 10 поисков/мин, 60 запросов/час — нам хватает; при росте каталогов добавить GH_TOKEN из env. */
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const ROOT = '/home/admin/acrogym';
const STATE = path.join(ROOT, 'data', 'skills-scout.json');
const STAGING = '/home/admin/.claude/skills-staging';
const INSTALLED = ['/home/admin/.claude/skills', path.join(ROOT, '.claude', 'skills'), '/home/admin/acrogym-site/.claude/skills'];
const SANDBOX = '/tmp/claude-1000/skills-scout';
const CLI = process.env.CLAUDE_CLI || '/home/admin/.npm-global/bin/claude';
const args = process.argv.slice(2); const DRY = args.includes('--dry'); const ALL = args.includes('--all'); const RESCAN = args.includes('--rescan');
const LIMIT = ALL ? Infinity : +(args[args.indexOf('--limit') + 1] || 8); /* --all: разобрать ВСЮ выдачу, а не топ-8 за прогон (владелец 06.09) */
const MAXSK = ALL ? 12 : 5; /* в полном проходе смотрим больше навыков на репо */
const log = (...a) => console.log(new Date().toISOString(), ...a);
const state = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return { seen: {}, runs: [] }; } })();
const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
const UA = { 'User-Agent': 'acrogym-skills-scout/1.0 (+https://acrogym.org)', Accept: 'application/vnd.github+json' };

/* Наш стек — для оценки пользы. Держать в актуальном виде руками. */
const PROFILE = `AcroGym (детская гимнастика, Доха). Стек: Node.js 20 без фреймворков (stdlib http, better-sqlite3), pm2, nginx, Cloudflare; сайт Nuxt 4 / Vue (статика), админка Express; Telegram-боты (owner-bot, content-bot, answer-bot); MCP-мост (@modelcontextprotocol/sdk) для Android WebView и Electron-приложения владельца; Playwright-драйвер веб-панели CRM in2 (публичный REST API + скрапинг SPA); Gmail (2 ящика), Google Sheets, n8n, Metricool/Instagram, Canva; генерация PDF/картинок (node-canvas, pdf.js), TTS/STT (piper, faster-whisper); Claude по подписке через claude -p (не API). Боли: стабильность скрапинга SPA, качество входных данных форм, i18n RU/EN, дизайн в бренде (Montserrat, #28347F/#F37021), a11y, тесты Playwright, безопасность секретов, деплой без sudo. НЕ нужно: React/Next-специфика, мобильная разработка iOS, облака AWS/GCP, ML-обучение, игры.`;

const fetchJson = async (url) => { const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url); return r.json(); };
const fetchText = async (url) => { const r = await fetch(url, { headers: { 'User-Agent': UA['User-Agent'] }, signal: AbortSignal.timeout(20000) }); return r.ok ? r.text() : ''; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 1. Источники: поиск репозиториев по темам/словам + свежие ссылки из awesome-списков. */
async function discover() {
  const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  const queries = [
    `topic:claude-skills pushed:>${since}`, `topic:claude-code-skills pushed:>${since}`, `topic:agent-skills pushed:>${since}`,
    `"SKILL.md" claude skill pushed:>${since}`, `claude code skill in:name,description pushed:>${since}`,
    'awesome claude skills in:name,description', 'awesome claude code in:name,description',
  ];
  const repos = new Map();
  for (const q of queries) {
    try { const d = await fetchJson('https://api.github.com/search/repositories?q=' + encodeURIComponent(q) + '&sort=stars&order=desc&per_page=20'); for (const r of d.items || []) repos.set(r.full_name, r); }
    catch (e) { log('search fail', q, e.message); }
    await sleep(7000); /* 10 поисков/мин без токена */
  }
  /* awesome-списки: вытащить github-ссылки из README (кап 40 на список) */
  for (const r of [...repos.values()].filter((x) => /awesome/i.test(x.name)).slice(0, 4)) {
    const md = await fetchText(`https://raw.githubusercontent.com/${r.full_name}/${r.default_branch}/README.md`);
    const links = [...new Set((md.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+/g) || []).map((u) => u.replace(/\.git$/, '').replace('https://github.com/', '')))].slice(0, 40);
    for (const fn of links) if (!repos.has(fn) && !state.seen[fn]) { try { repos.set(fn, await fetchJson('https://api.github.com/repos/' + fn)); await sleep(1200); } catch (_) {} }
  }
  return [...repos.values()].filter((r) => r && !r.fork && !r.archived && (r.size || 0) < 20000);
}

/* 2. Аудит в песочнице: клон, поиск SKILL.md, сканы. */
function audit(fullName, branch) {
  const dir = path.join(SANDBOX, fullName.replace('/', '__'));
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(SANDBOX, { recursive: true });
  execFileSync('git', ['clone', '--depth', '1', '--quiet', '--branch', branch, `https://github.com/${fullName}.git`, dir], { timeout: 60000, stdio: 'ignore' });
  const files = execFileSync('bash', ['-c', `cd "${dir}" && find . -type f -not -path './.git/*' | head -400`]).toString().trim().split('\n').filter(Boolean);
  const skills = files.filter((f) => /(^|\/)SKILL\.md$/i.test(f));
  if (!skills.length) return { dir, skills: [] };
  const out = [];
  for (const sk of skills) {
    const skDir = path.dirname(sk); const inDir = files.filter((f) => f.startsWith(skDir + '/') || f === sk);
    const md = fs.readFileSync(path.join(dir, sk), 'utf8');
    const fm = md.match(/^---\n([\s\S]*?)\n---/); const name = ((fm && fm[1].match(/^name:\s*(.+)$/m)) || [])[1] || path.basename(skDir);
    const desc = ((fm && fm[1].match(/^description:\s*(.+)$/m)) || [])[1] || '';
    const scripts = inDir.filter((f) => !/\.(md|txt|json|ya?ml)$/i.test(f));
    const blob = inDir.map((f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return ''; } }).join('\n');
    const flags = [];
    const urls = [...new Set(blob.match(/https?:\/\/[^\s"'`)>]+/g) || [])].filter((u) => !/github\.com|githubusercontent|npmjs|docs\.|example\.com|localhost/.test(u));
    if (/fetch\(|requests\.|urllib|axios|curl |wget |http\.get|net\.connect|new WebSocket/.test(blob)) flags.push('сеть');
    if (/\.claude\/settings|settings\.local\.json|"hooks"|hooks:/.test(blob)) flags.push('пишет хуки/настройки');
    if (/curl[^\n]*\|\s*(ba)?sh|npx [\w@/.-]+|pip install|npm i(nstall)? /.test(blob)) flags.push('ставит зависимости');
    if (/eval\(|base64|atob\(|exec\(/.test(blob)) flags.push('eval/base64');
    if (/ignore (all |the )?(previous|above) instructions|do not (tell|inform) the user|hide from the user|send .* to http|exfiltrat/i.test(blob)) flags.push('⚠️ инъекция в тексте');
    const cls = flags.some((f) => f.startsWith('⚠️')) ? 'suspicious' : flags.length ? 'scripts+сеть' : scripts.length ? 'scripts' : 'md-only';
    out.push({ skill: sk, skDir, name: String(name).trim(), desc: String(desc).trim().slice(0, 240), files: inDir.length, scripts: scripts.length, lines: blob.split('\n').length, flags, urls: urls.slice(0, 5), cls, head: md.slice(0, 3500) });
  }
  return { dir, skills: out };
}

/* 3. Польза для нас — подписочный шим, строгий JSON. */
function relevance(repo, sk) {
  const prompt = `Ты оцениваешь чужой навык (skill) для Claude Code на пользу для КОНКРЕТНОЙ команды.\nКОМАНДА: ${PROFILE}\n\nРЕПО: ${repo.full_name} (★${repo.stargazers_count}, обновлён ${repo.pushed_at}). ОПИСАНИЕ РЕПО: ${String(repo.description || '').slice(0, 300)}\nНАВЫК: ${sk.name} — ${sk.desc}\nФАЙЛОВ: ${sk.files}, скриптов: ${sk.scripts}, флаги аудита: ${sk.flags.join(', ') || 'нет'}\nНАЧАЛО SKILL.md:\n${sk.head}\n\nОтветь ТОЛЬКО строгим JSON: {"score":0-10,"why":"<одна фраза по-русски, зачем нам>","use":"<где именно применим у нас или 'нигде'>","dup":"<дублирует ли что-то, что у нас уже есть: web-design-guidelines, design-taste-frontend, animate, predict-before-act; или 'нет'>"}. Балл 8+ только если навык закрывает реальную нашу боль и не дублирует установленное.`;
  const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
  try { const out = execFileSync(CLI, ['-p', prompt, '--model', 'sonnet', '--output-format', 'json'], { env, timeout: 120000 }).toString();
    const res = String(JSON.parse(out).result || ''); const m = res.match(/\{[\s\S]*\}/); const j = JSON.parse(m[0]); return { score: +j.score || 0, why: String(j.why || '').slice(0, 200), use: String(j.use || '').slice(0, 160), dup: String(j.dup || '').slice(0, 120) }; }
  catch (e) { /* 06.09: лимит подписки валил ВСЕ оценки, а репо помечались проверенными — теперь это отдельный признак */
    const err = String((e.stderr && e.stderr.toString()) || e.message || '').replace(/\s+/g, ' ').slice(0, 160);
    return { score: -1, why: 'оценка не удалась: ' + err, use: '', dup: '' }; }
}

/* 4. Заморозка кандидата в staging (копия + SOURCE.md). Не активирует. */
function stage(repo, sk, dir) {
  const dest = path.join(STAGING, sk.name.replace(/[^\w.-]/g, '_'));
  fs.rmSync(dest, { recursive: true, force: true }); fs.mkdirSync(dest, { recursive: true });
  execFileSync('cp', ['-r', path.join(dir, sk.skDir) + '/.', dest]);
  const commit = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
  fs.writeFileSync(path.join(dest, 'SOURCE.md'), `# Источник\n\nrepo: https://github.com/${repo.full_name}\npath: ${sk.skDir}\ncommit: ${commit}\nзаморожено: ${new Date().toISOString()}\nаудит: ${sk.cls}; флаги: ${sk.flags.join(', ') || 'нет'}; файлов ${sk.files}, скриптов ${sk.scripts}\n\nНЕ АКТИВЕН. Включить: mv в ~/.claude/skills/ (или в .claude/skills проекта) после ОК владельца.\n`);
  return dest;
}

const installedNames = () => new Set(INSTALLED.flatMap((d) => { try { return fs.readdirSync(d); } catch (_) { return []; } }));

(async () => {
  log('scout start', DRY ? '(dry)' : '');
  const repos = await discover();
  const fresh = repos.filter((r) => RESCAN || !state.seen[r.full_name]).sort((a, b) => b.stargazers_count - a.stargazers_count).slice(0, LIMIT);
  log('repos', repos.length, RESCAN ? 'к разбору (rescan)' : 'new', fresh.length, ALL ? '[полный проход]' : '');
  const have = installedNames(); const found = []; let failStreak = 0, aborted = false;
  for (const r of fresh) {
    const rec = { at: new Date().toISOString(), stars: r.stargazers_count };
    try {
      const a = audit(r.full_name, r.default_branch);
      rec.skills = a.skills.length;
      for (const sk of a.skills.slice(0, MAXSK)) {
        if (have.has(sk.name)) { sk.rel = { score: 0, why: 'уже установлен', use: '', dup: sk.name }; continue; }
        sk.rel = relevance(r, sk);
        if (sk.rel.score < 0) { failStreak++; rec.unrated = (rec.unrated || 0) + 1; log('оценка НЕ прошла', sk.name, sk.rel.why); if (failStreak >= 5) break; } else failStreak = 0;
        log('skill', r.full_name, sk.name, sk.cls, 'score', sk.rel.score, '—', sk.rel.why);
        if (sk.rel.score >= 7 && sk.cls !== 'suspicious') sk.staged = stage(r, sk, a.dir);
        found.push({ repo: r.full_name, stars: r.stargazers_count, ...sk, head: undefined });
      }
      fs.rmSync(a.dir, { recursive: true, force: true });
    } catch (e) { rec.err = e.message.slice(0, 120); log('audit fail', r.full_name, rec.err); }
    if (!rec.unrated) state.seen[r.full_name] = rec; else log('репо НЕ помечено проверенным (оценки не прошли):', r.full_name);
    saveState();
    if (failStreak >= 5) { log('ПРЕРВАНО: 5 неудачных оценок подряд — скорее всего исчерпан лимит подписки; репо остались непроверенными'); aborted = true; break; }
  }
  const top = found.filter((f) => f.rel.score >= 6).sort((a, b) => b.rel.score - a.rel.score);
  const line = (f, i) => `${i + 1}. *${f.name}* — ${f.rel.score}/10 · ${f.cls}${f.flags.length ? ' (' + f.flags.join(', ') + ')' : ''} · ★${f.stars}\n   ${f.rel.why}${f.rel.use ? ' → ' + f.rel.use : ''}${f.rel.dup && f.rel.dup !== 'нет' ? ' · дубль: ' + f.rel.dup : ''}\n   github.com/${f.repo}${f.staged ? ' · копия в staging' : ''}`;
  const text = top.length
    ? `🧭 Скиллы за неделю: проверено ${fresh.length} новых репо, навыков ${found.length}, стоящих ${top.length}:\n\n${top.map(line).join('\n\n')}\n\nВключить: скажи «поставь <название>»${top.some((t) => t.staged) ? ' — замороженная копия уже лежит в staging' : ' — заморожу копию и покажу'}; ничего не активировано.`
    : `🧭 Скиллы за неделю: проверено ${fresh.length} новых репо, навыков ${found.length} — ничего стоящего для нашего стека.`;
  const abortNote = aborted ? '\n\n⚠️ Прогон прерван: оценка перестала отвечать (лимит подписки). Непроверенные репо остались в очереди — повторю в следующий раз.' : '';
  state.runs.push({ at: new Date().toISOString(), repos: repos.length, fresh: fresh.length, found: found.length, top: top.map((t) => t.name) }); state.runs = state.runs.slice(-20); saveState();
  console.log(text);
  /* владелец 03.09: «проблемы и находки хочу видеть в программе, не в боте» → пуш приложения (notif → alerts → «Дела»/Система) */
  if (!DRY) {
    try {
      const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
      const db = new Database(path.join(ROOT, 'data', 'mail.db'));
      db.exec('CREATE TABLE IF NOT EXISTS notif (id TEXT PRIMARY KEY, title TEXT, body TEXT, at TEXT)');
      const title = top.length ? `🧭 Новые скиллы: ${top.length} стоящих из ${found.length}` : `🧭 Скиллы за неделю: ничего стоящего (${found.length} проверено)`;
      const bodyPre = abortNote;
      const body = top.length
        ? top.map((f, i) => `${i + 1}. ${f.name} — ${f.rel.score}/10 · ${f.rel.why}`).join('\n').slice(0, 900) + '\n\nСкажи «поставь <имя>» — активирую из ~/.claude/skills-staging.'
        : `Проверено ${fresh.length} новых репо, навыков ${found.length}. Ничего под наш стек.${bodyPre}`;
      db.prepare('INSERT OR REPLACE INTO notif(id,title,body,at) VALUES(?,?,?,?)')
        .run('skills-' + new Date().toISOString().slice(0, 10), title, body, new Date().toISOString());
      db.close();
      log('notif сохранён для приложения');
    } catch (e) { log('notif fail', e.message); }
    /* дубль в Telegram — только когда есть что ставить (пустые недели молчат) */
    if (top.length) { try { const { sendToOwner, escapeMd } = require(path.join(ROOT, 'shared', 'telegram')); await sendToOwner(escapeMd(text)); } catch (e) { log('notify fail', e.message); } }
  }
  log('scout done');
})().catch((e) => { log('FATAL', e.message); process.exit(1); });
