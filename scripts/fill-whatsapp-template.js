#!/usr/bin/env node
'use strict';

/**
 * Fills a WhatsApp template (config/whatsapp-templates.json) with a real
 * registration's data, for the admin to copy-paste into WhatsApp/Chatwoot.
 *
 * READ-ONLY. Does not send anything, does not write to the DB or the sheet —
 * the actual Cloud API send path stays a throw-stub until Meta approval +
 * Activation Day (see [[project_broadcast_track]]). This just saves the admin
 * from retyping {{1}}/{{2}} by hand.
 *
 * Usage:
 *   node scripts/fill-whatsapp-template.js <template_key> --phone <phone> [--child <n>] [--var name=value ...]
 *   node scripts/fill-whatsapp-template.js --list                          # list all template keys
 *   node scripts/fill-whatsapp-template.js <template_key> --show           # show the template only, no lookup
 *
 * Auto-filled from the registrations table when a variable's description
 * mentions "parent" or "child": parent name, child's first name. Everything
 * else (date, time, item, reason, class name, ...) must be passed via --var.
 */

const path = require('path');
const { getDb } = require('../shared/db');
const { normalizePhone } = require('../shared/normalize');

const TEMPLATES_PATH = path.join(__dirname, '..', 'config', 'whatsapp-templates.json');
const { templates } = require(TEMPLATES_PATH);

function findTemplate(key) {
  return templates.find((t) => t.key === key);
}

function findRegistrationByPhone(rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) return null;
  return getDb()
    .prepare('SELECT * FROM registrations WHERE whatsapp_norm = ? OR mobile_norm = ? ORDER BY submitted_at DESC LIMIT 1')
    .get(phone, phone);
}

function pickChild(reg, childIndex) {
  if (!reg || !reg.children_json) return null;
  let children;
  try { children = JSON.parse(reg.children_json).children || []; } catch { return null; }
  if (!children.length) return null;
  const idx = childIndex != null ? childIndex - 1 : 0;
  return children[idx] || children[0];
}

// Guess which real-world value a {{n}} variable means from its own metadata
// description (e.g. "{{1}} parent name" / "{{2}} child's name"), then fill it
// from the registration record. Returns null if it can't be auto-filled.
function autoFillValue(varDescription, reg, childIndex) {
  const d = varDescription.toLowerCase();
  if (!reg) return null;
  if (d.includes('parent')) {
    return [reg.parent_first, reg.parent_last].filter(Boolean).join(' ') || null;
  }
  if (d.includes('child')) {
    const child = pickChild(reg, childIndex);
    return child && child.first_name ? child.first_name : null;
  }
  return null;
}

function parseArgs(argv) {
  const out = { _: [], vars: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--phone') { out.phone = argv[++i]; }
    else if (a === '--child') { out.child = parseInt(argv[++i], 10); }
    else if (a === '--var') {
      const kv = argv[++i] || '';
      const eq = kv.indexOf('=');
      if (eq > 0) out.vars[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    else if (a === '--list') { out.list = true; }
    else if (a === '--show') { out.show = true; }
    else out._.push(a);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    for (const t of templates) console.log(`${t.key}  —  ${t.name}  [${t.category}]`);
    console.log(`\n${templates.length} templates total.`);
    return;
  }

  const key = args._[0];
  if (!key) {
    console.error('Usage: node scripts/fill-whatsapp-template.js <template_key> --phone <phone> [--child N] [--var name=value ...]');
    console.error('       node scripts/fill-whatsapp-template.js --list');
    process.exit(1);
  }

  const tpl = findTemplate(key);
  if (!tpl) {
    console.error(`Unknown template key "${key}". Run --list to see all keys.`);
    process.exit(1);
  }

  if (args.show) {
    console.log(`${tpl.name}  [${tpl.category}] — ${tpl.meta_category}`);
    console.log(tpl.body);
    if (tpl.footer) console.log(`(footer: ${tpl.footer})`);
    console.log('Variables:', tpl.variables.join(' | ') || '(none)');
    return;
  }

  const reg = args.phone ? findRegistrationByPhone(args.phone) : null;
  if (args.phone && !reg) {
    console.warn(`No registration found for ${args.phone} — filling only from --var, rest stays as {{n}}.`);
  }

  let text = tpl.body;
  const unresolved = [];
  const placeholders = [...new Set((text.match(/\{\{\d+\}\}/g) || []))];

  for (const ph of placeholders) {
    const n = ph.replace(/\D/g, '');
    // Prefer an explicit --var override (keyed by number, e.g. --var 1=Sarah),
    // then auto-fill from the registration, then leave unresolved.
    let value = args.vars[n];
    if (value == null) {
      const desc = (tpl.variables.find((v) => v.startsWith(ph)) || '');
      value = autoFillValue(desc, reg, args.child);
    }
    if (value != null) {
      text = text.split(ph).join(value);
    } else {
      unresolved.push(ph);
    }
  }

  console.log(`--- ${tpl.name} (${tpl.meta_category}) ---`);
  console.log(text);
  if (tpl.footer) console.log(`\n${tpl.footer}`);
  if (unresolved.length) {
    console.log(`\n⚠️  Still needs: ${unresolved.map((ph) => {
      const desc = tpl.variables.find((v) => v.startsWith(ph));
      return desc || ph;
    }).join(', ')} — pass with --var ${unresolved[0].replace(/\D/g, '')}=...`);
  }
}

main();
