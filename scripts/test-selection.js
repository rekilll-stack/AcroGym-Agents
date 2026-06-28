'use strict';
// Dev harness: run catalog-based selection for several topics, crop each pick
// full-bleed, and save them so we can eyeball quality. Not used in production.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const photos = require('../agents/content-bot/photos');
const { safeCrop45 } = require('../agents/content-bot/crop');

const TOPICS = process.argv[2] ? [process.argv[2]] : [
  ['gym-open', 'Our new gym at Lagoona Mall is open — equipment installed, see you in September'],
  ['coach', 'Meet our professional coaches at AcroGym'],
  ['trial', 'Book your first free trial class at AcroGym'],
];
const N = Number(process.argv[3] || 3);
const OUT = '/tmp/claude-1000/-home-admin/a3a49594-2131-486a-9c16-0a30f6f138c8/scratchpad/seltest/';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [slug, topic] of TOPICS) {
    const sel = await photos.selectBest(N, { topic });
    console.log(`\n=== ${slug} ===`);
    console.log('picks:', sel.photos.map((p) => p.path.split('/').slice(-2).join('/')).join(' | '));
    let i = 0;
    for (const p of sel.photos) {
      const out = await safeCrop45(p.buffer);
      fs.writeFileSync(`${OUT}${slug}_${++i}_${p.name.replace(/\.[^.]+$/, '')}.jpg`, out);
    }
  }
  console.log('\nsaved to', OUT);
})().catch((e) => { console.error('ERR', e.stack); process.exit(1); });
