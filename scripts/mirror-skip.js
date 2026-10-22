#!/usr/bin/env node
'use strict';
/* 13.10 владелец: «повреждённые не копируй» + «следи, как будут доступны — копируй тоже».
   Источник правды — data/mirror-skip-paths.txt (путь от корня Я.Диска; папка — с «/» на конце).
   Из него собирается фильтр rclone data/mirror-skip.txt (--exclude-from; спецсимволы экранированы, папка → /путь/**).
   node scripts/mirror-skip.js [--all]            — дописать отказы из лога последнего запуска (или всего лога)
   node scripts/mirror-skip.js --drop <файл>     — убрать из списка пути, перечисленные в файле (вернулись), и пересобрать фильтр */
const fs = require('fs');
process.chdir('/home/admin/acrogym');
const LOG = 'logs/mirror-yadisk.log', PATHS = 'data/mirror-skip-paths.txt', FILTER = 'data/mirror-skip.txt';
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
const esc = (p) => '/' + p.replace(/[\\*?[\]{}]/g, (c) => '\\' + c);
const list = new Set(read(PATHS));
const i = process.argv.indexOf('--drop');
if (i > 0) { for (const p of read(process.argv[i + 1])) list.delete(p); }
else {
  const log = fs.readFileSync(LOG, 'utf8'), part = process.argv.includes('--all') ? log : log.split(/\n(?=\d{4}-\d\d-\d\d \d\d:\d\d:\d\d старт)/).pop();
  for (const m of part.matchAll(/ERROR : (.+?): Failed to copy: failed to open source object/g)) list.add(m[1]);
  for (const m of part.matchAll(/ERROR : (.+?): error reading source directory/g)) list.add(m[1] + '/');
}
fs.writeFileSync(PATHS, [...list].join('\n') + (list.size ? '\n' : ''));
fs.writeFileSync(FILTER, [...list].map((p) => (p.endsWith('/') ? esc(p.slice(0, -1)) + '/**' : esc(p))).join('\n') + (list.size ? '\n' : ''));
console.log(new Date().toISOString().slice(0, 16) + ' список повреждённых: ' + list.size);
