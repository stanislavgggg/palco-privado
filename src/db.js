const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      src TEXT,
      variant TEXT,
      created_at INTEGER,
      streak INTEGER DEFAULT 0,
      best_streak INTEGER DEFAULT 0,
      score_user INTEGER DEFAULT 0,
      score_ai INTEGER DEFAULT 0,
      graded_count INTEGER DEFAULT 0,
      wa_state TEXT,
      wa_asks INTEGER DEFAULT 0,
      wa_phone TEXT,
      wa_phone_source TEXT,
      wa_es_mobile INTEGER,
      wa_saved_at INTEGER,
      consent_at INTEGER,
      consent_version TEXT,
      optout_at INTEGER,
      pm_allowed INTEGER DEFAULT 1,
      entry TEXT DEFAULT 'bot',
      blocked INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS picks (
      user_id INTEGER NOT NULL,
      match_id TEXT NOT NULL,
      pick TEXT NOT NULL,
      ai_pick TEXT,
      home TEXT,
      away TEXT,
      competition TEXT,
      starts_at INTEGER,
      result_score TEXT,
      result_outcome TEXT,
      created_at INTEGER NOT NULL,
      graded INTEGER DEFAULT 0,
      correct INTEGER,
      ai_correct INTEGER,
      PRIMARY KEY (user_id, match_id)
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      run_at INTEGER NOT NULL,
      payload TEXT,
      attempts INTEGER DEFAULT 0,
      done INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS jobs_due ON jobs(done, run_at);
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_once ON jobs(user_id, kind, payload);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      type TEXT NOT NULL,
      meta TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_type ON events(type);
  `);

  const now = () => Date.now();

  const api = {
    raw: db,
    getUser: (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id),

    upsertUser({ id, username, first_name, src, variant, entry = 'bot', pm_allowed = 1 }) {
      const existing = api.getUser(id);
      if (existing) {
        db.prepare('UPDATE users SET username = ?, first_name = ?, blocked = 0 WHERE id = ?')
          .run(username || null, first_name || null, id);
        return { user: api.getUser(id), isNew: false };
      }
      db.prepare('INSERT INTO users (id, username, first_name, src, variant, created_at, entry, pm_allowed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, username || null, first_name || null, src || 'organic', variant, now(), entry, pm_allowed ? 1 : 0);
      return { user: api.getUser(id), isNew: true };
    },

    setUser(id, fields) {
      const keys = Object.keys(fields);
      if (!keys.length) return;
      db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => fields[k]), id);
    },

    getPick: (u, m) => db.prepare('SELECT * FROM picks WHERE user_id = ? AND match_id = ?').get(u, String(m)),
    addPick({ userId, matchId, pick, aiPick, match = {} }) {
      return db.prepare(`INSERT OR IGNORE INTO picks (user_id, match_id, pick, ai_pick, home, away, competition, starts_at, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(userId, String(matchId), pick, aiPick, match.home || null, match.away || null,
          match.competition || null, match.startsAt || null, now()).changes === 1;
    },
    recentPicks: (u, limit = 20) =>
      db.prepare('SELECT * FROM picks WHERE user_id = ? ORDER BY COALESCE(starts_at, created_at) DESC LIMIT ?').all(u, limit),
    pickedIds: (u) => db.prepare('SELECT match_id FROM picks WHERE user_id = ?').all(u).map((r) => r.match_id),
    pickCount: (u) => db.prepare('SELECT COUNT(*) c FROM picks WHERE user_id = ?').get(u).c,
    gradePick(u, m, correct, aiCorrect, result = {}) {
      db.prepare('UPDATE picks SET graded = 1, correct = ?, ai_correct = ?, result_score = ?, result_outcome = ? WHERE user_id = ? AND match_id = ?')
        .run(Number(correct), Number(aiCorrect), result.score || null, result.outcome || null, u, String(m));
    },

    weeklyTop(sinceMs, limit = 10) {
      return db.prepare(`
        SELECT u.id, u.first_name, u.username, SUM(p.correct = 1) AS wins, COUNT(*) AS graded, MIN(p.created_at) AS first_at
        FROM picks p JOIN users u ON u.id = p.user_id
        WHERE p.graded = 1 AND p.created_at >= ?
        GROUP BY u.id HAVING wins > 0
        ORDER BY wins DESC, graded ASC, first_at ASC LIMIT ?`).all(sinceMs, limit);
    },
    weeklyRank(userId, sinceMs) {
      const rows = api.weeklyTop(sinceMs, 100000);
      const i = rows.findIndex((r) => r.id === userId);
      return i === -1 ? null : { rank: i + 1, of: rows.length, wins: rows[i].wins };
    },

    logEvent(userId, type, meta) {
      db.prepare('INSERT INTO events (user_id, type, meta, created_at) VALUES (?, ?, ?, ?)')
        .run(userId || null, type, meta ? JSON.stringify(meta) : null, now());
    },
    schedule(userId, kind, runAt, payload = '') {
      db.prepare('INSERT OR IGNORE INTO jobs (user_id, kind, run_at, payload) VALUES (?, ?, ?, ?)')
        .run(userId, kind, runAt, String(payload));
    },
    dueJobs: (limit = 200) =>
      db.prepare('SELECT * FROM jobs WHERE done = 0 AND run_at <= ? ORDER BY run_at LIMIT ?').all(now(), limit),
    finishJob: (id) => db.prepare('UPDATE jobs SET done = 1 WHERE id = ?').run(id),
    retryJob: (id, runAt) => db.prepare('UPDATE jobs SET run_at = ?, attempts = attempts + 1 WHERE id = ?').run(runAt, id),
    cancelJobs(userId, kinds) {
      const q = kinds
        ? `UPDATE jobs SET done = 1 WHERE user_id = ? AND done = 0 AND kind IN (${kinds.map(() => '?').join(',')})`
        : 'UPDATE jobs SET done = 1 WHERE user_id = ? AND done = 0';
      db.prepare(q).run(userId, ...(kinds || []));
    },

    stats() {
      return db.prepare(`
        SELECT u.src, u.variant,
          COUNT(*) AS starts,
          SUM((SELECT COUNT(*) FROM picks p WHERE p.user_id = u.id) > 0) AS pickers,
          SUM(u.wa_asks > 0) AS asked,
          SUM(u.wa_phone IS NOT NULL) AS leads,
          SUM(u.wa_phone IS NOT NULL AND u.wa_es_mobile = 1) AS es_leads,
          SUM(u.optout_at IS NOT NULL) AS optouts,
          SUM(u.entry = 'webapp') AS via_app,
          SUM(u.blocked) AS blocked
        FROM users u GROUP BY u.src, u.variant ORDER BY starts DESC`).all();
    },

    leads({ src } = {}) {
      const where = src ? 'AND u.src = ?' : '';
      return db.prepare(`
        SELECT u.id AS telegram_id, u.username, u.first_name, u.wa_phone AS phone, u.wa_phone_source AS phone_source,
               u.wa_es_mobile AS es_mobile, u.src, u.variant, u.consent_at, u.consent_version, u.wa_saved_at,
               (SELECT COUNT(*) FROM picks p WHERE p.user_id = u.id) AS picks,
               u.score_user, u.score_ai
        FROM users u WHERE u.wa_phone IS NOT NULL AND u.optout_at IS NULL ${where}
        ORDER BY u.wa_saved_at`).all(...(src ? [src] : []));
    },
  };
  return api;
}

module.exports = { openDb };
