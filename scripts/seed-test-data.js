'use strict';

/**
 * scripts/seed-test-data.js
 *
 * Seeds ~38 realistic test leads for May 2026 into the DB.
 * All test leads are marked with phone_normalized starting '+97455500'
 * so they can be found and cleaned up safely.
 *
 * Usage:
 *   node scripts/seed-test-data.js           — insert test leads
 *   node scripts/seed-test-data.js --cleanup  — remove all SEED test leads
 *   node scripts/seed-test-data.js --status   — show current counts
 */

const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH    = path.join(__dirname, '../data/acrogym.db');
const SEED_PREFIX = '+97455500'; // phone_normalized marker for seed data

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─────────────────────────────────────────────────────────────
// Test lead definitions
// source: Instagram=22, Website=9, Referral=5, Other=2  → total 38
// status: responded=31, notified=7
// created_at: spread across 2026-05-01 to 2026-05-27
// ─────────────────────────────────────────────────────────────

const LEADS = [
  // Instagram — 22 leads
  { name: 'Maryam Al-Thani',      phone: '+97455500001', source: 'Instagram', day: '2026-05-01', hour:  9, status: 'responded', resp_h: 1  },
  { name: 'Noura Al-Kuwari',      phone: '+97455500002', source: 'Instagram', day: '2026-05-01', hour: 14, status: 'responded', resp_h: 2  },
  { name: 'Fatima Al-Mannai',     phone: '+97455500003', source: 'Instagram', day: '2026-05-02', hour: 11, status: 'responded', resp_h: 3  },
  { name: 'Aisha Al-Khalifa',     phone: '+97455500004', source: 'Instagram', day: '2026-05-03', hour: 10, status: 'notified',  resp_h: null },
  { name: 'Hessa Al-Muftah',      phone: '+97455500005', source: 'Instagram', day: '2026-05-04', hour: 16, status: 'responded', resp_h: 1  },
  { name: 'Latifa Al-Marri',      phone: '+97455500006', source: 'Instagram', day: '2026-05-05', hour:  9, status: 'responded', resp_h: 4  },
  { name: 'Shaikha Al-Attiyah',   phone: '+97455500007', source: 'Instagram', day: '2026-05-06', hour: 13, status: 'responded', resp_h: 2  },
  { name: 'Reem Al-Sulaiti',      phone: '+97455500008', source: 'Instagram', day: '2026-05-07', hour: 10, status: 'notified',  resp_h: null },
  { name: 'Dana Al-Hajri',        phone: '+97455500009', source: 'Instagram', day: '2026-05-08', hour: 15, status: 'responded', resp_h: 5  },
  { name: 'Salwa Al-Qahtani',     phone: '+97455500010', source: 'Instagram', day: '2026-05-09', hour: 11, status: 'responded', resp_h: 1  },
  { name: 'Nadia Al-Dosari',      phone: '+97455500011', source: 'Instagram', day: '2026-05-10', hour: 12, status: 'responded', resp_h: 2  },
  { name: 'Manal Al-Emadi',       phone: '+97455500012', source: 'Instagram', day: '2026-05-12', hour:  9, status: 'responded', resp_h: 3  },
  { name: 'Basma Al-Jaber',       phone: '+97455500013', source: 'Instagram', day: '2026-05-13', hour: 17, status: 'notified',  resp_h: null },
  { name: 'Wafa Al-Naimi',        phone: '+97455500014', source: 'Instagram', day: '2026-05-14', hour: 10, status: 'responded', resp_h: 1  },
  { name: 'Iman Al-Ansari',       phone: '+97455500015', source: 'Instagram', day: '2026-05-15', hour: 14, status: 'responded', resp_h: 4  },
  { name: 'Rima Al-Saad',         phone: '+97455500016', source: 'Instagram', day: '2026-05-17', hour: 11, status: 'responded', resp_h: 2  },
  { name: 'Hana Al-Buainain',     phone: '+97455500017', source: 'Instagram', day: '2026-05-18', hour: 16, status: 'responded', resp_h: 5  },
  { name: 'Moza Al-Misnad',       phone: '+97455500018', source: 'Instagram', day: '2026-05-19', hour:  9, status: 'responded', resp_h: 1  },
  { name: 'Jawaher Al-Rumaihi',   phone: '+97455500019', source: 'Instagram', day: '2026-05-21', hour: 13, status: 'responded', resp_h: 3  },
  { name: 'Dalal Al-Fardan',      phone: '+97455500020', source: 'Instagram', day: '2026-05-22', hour: 10, status: 'responded', resp_h: 2  },
  { name: 'Sheikha Al-Khayyarin', phone: '+97455500021', source: 'Instagram', day: '2026-05-24', hour: 15, status: 'responded', resp_h: 4  },
  { name: 'Amna Al-Mohannadi',    phone: '+97455500022', source: 'Instagram', day: '2026-05-26', hour: 11, status: 'responded', resp_h: 1  },

  // Website — 9 leads
  { name: 'Ahmed Hassan',         phone: '+97455500023', source: 'Website',   day: '2026-05-01', hour: 10, status: 'responded', resp_h: 2  },
  { name: 'Omar Al-Abdullah',     phone: '+97455500024', source: 'Website',   day: '2026-05-04', hour: 14, status: 'responded', resp_h: 1  },
  { name: 'Khalid Al-Rashid',     phone: '+97455500025', source: 'Website',   day: '2026-05-07', hour: 11, status: 'notified',  resp_h: null },
  { name: 'Sara Johnson',         phone: '+97455500026', source: 'Website',   day: '2026-05-10', hour:  9, status: 'responded', resp_h: 3  },
  { name: 'Mohammed Al-Sayed',    phone: '+97455500027', source: 'Website',   day: '2026-05-13', hour: 16, status: 'responded', resp_h: 5  },
  { name: 'Priya Sharma',         phone: '+97455500028', source: 'Website',   day: '2026-05-16', hour: 12, status: 'responded', resp_h: 2  },
  { name: 'Elena Petrova',        phone: '+97455500029', source: 'Website',   day: '2026-05-19', hour: 10, status: 'responded', resp_h: 1  },
  { name: 'Yusuf Al-Tamimi',      phone: '+97455500030', source: 'Website',   day: '2026-05-22', hour: 14, status: 'notified',  resp_h: null },
  { name: 'Layla Mahmoud',        phone: '+97455500031', source: 'Website',   day: '2026-05-25', hour: 11, status: 'responded', resp_h: 4  },

  // Referral — 5 leads
  { name: 'Noor Al-Zaabi',        phone: '+97455500032', source: 'Referral',  day: '2026-05-03', hour: 13, status: 'responded', resp_h: 1  },
  { name: 'Tariq Al-Shamari',     phone: '+97455500033', source: 'Referral',  day: '2026-05-09', hour: 10, status: 'responded', resp_h: 2  },
  { name: 'Hind Al-Kubaisi',      phone: '+97455500034', source: 'Referral',  day: '2026-05-15', hour: 15, status: 'responded', resp_h: 3  },
  { name: 'Faisal Al-Baker',      phone: '+97455500035', source: 'Referral',  day: '2026-05-20', hour: 11, status: 'notified',  resp_h: null },
  { name: 'Maha Al-Obaidly',      phone: '+97455500036', source: 'Referral',  day: '2026-05-25', hour: 14, status: 'responded', resp_h: 5  },

  // Other — 2 leads
  { name: 'James Mitchell',       phone: '+97455500037', source: 'Other',     day: '2026-05-11', hour: 10, status: 'notified',  resp_h: null },
  { name: 'Amir Al-Harbi',        phone: '+97455500038', source: 'Other',     day: '2026-05-23', hour: 13, status: 'responded', resp_h: 2  },
];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function toTimestamp(day, hour, minuteOffset = 0) {
  // day = 'YYYY-MM-DD', stored as UTC
  // Qatar is UTC+3, so hour 10 Qatar = 07:00 UTC
  const utcHour = Math.max(0, hour - 3);
  const hh = String(utcHour).padStart(2, '0');
  const mm = String(minuteOffset).padStart(2, '0');
  return `${day} ${hh}:${mm}:00`;
}

function respondedAt(day, hour, resp_h) {
  if (!resp_h) return null;
  const totalMin = (hour + resp_h) * 60;
  const newHour  = Math.floor(totalMin / 60);
  const newMin   = totalMin % 60;
  const utcHour  = Math.max(0, newHour - 3);
  const hh = String(utcHour).padStart(2, '0');
  const mm = String(newMin).padStart(2, '0');
  return `${day} ${hh}:${mm}:00`;
}

// notified_at = ~30 min after created_at (bot sends message quickly)
function notifiedAt(day, hour) {
  const totalMin = hour * 60 + 30;
  const nh       = Math.floor(totalMin / 60);
  const nm       = totalMin % 60;
  const utcHour  = Math.max(0, nh - 3);
  const hh = String(utcHour).padStart(2, '0');
  const mm = String(nm).padStart(2, '0');
  return `${day} ${hh}:${mm}:00`;
}

// ─────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────

function doStatus() {
  const total    = db.prepare("SELECT COUNT(*) as n FROM leads").get().n;
  const seed     = db.prepare("SELECT COUNT(*) as n FROM leads WHERE phone_normalized LIKE ?").get(SEED_PREFIX + '%').n;
  const nonLeg   = db.prepare("SELECT COUNT(*) as n FROM leads WHERE client_type != 'legacy'").get().n;
  const legacy   = db.prepare("SELECT COUNT(*) as n FROM leads WHERE client_type = 'legacy'").get().n;
  const responded = db.prepare("SELECT COUNT(*) as n FROM leads WHERE phone_normalized LIKE ? AND status = 'responded'").get(SEED_PREFIX + '%').n;
  const notified  = db.prepare("SELECT COUNT(*) as n FROM leads WHERE phone_normalized LIKE ? AND status = 'notified'").get(SEED_PREFIX + '%').n;
  const srcBreak  = db.prepare("SELECT source, COUNT(*) as n FROM leads WHERE phone_normalized LIKE ? GROUP BY source ORDER BY n DESC").all(SEED_PREFIX + '%');

  console.log('\n── DB Status ───────────────────────────────');
  console.log(`  Total leads:        ${total}`);
  console.log(`  Legacy leads:       ${legacy}`);
  console.log(`  Non-legacy leads:   ${nonLeg}`);
  console.log(`  Seed leads:         ${seed}`);
  console.log(`    ↳ responded:      ${responded}`);
  console.log(`    ↳ notified:       ${notified}`);
  console.log(`  Source breakdown:`);
  srcBreak.forEach(r => console.log(`    ${(r.source || 'null').padEnd(12)} ${r.n}`));
  console.log('────────────────────────────────────────────\n');
}

function doCleanup() {
  const before = db.prepare("SELECT COUNT(*) as n FROM leads WHERE phone_normalized LIKE ?").get(SEED_PREFIX + '%').n;
  if (before === 0) {
    console.log('No seed leads found — nothing to clean up.');
    return;
  }
  db.prepare("DELETE FROM leads WHERE phone_normalized LIKE ?").run(SEED_PREFIX + '%');
  console.log(`✅ Removed ${before} seed leads (phone_normalized LIKE '${SEED_PREFIX}%').`);
}

function doSeed() {
  const insertStmt = db.prepare(`
    INSERT INTO leads (
      parent_name, parent_phone, phone_normalized,
      source, client_type, language, status,
      created_at, updated_at, notified_at, responded_at
    ) VALUES (
      @parent_name, @parent_phone, @phone_normalized,
      @source, 'new', 'en', @status,
      @created_at, @created_at, @notified_at, @responded_at
    )
  `);

  const checkStmt = db.prepare(
    "SELECT id FROM leads WHERE phone_normalized = ?"
  );

  let inserted = 0;
  let skipped  = 0;

  const seedAll = db.transaction(() => {
    for (const l of LEADS) {
      const existing = checkStmt.get(l.phone);
      if (existing) { skipped++; continue; }

      insertStmt.run({
        parent_name:      l.name,
        parent_phone:     l.phone,
        phone_normalized: l.phone,
        source:           l.source,
        status:           l.status,
        created_at:       toTimestamp(l.day, l.hour),
        notified_at:      notifiedAt(l.day, l.hour),
        responded_at:     respondedAt(l.day, l.hour, l.resp_h),
      });
      inserted++;
    }
  });

  seedAll();

  console.log(`\n✅ Seed complete: ${inserted} inserted, ${skipped} skipped (already existed).`);
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

const arg = process.argv[2];

if (arg === '--cleanup') {
  doCleanup();
  doStatus();
} else if (arg === '--status') {
  doStatus();
} else {
  doSeed();
  doStatus();
}
