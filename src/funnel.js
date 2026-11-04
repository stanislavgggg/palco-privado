// "Tú vs IA" funnel for Spain (GG Group). Goal: WhatsApp number with consent.
// Transport-independent: tg = { send(userId, html, extra) }, http = { post(url, body, headers) }.

const T = require('./texts');
const kb = require('./keyboards');
const { normalizePhone, isSpanishMobile, looksLikePhone } = require('./phone');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LOCK_BEFORE = 5 * MIN;
const SLATE_HORIZON = 48 * HOUR; // football is weekend-heavy: look two days ahead
const SLATE_SIZE = 5;
const DAILY_DAYS = 14;
const MAX_WA_ASKS = 3;

// A/B: when to ask for WhatsApp. A = right after the first pick; B = after the first graded result.
const variantFor = (id) => (Number(id) % 2 === 0 ? 'A' : 'B');
const parseSource = (p) => (/^[A-Za-z0-9_-]{1,64}$/.test(String(p || '').trim()) ? String(p).trim() : 'organic');

function weekStart(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

function createFunnel({ db, api, config, tg, http = null, now = () => Date.now() }) {
  async function send(userId, html, extra = {}) {
    // Mini-app users who haven't allowed the bot to write to them: don't message, don't mark blocked.
    const u = db.getUser(userId);
    if (u && u.pm_allowed === 0) return false;
    try {
      await tg.send(userId, html, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
      return true;
    } catch (e) {
      if ((e?.response?.error_code || e?.code) === 403) {
        db.setUser(userId, { blocked: 1 });
        db.cancelJobs(userId);
        db.logEvent(userId, 'blocked');
        return false;
      }
      throw e;
    }
  }

  function ensureUser(from) {
    return db.getUser(from.id)
      || db.upsertUser({ id: from.id, username: from.username, first_name: from.first_name, src: 'organic', variant: variantFor(from.id) }).user;
  }

  async function slate() {
    const t = now();
    return (await api.all())
      .filter((m) => api.isUsable(m) && !m.result && m.startsAt - LOCK_BEFORE > t && m.startsAt < t + SLATE_HORIZON)
      .sort((a, b) => a.startsAt - b.startsAt)
      .slice(0, SLATE_SIZE);
  }

  async function openFor(userId) {
    const picked = new Set(db.pickedIds(userId));
    const list = await slate();
    return { list, open: list.filter((m) => !picked.has(m.id)) };
  }

  async function askNext(userId) {
    const { list, open } = await openFor(userId);
    if (!list.length) return send(userId, T.noSlate(), kb.menu());
    if (!open.length) return send(userId, T.allPicked(), kb.menu());
    const m = open[0];
    return send(userId, T.question(m, list.indexOf(m), list.length, config.timeZone), kb.question(m));
  }

  const canAskWa = (u) => !u.wa_phone && !u.optout_at && u.wa_asks < MAX_WA_ASKS && u.wa_state !== 'awaiting';

  async function askWa(userId, reason) {
    const u = db.getUser(userId);
    if (!canAskWa(u)) return false;
    db.setUser(userId, { wa_asks: u.wa_asks + 1 });
    db.logEvent(userId, 'wa_ask', { reason, n: u.wa_asks + 1 });
    await send(userId, T.waAsk(config), kb.waAsk());
    return true;
  }

  async function notifyWebhook(type, payload) {
    if (!config.leadWebhookUrl || !http) return;
    try {
      await http.post(config.leadWebhookUrl, { type, ...payload },
        config.leadWebhookToken ? { Authorization: `Bearer ${config.leadWebhookToken}` } : {});
    } catch (e) {
      console.error('[webhook]', e.message);
      db.logEvent(payload.telegram_id, 'webhook_failed', { type, error: e.message });
    }
  }

  // Pure: saves the number + webhook; no Telegram messages. Used by the bot and the mini app.
  async function recordLead(user, phone, source) {
    const changed = Boolean(user.wa_phone && user.wa_phone !== phone);
    db.setUser(user.id, {
      wa_phone: phone, wa_phone_source: source, wa_es_mobile: isSpanishMobile(phone) ? 1 : 0,
      wa_saved_at: user.wa_saved_at || now(), wa_state: 'saved',
    });
    db.cancelJobs(user.id, ['wa_ask']);
    db.logEvent(user.id, changed ? 'lead_updated' : 'lead', { source, es_mobile: isSpanishMobile(phone) });
    const u = db.getUser(user.id);
    await notifyWebhook(changed ? 'lead_updated' : 'lead', {
      telegram_id: u.id, username: u.username, first_name: u.first_name, phone, phone_source: source,
      es_mobile: Boolean(u.wa_es_mobile), src: u.src, variant: u.variant, entry: u.entry, consent_at: u.consent_at,
      consent_version: u.consent_version, picks: db.pickCount(u.id), score_user: u.score_user, score_ai: u.score_ai,
    });
    return { changed };
  }

  async function saveLead(user, phone, source) {
    const { changed } = await recordLead(user, phone, source);
    await send(user.id, T.waSaved(phone, config), kb.removeReply());
    if (config.communityUrl && !changed) await send(user.id, '👇', kb.community(config));
  }

  // Pure: validates and stores a pick. Returns { status, match }.
  // status: ok | invalid | locked | already
  async function makePick(user, matchId, pick) {
    const m = await api.byId(matchId);
    if (!m || !['home', 'draw', 'away'].includes(pick) || !api.isUsable(m)) return { status: 'invalid', match: m };
    if (m.startsAt - LOCK_BEFORE <= now() || m.result) return { status: 'locked', match: m };
    if (!db.addPick({ userId: user.id, matchId: m.id, pick, aiPick: m.consensus, match: m })) {
      return { status: 'already', match: m, existing: db.getPick(user.id, m.id) };
    }
    db.logEvent(user.id, 'pick', { match: m.id, agree: pick === m.consensus, entry: user.entry });
    db.schedule(user.id, 'grade', m.startsAt + 2 * HOUR, m.id); // football: ~2h to final whistle
    return { status: 'ok', match: m };
  }

  function scheduleNewUser(userId) {
    const t0 = now();
    for (let d = 1; d <= DAILY_DAYS; d++) db.schedule(userId, 'daily', t0 + d * DAY, `d${d}`);
    db.schedule(userId, 'wa_ask', t0 + 26 * HOUR, '1');
    db.schedule(userId, 'wa_ask', t0 + 72 * HOUR, '2');
  }

  return {
    variantFor,
    parseSource,
    // used by the mini app (src/webapp.js)
    core: {
      slate, makePick, recordLead, scheduleNewUser, weekStart, LOCK_BEFORE, MAX_WA_ASKS,
      // Pure opt-out: deletes the number, withdraws consent, notifies the webhook.
      async optout(user) {
        const phone = user.wa_phone;
        db.setUser(user.id, {
          wa_phone: null, wa_phone_source: null, wa_es_mobile: null, optout_at: now(), wa_state: 'optout', consent_at: null,
        });
        db.cancelJobs(user.id, ['wa_ask']);
        db.logEvent(user.id, 'optout', { entry: 'webapp' });
        if (phone) await notifyWebhook('optout', { telegram_id: user.id, phone });
        return { hadPhone: Boolean(phone) };
      },
    },

    async onStart(from, payload) {
      const src = parseSource(payload);
      const { user, isNew } = db.upsertUser({
        id: from.id, username: from.username, first_name: from.first_name, src, variant: variantFor(from.id),
      });
      db.logEvent(user.id, isNew ? 'start' : 'restart', { src });
      if (user.pm_allowed === 0) db.setUser(user.id, { pm_allowed: 1, blocked: 0 }); // opened the bot chat
      if (isNew) scheduleNewUser(user.id);
      await send(user.id, T.intro());
      return askNext(user.id);
    },

    onSlate: (from) => askNext(ensureUser(from).id),

    async onPick(from, matchId, pick) {
      const user = ensureUser(from);
      const r = await makePick(user, matchId, pick);
      if (r.status === 'invalid') return askNext(user.id);
      if (r.status === 'locked') return send(user.id, T.locked(), kb.slate());
      if (r.status === 'already') return send(user.id, T.already(r.match, r.existing), kb.slate());
      const m = r.match;
      const { open } = await openFor(user.id);
      await send(user.id, T.reveal(m, pick), kb.afterPick(open.length > 0));
      if (user.variant === 'A' && db.pickCount(user.id) === 1) await askWa(user.id, 'first_pick');
    },

    async onTop(from) {
      const user = ensureUser(from);
      const since = weekStart(now());
      return send(user.id, T.top(db.weeklyTop(since), db.weeklyRank(user.id, since)), kb.slate());
    },

    async onMe(from) {
      const user = ensureUser(from);
      return send(user.id, T.me(db.getUser(user.id), db.pickCount(user.id)), kb.menu());
    },

    // --- WhatsApp capture ---
    async onWa(from, action) {
      const user = ensureUser(from);
      if (action === 'yes') {
        db.setUser(user.id, { consent_at: now(), consent_version: config.consentVersion, wa_state: 'awaiting', optout_at: null });
        db.logEvent(user.id, 'consent', { version: config.consentVersion });
        return send(user.id, T.waHowShare(), kb.waShare());
      }
      db.setUser(user.id, { wa_state: 'later' });
      db.logEvent(user.id, 'wa_later');
      return send(user.id, T.waLater(), kb.slate());
    },

    async onContact(from, contact) {
      const user = ensureUser(from);
      if (!user.consent_at || user.optout_at) return this.onText(from, '');
      if (contact.user_id && contact.user_id !== from.id) return send(user.id, T.waNotYours(), kb.waShare());
      const phone = normalizePhone(contact.phone_number);
      if (!phone) return send(user.id, T.waInvalid(), kb.waShare());
      return saveLead(user, phone, 'telegram_contact');
    },

    async onText(from, text) {
      const user = ensureUser(from);
      const t = String(text || '').trim();
      const inWa = user.wa_state === 'awaiting' || user.wa_state === 'saved';
      if (user.wa_state === 'awaiting' && t === T.btn.cancel) {
        db.setUser(user.id, { wa_state: 'later' });
        db.logEvent(user.id, 'wa_cancel');
        return send(user.id, T.waCancelled(), kb.removeReply());
      }
      if (inWa && user.consent_at && !user.optout_at && looksLikePhone(t)) {
        const phone = normalizePhone(t);
        if (!phone) return send(user.id, T.waInvalid(), user.wa_state === 'awaiting' ? kb.waShare() : {});
        return saveLead(user, phone, 'typed');
      }
      if (user.wa_state === 'awaiting' && t) return send(user.id, T.waInvalid(), kb.waShare());
      return askNext(user.id);
    },

    async onOptout(from) {
      const user = ensureUser(from);
      if (!user.wa_phone) {
        db.setUser(user.id, { optout_at: now(), wa_state: 'optout' });
        db.cancelJobs(user.id, ['wa_ask']);
        return send(user.id, T.optoutNone(), kb.removeReply());
      }
      const phone = user.wa_phone;
      db.setUser(user.id, {
        wa_phone: null, wa_phone_source: null, wa_es_mobile: null, optout_at: now(), wa_state: 'optout', consent_at: null,
      });
      db.cancelJobs(user.id, ['wa_ask']);
      db.logEvent(user.id, 'optout');
      await notifyWebhook('optout', { telegram_id: user.id, phone });
      return send(user.id, T.optout(), kb.removeReply());
    },

    async runJob(job) {
      const user = db.getUser(job.user_id);
      if (!user || user.blocked) return 'skip';

      if (job.kind === 'grade') {
        const m = await api.byId(job.payload);
        const p = db.getPick(user.id, job.payload);
        if (!m || !p || p.graded) return 'skip';
        if (!m.result) return job.attempts < 12 ? 'retry:30' : 'skip';
        const correct = p.pick === m.result.outcome;
        const aiCorrect = p.ai_pick === m.result.outcome;
        db.gradePick(user.id, m.id, correct, aiCorrect, m.result);
        const streak = correct ? user.streak + 1 : 0;
        db.setUser(user.id, {
          streak, best_streak: Math.max(user.best_streak, streak),
          score_user: user.score_user + (correct ? 1 : 0), score_ai: user.score_ai + (aiCorrect ? 1 : 0),
          graded_count: user.graded_count + 1,
        });
        const u = db.getUser(user.id);
        await send(user.id, T.graded(m, db.getPick(user.id, m.id), u, db.weeklyRank(user.id, weekStart(now()))), kb.graded());
        if (u.variant === 'B' && u.graded_count === 1) await askWa(user.id, 'first_result');
        return 'sent';
      }

      if (job.kind === 'daily') {
        const { open } = await openFor(user.id);
        if (!open.length) return 'skip';
        await send(user.id, T.daily(open.length), kb.slate());
        return 'sent';
      }

      if (job.kind === 'wa_ask') {
        if (db.pickCount(user.id) === 0) return 'skip'; // ask only engaged players
        return (await askWa(user.id, `late_${job.payload}`)) ? 'sent' : 'skip';
      }
      return 'skip';
    },

    async tick() {
      const out = [];
      for (const job of db.dueJobs()) {
        let res;
        try {
          res = await this.runJob(job);
        } catch (e) {
          console.error(`[job ${job.id} ${job.kind}]`, e.message);
          res = job.attempts < 5 ? 'retry:10' : 'skip';
        }
        if (typeof res === 'string' && res.startsWith('retry:')) db.retryJob(job.id, now() + Number(res.split(':')[1]) * MIN);
        else {
          db.finishJob(job.id);
          if (res === 'sent') db.logEvent(job.user_id, `push_${job.kind}`);
        }
        out.push({ id: job.id, kind: job.kind, res });
      }
      return out;
    },

    leadsCsv(src) {
      const rows = db.leads({ src });
      const cols = ['telegram_id', 'username', 'first_name', 'phone', 'phone_source', 'es_mobile', 'src', 'variant',
        'consent_version', 'consent_at', 'wa_saved_at', 'picks', 'score_user', 'score_ai'];
      const iso = (v) => (v ? new Date(v).toISOString() : '');
      const cell = (v, c) => {
        let s = v == null ? '' : String(v);
        // Spreadsheet formula injection guard for user-controlled text (names, usernames).
        if ((c === 'first_name' || c === 'username') && /^[=+\-@]/.test(s)) s = `'${s}`;
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = rows.map((r) => cols.map((c) => cell(c.endsWith('_at') ? iso(r[c]) : r[c], c)).join(','));
      return { count: rows.length, csv: [cols.join(','), ...lines].join('\n') };
    },
  };
}

module.exports = { createFunnel, variantFor, parseSource, weekStart };
