// Mini app: static files under /app + JSON API under /api, on the same Railway
// service and domain as the bot. Every API call is authenticated with Telegram
// WebApp initData (HMAC-SHA256 with the bot token), so a user can only act as themselves.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { normalizePhone, isSpanishMobile } = require('./phone');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function validateInitData(initData, botToken, { maxAgeSec = 24 * 3600, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash, 'hex'))) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || nowSec - authDate > maxAgeSec) return null;
  let user;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { return null; }
  if (!user || !Number.isInteger(user.id)) return null;
  return { user, startParam: params.get('start_param') || '', authDate };
}

const maskPhone = (p) => (p ? p.replace(/^(\+\d{2})(\d)(\d+)(\d{2})$/, (_, cc, a, mid, end) => `${cc} ${a}${'•'.repeat(mid.length)}${end}`) : null);

function render(file, vars) {
  return fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8')
    .replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
}

function createWebapp({ db, api, funnel, config, now = () => Date.now() }) {
  const core = funnel.core;
  const router = express.Router();

  // Security headers for the mini app pages (Telegram Web embeds mini apps in an iframe).
  const headers = (_req, res, next) => {
    res.set({
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self' https://telegram.org",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        'frame-ancestors https://telegram.org https://*.telegram.org',
      ].join('; '),
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    next();
  };

  const legalVars = {
    COMPANY_NAME: config.companyName,
    COMPANY_CODE: config.companyCode,
    COMPANY_ADDRESS: config.companyAddress,
    PRIVACY_EMAIL: config.privacyEmail || '[email de contacto de privacidad]',
    UPDATED: config.legalUpdated,
    BOT_USERNAME: config.botUsername ? `@${config.botUsername}` : 'el bot',
  };
  router.get('/app/privacy', headers, (_req, res) => res.type('html').send(render('privacy.html', legalVars)));
  router.get('/app/terms', headers, (_req, res) => res.type('html').send(render('terms.html', legalVars)));
  router.get(['/app/privacy.html', '/app/terms.html'], (req, res) => res.redirect(301, req.path.replace(/\.html$/, '')));
  // Express routing isn't strict, so "/app" and "/app/" both land here: redirect only the bare one.
  router.get('/app', (req, res, next) => (req.originalUrl.split('?')[0] === '/app' ? res.redirect(301, '/app/') : next()));
  router.use('/app', headers, express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '5m' }));

  // --- API ---
  const hits = new Map(); // naive per-user rate limit: 60 requests / minute
  function rateLimited(userId) {
    const t = now();
    const arr = (hits.get(userId) || []).filter((x) => t - x < 60_000);
    arr.push(t);
    hits.set(userId, arr);
    return arr.length > 60;
  }

  const auth = (req, res, next) => {
    const data = validateInitData(req.get('X-Telegram-Init-Data'), config.botToken, { nowSec: Math.floor(now() / 1000) });
    if (!data) return res.status(401).json({ error: 'unauthorized' });
    if (rateLimited(data.user.id)) return res.status(429).json({ error: 'slow_down' });
    const tgUser = data.user;
    let user = db.getUser(tgUser.id);
    if (!user) {
      ({ user } = db.upsertUser({
        id: tgUser.id, username: tgUser.username, first_name: tgUser.first_name,
        src: funnel.parseSource(data.startParam), variant: funnel.variantFor(tgUser.id),
        entry: 'webapp', pm_allowed: tgUser.allows_write_to_pm ? 1 : 0,
      }));
      db.logEvent(user.id, 'app_start', { src: user.src });
      core.scheduleNewUser(user.id);
    } else if (tgUser.allows_write_to_pm && user.pm_allowed === 0) {
      db.setUser(user.id, { pm_allowed: 1 });
      user = db.getUser(user.id);
    }
    req.user = user;
    next();
  };

  router.use('/api', express.json({ limit: '8kb' }), auth);

  function revealOf(m, pick) {
    const reason = m.models.find((x) => x.side === m.consensus && x.rationale)?.rationale || '';
    return { aiPick: m.consensus, agree: m.agree, total: m.total, reason, sameAsAi: pick === m.consensus };
  }

  router.get('/api/state', async (req, res) => {
    const u = db.getUser(req.user.id);
    const t = now();
    let slate = [];
    try { slate = await core.slate(); } catch { slate = []; }
    const picks = new Map(db.recentPicks(u.id, 50).map((p) => [p.match_id, p]));
    const matches = slate.map((m) => {
      const p = picks.get(m.id);
      return {
        id: m.id, home: m.home, away: m.away, competition: m.competition, startsAt: m.startsAt,
        locked: m.startsAt - core.LOCK_BEFORE <= t,
        myPick: p ? p.pick : null,
        // AI pick is revealed only after the user has picked.
        reveal: p ? revealOf(m, p.pick) : null,
      };
    });
    const history = db.recentPicks(u.id, 20).map((p) => ({
      id: p.match_id, home: p.home, away: p.away, competition: p.competition, startsAt: p.starts_at,
      myPick: p.pick, aiPick: p.ai_pick, graded: Boolean(p.graded),
      correct: p.graded ? Boolean(p.correct) : null, aiCorrect: p.graded ? Boolean(p.ai_correct) : null,
      score: p.result_score,
    }));
    res.json({
      user: {
        firstName: u.first_name, scoreUser: u.score_user, scoreAi: u.score_ai,
        streak: u.streak, bestStreak: u.best_streak, picks: db.pickCount(u.id),
      },
      matches,
      history,
      wa: { saved: Boolean(u.wa_phone), phone: maskPhone(u.wa_phone), optedOut: Boolean(u.optout_at) },
      pmAllowed: u.pm_allowed === 1,
      timeZone: config.timeZone,
      companyName: config.companyName,
    });
  });

  router.post('/api/pick', async (req, res) => {
    const { matchId, pick } = req.body || {};
    if (typeof matchId !== 'string' || matchId.length > 64) return res.status(400).json({ error: 'bad_request' });
    const r = await core.makePick(req.user, matchId, String(pick || ''));
    if (r.status === 'invalid') return res.status(400).json({ status: 'invalid' });
    if (r.status === 'locked') return res.status(409).json({ status: 'locked' });
    const myPick = r.status === 'already' ? r.existing.pick : pick;
    return res.json({ status: r.status, myPick, reveal: revealOf(r.match, myPick) });
  });

  router.get('/api/top', (req, res) => {
    const since = core.weekStart(now());
    const rows = db.weeklyTop(since).map((r) => ({
      name: r.first_name || (r.username ? `@${r.username}` : 'Jugador'), wins: r.wins, graded: r.graded, me: r.id === req.user.id,
    }));
    res.json({ rows, me: db.weeklyRank(req.user.id, since) });
  });

  router.post('/api/wa', async (req, res) => {
    const { phone, adult, consent } = req.body || {};
    if (adult !== true || consent !== true) return res.status(400).json({ error: 'consent_required' });
    const e164 = normalizePhone(phone);
    if (!e164) return res.status(400).json({ error: 'invalid_phone' });
    db.setUser(req.user.id, { consent_at: now(), consent_version: config.consentVersion, optout_at: null });
    db.logEvent(req.user.id, 'consent', { version: config.consentVersion, entry: 'webapp' });
    await core.recordLead(db.getUser(req.user.id), e164, 'webapp_form');
    return res.json({ ok: true, phone: maskPhone(e164), esMobile: isSpanishMobile(e164) });
  });

  router.post('/api/wa/optout', async (req, res) => {
    const r = await core.optout(db.getUser(req.user.id));
    res.json({ ok: true, ...r });
  });

  // Called after Telegram.WebApp.requestWriteAccess() succeeds on the client.
  router.post('/api/pm', (req, res) => {
    if (req.body && req.body.allowed === true) {
      db.setUser(req.user.id, { pm_allowed: 1, blocked: 0 });
      db.logEvent(req.user.id, 'pm_allowed');
    }
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createWebapp, validateInitData, maskPhone };
