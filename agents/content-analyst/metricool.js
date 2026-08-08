'use strict';
// Источник данных аналитика №2: Metricool (headless claude + metricool-mcp).
// Появился 08.08.2026: миграция на новый FB-аккаунт убила старый Meta-токен,
// а Metricool переподключён владельцем и сам ходит в Instagram.
// Формат результата 1-в-1 с graph.js — analyze.js разницы не видит.
// ponytail: источник = LLM-агент с MCP-тулзами, а не прямой REST (у Metricool
// прямой API платный; апгрейд-путь — новый Meta-токен в сентябре, см. memory #107).

const { runCli } = require('../content-bot/agent');

const BRAND_ID = process.env.METRICOOL_BRAND_ID || '';

function isConfigured() { return !!BRAND_ID; }

function parseJson(text) {
  try { const m = String(text).match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

/** Последние N постов в формате analyze.js (см. graph.fetchPosts). */
async function fetchPosts({ limit = 12 } = {}) {
  const prompt = [
    `Use metricool-mcp MCP tools to fetch Instagram stats for Metricool brand id ${BRAND_ID} (AcroGym Qatar).`,
    `Fetch the published posts AND reels of the last 60 days (up to ${limit} newest items total).`,
    'Discover exact tools/metric ids yourself (getAnalyticsAvailableMetrics for connectors "posts" and "reels" of getAnalyticsDataByMetrics, or equivalent list tools).',
    'Return ONLY a JSON object, no prose, exactly this shape:',
    '{"posts":[{"date":"<ISO date>","type":"REELS|IMAGE|CAROUSEL_ALBUM","reach":0,"interactions":0,"saved":0,"likes":0,"shares":0,"caption":"<first 200 chars>","url":"<permalink or empty>"}]}',
    'Rules: numbers default to 0 when a metric is unavailable; sort newest first; never invent posts absent from Metricool data; fewer posts than requested is fine.',
  ].join('\n');
  const run = await runCli(prompt, { maxTurns: 15 });
  if (!run.ok) throw new Error(`metricool agent: ${run.error || 'failed'}`);
  const parsed = parseJson(run.result);
  if (!parsed || !Array.isArray(parsed.posts)) throw new Error('metricool agent: bad JSON');
  return parsed.posts;
}

module.exports = { fetchPosts, isConfigured };
