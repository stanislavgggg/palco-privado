// Offline tests: no Telegram, no network. Run: npm test
const assert = require('assert');

const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;

const config = {
  ...require('../src/config'),
  setsMock: true, dbPath: ':memory:', leagues: ['LaLiga', 'Champions League'], minShare: 0.5,
  communityUrl: 'https://t.me/+test', communityLabel: 'Apuestas Guru', privacyUrl: 'https://example.test/privacy',
  companyName: 'UAB "GG Group Media"', consentVersion: 'wa-v1', leadWebhookUrl: 'https://hook.test/lead',
};

const { openDb } = require('../src/db');
const { createApi, normalizeSet } = require('../src/api');
const { createFunnel } = require('../src/funnel');
const { normalizePhone, isSpanishMobile } = require('../src/phone');

const sent = [];
const hooks = [];
const tg = { async send(id, html, extra) { sent.push({ id, html, extra }); } };
const http = { async post(url, body) { hooks.push({ url, body }); } };
const db = openDb(':memory:');
const api = createApi(config, { cacheMs: Infinity });
const funnel = createFunnel({ db, api, config, tg, http, now: () => clock });

const MIN = 60_000;
const HOUR = 60 * MIN;
let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok  ', name); }
  catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1; }
}
const last = () => sent[sent.length - 1];
const mine = (id, re) => sent.filter((s) => s.id === id && re.test(s.html));
const inline = (m) => (m.extra.reply_markup?.inline_keyboard || []).flat();

const results = {};
const origById = api.byId;
api.byId = async (id) => {
  const m = await origById(id);
  return m && results[m.id] ? { ...m, result: results[m.id] } : m;
};

(async () => {
  const A = { id: 2000, first_name: 'Ana' };   // even -> WA ask after first pick
  const B = { id: 2001, first_name: 'Borja' }; // odd  -> WA ask after first result

  await t('phone normalization (ES)', async () => {
    assert.strictEqual(normalizePhone('612 345 678'), '+34612345678');
    assert.strictEqual(normalizePhone('0034 712-345-678'), '+34712345678');
    assert.strictEqual(normalizePhone('34612345678'), '+34612345678');
    assert.strictEqual(normalizePhone('+44 7700 900123'), '+447700900123');
    assert.strictEqual(normalizePhone('123'), null);
    assert.ok(isSpanishMobile('+34612345678'));
    assert.ok(!isSpanishMobile('+34912345678')); // landline
  });

  await t('normalizer: 3-way outcomes, draw, score -> outcome', async () => {
    const m = normalizeSet({ id: 'x', sport: 'football', home: 'A', away: 'B', start_time: 1893456000,
      predictions: { m1: { pick: 'X' }, m2: { pick: 'draw' }, m3: { pick: 'A' } }, result: { score: '1-1' } });
    assert.strictEqual(m.consensus, 'draw');
    assert.strictEqual(m.agree, 2);
    assert.strictEqual(m.result.outcome, 'draw');
  });

  await t('slate: football only, leagues filter, no low-confidence', async () => {
    await funnel.onStart(A, 'es_q1');
    const q = last();
    assert.match(q.html, /Partido 1 de 2: Equipo Rojo – Equipo Azul/);
    assert.match(q.html, /LaLiga/);
    assert.deepStrictEqual(inline(q).map((b) => b.callback_data), ['pick:fb-001:home', 'pick:fb-001:draw', 'pick:fb-001:away']);
    assert.ok(sent.some((s) => s.id === 2000 && /Bienvenido al Palco Privado/.test(s.html)));
  });

  await t('variant A: reveal, then WhatsApp ask with consent text after first pick', async () => {
    await funnel.onPick(A, 'fb-001', 'draw');
    const reveal = mine(2000, /Te la juegas/)[0];
    assert.match(reveal.html, /Elegiste <b>Empate<\/b> — 3 de 4 modelos van con <b>Equipo Rojo/);
    const ask = last();
    assert.match(ask.html, /WhatsApp/);
    assert.match(ask.html, /18 años o más/);
    assert.match(ask.html, /GG Group Media/);
    assert.match(ask.html, /\/baja/);
    assert.match(ask.html, /example\.test\/privacy/);
    assert.deepStrictEqual(inline(ask).map((b) => b.callback_data), ['wa:yes', 'wa:later']);
    assert.strictEqual(db.getUser(2000).wa_asks, 1);
  });

  await t('consent -> share-contact keyboard; someone else\'s contact refused; own contact saved', async () => {
    await funnel.onWa(A, 'yes');
    assert.ok(db.getUser(2000).consent_at);
    const kbd = last().extra.reply_markup.keyboard;
    assert.ok(kbd[0][0].request_contact);
    await funnel.onContact(A, { phone_number: '34600111222', user_id: 999 });
    assert.match(last().html, /no es tuyo/);
    await funnel.onContact(A, { phone_number: '34600111222', user_id: 2000 });
    const u = db.getUser(2000);
    assert.strictEqual(u.wa_phone, '+34600111222');
    assert.strictEqual(u.wa_es_mobile, 1);
    assert.ok(mine(2000, /Guardado: <b>\+34600111222/).length === 1);
    assert.strictEqual(hooks.length, 1);
    assert.strictEqual(hooks[0].body.type, 'lead');
    assert.strictEqual(hooks[0].body.src, 'es_q1');
    assert.strictEqual(hooks[0].body.consent_version, 'wa-v1');
  });

  await t('typed number after saving updates it (other WhatsApp)', async () => {
    await funnel.onText(A, '711 222 333');
    assert.strictEqual(db.getUser(2000).wa_phone, '+34711222333');
    assert.strictEqual(hooks[hooks.length - 1].body.type, 'lead_updated');
  });

  await t('variant B: no ask on pick; "later" works; typed invalid number re-prompts', async () => {
    await funnel.onStart(B, 'es_q2');
    await funnel.onPick(B, 'fb-001', 'home');
    assert.strictEqual(mine(2001, /WhatsApp/).length, 0);
    assert.match(last().html, /Coincides con la IA/);
  });

  await t('picks lock 5 min before kickoff', async () => {
    clock += 86 * MIN;
    await funnel.onPick({ id: 3003 }, 'fb-001', 'home');
    assert.match(last().html, /cerrado/);
  });

  await t('grading waits for result; A misses on draw pick, B hits; B gets WA ask after first result', async () => {
    clock += 2 * HOUR + 10 * MIN; // past kickoff + 2h
    let r = await funnel.tick();
    assert.ok(r.some((x) => x.kind === 'grade' && x.res.startsWith('retry')));
    results['fb-001'] = { score: '2-1', outcome: 'home' };
    clock += 31 * MIN;
    await funnel.tick();
    const ga = mine(2000, /Esta vez no · la IA acertó/)[0];
    assert.ok(ga && /Tú 0 – 1 IA/.test(ga.html));
    const gb = mine(2001, /Acertaste · la IA acertó/)[0];
    assert.ok(gb && /Tú 1 – 1 IA/.test(gb.html) && /Racha: 1/.test(gb.html));
    assert.strictEqual(mine(2001, /pick de la IA por WhatsApp/).length, 1);
  });

  await t('B: later, then cancel flow and invalid input', async () => {
    await funnel.onWa(B, 'later');
    assert.match(last().html, /Sin problema/);
    await funnel.onWa(B, 'yes');
    await funnel.onText(B, 'hola');
    assert.match(last().html, /no parece válido/);
    await funnel.onText(B, 'Cancelar');
    assert.match(last().html, /Cancelado/);
    assert.strictEqual(db.getUser(2001).wa_phone, null);
  });

  await t('late WA asks only for engaged users without a number, max 3 asks', async () => {
    await funnel.onStart({ id: 4004 }, 'es_q3'); // never picks
    clock += 3 * 24 * HOUR;
    await funnel.tick();
    assert.strictEqual(mine(4004, /pick de la IA por WhatsApp/).length, 0);
    assert.ok(db.getUser(2001).wa_asks <= 3);
    assert.strictEqual(mine(2000, /pick de la IA por WhatsApp/).length, 1, 'A already has a number');
  });

  await t('/baja deletes the number and notifies the webhook', async () => {
    await funnel.onOptout(A);
    const u = db.getUser(2000);
    assert.strictEqual(u.wa_phone, null);
    assert.ok(u.optout_at);
    assert.strictEqual(hooks[hooks.length - 1].body.type, 'optout');
    assert.strictEqual(hooks[hooks.length - 1].body.phone, '+34711222333');
  });

  await t('export CSV by source + stats', async () => {
    await funnel.onWa({ id: 5005, first_name: '=HYPERLINK("x")' }, 'yes');
    await funnel.onText({ id: 5005 }, '+34 655 444 333');
    const all = funnel.leadsCsv();
    assert.strictEqual(all.count, 1);
    assert.match(all.csv, /'=HYPERLINK/); // formula guard
    assert.strictEqual(funnel.leadsCsv('es_q1').count, 0); // A opted out
    const st = db.stats().find((r) => r.src === 'es_q1');
    assert.strictEqual(st.optouts, 1);
  });

  await t('blocked user: 403 cancels jobs', async () => {
    const saved = tg.send;
    tg.send = async () => { const e = new Error('Forbidden'); e.response = { error_code: 403 }; throw e; };
    await funnel.onStart({ id: 6006 }, 'x');
    tg.send = saved;
    assert.strictEqual(db.getUser(6006).blocked, 1);
    assert.strictEqual(db.raw.prepare('SELECT COUNT(*) c FROM jobs WHERE user_id = 6006 AND done = 0').get().c, 0);
  });

  Date.now = realNow;
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
