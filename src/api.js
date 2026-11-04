// Football predictions export (sets.json, read-only, bearer token) + normalizer.
//
// Football has three outcomes. Picks/results are normalized to:
//   'home' | 'draw' | 'away'
// The export's exact field names weren't available when this was written,
// so normalizeSet() accepts several spellings. Check it against one real
// record before launch (fixtures/sets.sample.json shows the target shape).

const fs = require('fs');
const path = require('path');

function pick(obj, paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const rel = /^now([+-]\d+)$/.exec(String(v)); // fixture helper: minutes from now
  if (rel) return Date.now() + Number(rel[1]) * 60_000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

const isFootball = (raw) => /football|soccer|f[uú]tbol|laliga|la liga|champions|premier|serie a|bundesliga/i.test(String(raw || ''));

const norm = (s) => String(s || '').trim().toLowerCase();

// Map a pick value to home/draw/away using the team names.
function side(value, home, away) {
  const v = norm(value);
  if (!v) return null;
  if (['draw', 'x', 'empate', 'tie', 'd'].includes(v)) return 'draw';
  if (['home', '1', 'h', 'local'].includes(v) || v === norm(home)) return 'home';
  if (['away', '2', 'a', 'visitante'].includes(v) || v === norm(away)) return 'away';
  return null;
}

function sideFromScore(score) {
  const m = /^\s*(\d+)\s*[:\-–]\s*(\d+)\s*$/.exec(String(score || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const a = Number(m[2]);
  return h > a ? 'home' : h < a ? 'away' : 'draw';
}

const LOW_CONFIDENCE = /needs a human/i;

function normalizeSet(s) {
  const home = pick(s, ['match.home', 'match.team_a', 'home', 'team_a', 'teams.0.name', 'teams.0']);
  const away = pick(s, ['match.away', 'match.team_b', 'away', 'team_b', 'teams.1.name', 'teams.1']);
  const competition = pick(s, ['match.competition', 'match.tournament', 'competition', 'tournament', 'league', 'event']) || '';
  const sport = pick(s, ['sport', 'game', 'discipline', 'category', 'channel']) || competition;

  const modelsRaw = pick(s, ['models', 'predictions', 'model_predictions']) || [];
  const models = (Array.isArray(modelsRaw) ? modelsRaw : Object.entries(modelsRaw).map(([name, v]) => ({ name, ...v })))
    .map((m) => ({
      name: pick(m, ['name', 'model', 'id']) || 'model',
      side: side(pick(m, ['pick', 'winner', 'prediction', 'outcome', 'side']), home, away),
      rationale: pick(m, ['rationale', 'reason', 'reasoning', 'why']) || '',
    }))
    .filter((m) => m.side);

  const tally = { home: 0, draw: 0, away: 0 };
  for (const m of models) tally[m.side]++;
  let consensus = side(pick(s, ['consensus.pick', 'consensus.outcome', 'consensus']), home, away);
  if (!consensus && models.length) consensus = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];

  const r = pick(s, ['result', 'graded', 'outcome_result']);
  let result = null;
  if (r && typeof r === 'object') {
    const score = pick(r, ['score', 'final_score']) || '';
    const outcome = side(pick(r, ['winner', 'outcome']), home, away) || sideFromScore(score);
    const status = norm(pick(r, ['status', 'state']));
    if (outcome && (['graded', 'final', 'finished', 'settled', 'done', 'ft'].includes(status) || !status)) {
      result = { score: String(score), outcome };
    }
  }

  const text = models.map((m) => m.rationale).join(' ') + ' ' + String(pick(s, ['note', 'text']) || '');
  return {
    id: String(pick(s, ['id', 'set_id', 'match.id', 'match_id']) || `${home}-${away}-${pick(s, ['match.start_time', 'start_time'])}`),
    football: isFootball(sport) || isFootball(competition),
    home: home && String(home),
    away: away && String(away),
    competition: String(competition),
    startsAt: toMs(pick(s, ['match.start_time', 'start_time', 'starts_at', 'match.starts_at', 'kickoff', 'date'])),
    consensus,
    agree: consensus ? tally[consensus] : 0,
    total: models.length,
    models,
    result,
    lowConfidence: LOW_CONFIDENCE.test(text),
  };
}

function isUsable(m, { minShare = 0.5, leagues = [] } = {}) {
  if (!m.football || !m.home || !m.away || !m.startsAt || !m.consensus || m.lowConfidence || !m.total) return false;
  if (m.agree / m.total < minShare) return false;
  if (leagues.length && !leagues.some((l) => m.competition.toLowerCase().includes(l.toLowerCase()))) return false;
  return true;
}

function createApi(config, { fetchImpl = global.fetch, cacheMs = 60_000 } = {}) {
  let cache = { at: 0, items: [] };

  async function loadRaw() {
    if (config.setsMock) {
      return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sets.sample.json'), 'utf8'));
    }
    const res = await fetchImpl(config.setsUrl, {
      headers: { Authorization: `Bearer ${config.setsToken}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`sets.json HTTP ${res.status}`);
    return res.json();
  }

  async function all() {
    if (cache.at && Date.now() - cache.at < cacheMs) return cache.items;
    try {
      const raw = await loadRaw();
      const list = Array.isArray(raw) ? raw : (raw.sets || raw.items || raw.data || []);
      cache = { at: Date.now(), items: list.map(normalizeSet).filter((m) => m.football) };
    } catch (e) {
      console.error('[api] load failed:', e.message);
      if (!cache.items.length) throw e;
    }
    return cache.items;
  }

  async function byId(id) {
    return (await all()).find((m) => m.id === String(id)) || null;
  }

  return { all, byId, isUsable: (m) => isUsable(m, { minShare: config.minShare, leagues: config.leagues }) };
}

module.exports = { createApi, normalizeSet, isUsable, side, sideFromScore };
