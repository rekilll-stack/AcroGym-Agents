#!/usr/bin/env node
'use strict';

/**
 * Утренний probe здоровья claude.ai MCP-коннекторов (Canva/Metricool и др.).
 * Токены коннекторов живут на стороне Anthropic и протухают без предупреждения
 * (30.07: Canva "Needs authentication" → weekly-recap не собрался, $0.09 в трубу).
 * Предотвратить нельзя — ловим рано: cron 07:30, ДО дневных сборок (08:00).
 * `claude mcp list` бесплатен (health-check, без LLM-токенов).
 * MCP_PROBE_DRY=1 — напечатать вместо отправки.
 */

const { execFile } = require('child_process');
const path = require('path');

const CLI = process.env.CLAUDE_CLI || path.join(process.env.HOME || '/home/admin', '.npm-global/bin/claude');

execFile(CLI, ['mcp', 'list'], { timeout: 120000, maxBuffer: 1024 * 1024 }, async (err, stdout = '', stderr = '') => {
  const out = `${stdout}\n${stderr}`;
  const bad = out.split('\n')
    .filter((l) => /needs authentication|failed to connect/i.test(l))
    .map((l) => l.trim())
    // локальные MCP чинятся кодом, алертим только про claude.ai коннекторы
    .filter((l) => /claude\.ai/i.test(l))
    // AcroGym — наш собственный мост: кастом-коннектор claude.ai сломан багом
    // Anthropic (claude-ai-mcp#690), реальные клиенты ходят через mcp-remote
    // с токеном. «Протухшая авторизация» тут вечная и ни на что не влияет.
    .filter((l) => !/acrogym/i.test(l));
  if (err && !out.trim()) bad.push(`claude mcp list failed: ${err.message}`);
  if (!bad.length) { console.log(new Date().toISOString(), 'mcp auth ok'); return; }

  const lines = bad.map((l) => l.replace(/ - .*$/, '')).join(', ');
  // Только Canva/Metricool стоят на пути автопостов. Про остальные коннекторы
  // (Drive/Gmail/Calendar) нельзя писать «автопосты не соберутся» — 15.08 такой
  // алерт про Drive поднял ложную тревогу, автопостинг был полностью жив.
  const hitsPosting = /canva|metricool/i.test(lines);
  const IMPACT = {
    ru: hitsPosting ? 'Автопосты не соберутся, пока не переподключишь.' : 'Автопостинг не затронут — сломается только то, что ходит в этот сервис.',
    en: hitsPosting ? 'Auto-posts will fail until you reconnect.' : 'Auto-posting is unaffected — only features using this service will break.',
  };
  const TEXTS = {
    ru: `⚠️ Протухла авторизация коннектора: ${lines}\n\n${IMPACT.ru}\nПочинить: в Claude-сессии набери /mcp → выбери коннектор → авторизуйся.`,
    en: `⚠️ Connector authentication expired: ${lines}\n\n${IMPACT.en}\nFix: in the Claude session type /mcp → pick the connector → authorize.`,
  };

  if (process.env.MCP_PROBE_DRY === '1') { console.log('[DRY]', JSON.stringify(TEXTS.ru)); return; }

  const { sendToOwner, ownerLangRecipients, escapeMd } = require('../shared/telegram');
  for (const [lang, chatIds] of Object.entries(ownerLangRecipients())) {
    if (!chatIds.length) continue;
    await sendToOwner(escapeMd(TEXTS[lang]), { chatIds }).catch((e) => console.error('alert send failed:', e.message));
  }
  console.log(new Date().toISOString(), 'mcp auth ALERT sent:', lines);
});
