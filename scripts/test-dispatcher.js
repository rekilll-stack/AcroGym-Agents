'use strict';

/**
 * Self-check for the dispatcher task flow (owner-bot «Задача»).
 *
 *   node scripts/test-dispatcher.js          → static checks (fast, free)
 *   node scripts/test-dispatcher.js --live   → also runs ONE real headless task
 *
 * Static checks cover the wiring that silently breaks things: brief present and
 * frontmatter stripped, gates still spelled out in the brief, command + menu
 * button + i18n keys wired, text handler exported.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const ROOT  = path.join(__dirname, '..');
const BRIEF = path.join(process.env.HOME || '/home/admin', '.claude/agents/acrogym-dispatcher.md');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name}\n     ${err.message}`); }
}

console.log('Dispatcher self-check\n');

check('brief file exists', () => assert(fs.existsSync(BRIEF), `missing ${BRIEF}`));

const raw   = fs.existsSync(BRIEF) ? fs.readFileSync(BRIEF, 'utf8') : '';
const brief = raw.replace(/^---[\s\S]*?\n---\n/, '');

check('frontmatter is stripped for the CLI prompt', () => {
  assert(raw.startsWith('---'), 'brief has no frontmatter — agent definition would not register');
  assert(!brief.startsWith('---'), 'frontmatter survived the strip');
  assert(brief.length > 500, 'brief suspiciously short');
});

check('gates are still in the brief', () => {
  for (const gate of ['Деплой', 'Отправка наружу', 'Деньги', 'NURTURE_ENABLED=0', 'память']) {
    assert(brief.includes(gate), `gate/rule missing from brief: ${gate}`);
  }
});

check('memory-first rule precedes the work steps', () => {
  assert(brief.indexOf('Сначала память') < brief.indexOf('Разложи задачу'), 'memory-first must come first');
});

check('task command exports both steps', () => {
  const task = require(path.join(ROOT, 'agents/owner-bot/commands/task'));
  assert.strictEqual(typeof task, 'function', 'default export must be the /task handler');
  assert.strictEqual(typeof task.handleTaskText, 'function', 'handleTaskText missing');
});

check('owner-bot registers /task and the text handler', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'agents/owner-bot/index.js'), 'utf8');
  assert(idx.includes("registerOwnerCommand('/task'"), '/task not registered');
  assert(idx.includes("registerOwnerTextHandler('task'"), "text handler for action 'task' not registered");
  assert(idx.includes('registerOwnerTextHandler,'), 'registerOwnerTextHandler not imported');
});

check('menu button wired end-to-end', () => {
  const menu = fs.readFileSync(path.join(ROOT, 'agents/owner-bot/commands/menu.js'), 'utf8');
  const cbs  = fs.readFileSync(path.join(ROOT, 'agents/owner-bot/callbacks/menu-callbacks.js'), 'utf8');
  assert(menu.includes("callback_data: 'menu:task'"), 'menu button missing');
  assert(cbs.includes("case 'task'"), 'menu:task not routed');
});

check('i18n keys exist in both languages', () => {
  const { t } = require(path.join(ROOT, 'shared/i18n'));
  for (const lang of ['ru', 'en']) {
    const v = t('menu.btn_task', lang);
    assert(v && !v.includes('menu.btn_task'), `menu.btn_task missing for ${lang}`);
  }
});

if (process.argv.includes('--live')) {
  const { runCli } = require(path.join(ROOT, 'agents/content-bot/agent'));
  console.log('\n  ⏳ live run (one small read-only task, ~1-2 min)…');
  const prompt = `${brief}\n\n---\n\nЗадача от владельца: назови ровно три pm2-процесса нашего парка и одной строкой скажи, что делает owner-bot. Ничего не меняй.`;
  runCli(prompt, { model: process.env.DISPATCHER_MODEL || 'opus', maxTurns: 20, timeoutMs: 600000 }).then((run) => {
    check('live dispatcher run succeeds', () => {
      assert(run.ok, `run failed: ${run.error}`);
      assert(String(run.result || '').trim().length > 20, 'empty answer');
      assert(/owner-bot/i.test(run.result), 'answer does not mention owner-bot — brief may not be reaching the model');
    });
    console.log(`\n  cost $${(run.costUsd || 0).toFixed(4)}, turns ${run.turns}`);
    console.log(`  answer: ${String(run.result || '').slice(0, 400)}\n`);
    done();
  });
} else {
  done();
}

function done() {
  console.log(failed ? `\n${failed} check(s) FAILED\n` : '\nAll checks passed ✅\n');
  process.exit(failed ? 1 : 0);
}
