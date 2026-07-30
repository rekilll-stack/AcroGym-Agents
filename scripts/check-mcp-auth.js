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
    .filter((l) => /claude\.ai/i.test(l));
  if (err && !out.trim()) bad.push(`claude mcp list failed: ${err.message}`);
  if (!bad.length) { console.log(new Date().toISOString(), 'mcp auth ok'); return; }

  const lines = bad.map((l) => l.replace(/ - .*$/, '')).join(', ');
  const TEXTS = {
    ru: `⚠️ Протухла авторизация коннектора: ${lines}\n\nАвтопосты не соберутся, пока не переподключишь: в Claude-сессии набери /mcp → выбери коннектор → авторизуйся.`,
    en: `⚠️ Connector authentication expired: ${lines}\n\nAuto-posts will fail until you reconnect: in the Claude session type /mcp → pick the connector → authorize.`,
  };

  if (process.env.MCP_PROBE_DRY === '1') { console.log('[DRY]', JSON.stringify(TEXTS.ru)); return; }

  const { sendToOwner, ownerLangRecipients, escapeMd } = require('../shared/telegram');
  for (const [lang, chatIds] of Object.entries(ownerLangRecipients())) {
    if (!chatIds.length) continue;
    await sendToOwner(escapeMd(TEXTS[lang]), { chatIds }).catch((e) => console.error('alert send failed:', e.message));
  }
  console.log(new Date().toISOString(), 'mcp auth ALERT sent:', lines);
});
