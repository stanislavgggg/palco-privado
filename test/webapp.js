// Mini app tests: initData validation, API, static pages. Offline.
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');

const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;

const BOT_TOKEN = '123456:TEST-token';
const config = {
  ...require('../src/config'),
  botToken: BOT_TOKEN, setsMock: true, dbPath: ':memory:', leagues: ['LaLiga', 'Champions League'], minShare: 0.5,
  companyName: 'UAB "GG Group Media"', companyCode: '305446632', companyAddress: 'A. Vivulskio g. 7-1, Vilnius, Lituania',
  privacyEmail: 'privacy@example.test', consentVersion: 'wa-v1', leadWebhookUrl: 'https://hook.test',
};

const { openDb } = require('../src/db');
const { createApi } = require('../src/api');
const { createFunnel } = require('../src/funnel');
const { createWebapp, validateInitData, maskPhone } = require('../src/webapp');

const sent = [];
const hooks = [];
const db = openDb(':memory:');
const api = createApi(config, { cacheMs: Infinity });
const funnel = createFunnel({
  db, api, config, now: () => clock,
  tg: { async send(id, html) { sent.push({ id, html }); } },
  http: { async post(url, body) { hooks.push(body); } },
});

function initDataFor(user, { startParam, authDate = Math.floor(clock / 1000), token = BOT_TOKEN } = {}) {
  const p = new URLSearchParams();
  p.set('auth_date', String(authDate));
  p.set('query_id', 'AAH-test');
  p.set('user', JSON.stringify(user));
  if (startParam) p.set('start_param', startParam);
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok  ', name); }
  catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1; }
}

(async () => {
  const app = express();
  app.use(createWebapp({ db, api, funnel, config, now: () => clock }));
  const srv = app.listen(0);
  const port = srv.address().port;
  const req = (method, path, { initData, body } = {}) => new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ port, path, method, agent: false, headers: {
      ...(initData ? { 'X-Telegram-Init-Data': initData } : {}),
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
    } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => {
        let json = null; try { json = JSON.parse(b); } catch { /* html */ }
        resolve({ status: res.statusCode, headers: res.headers, body: b, json });
      });
    });
    if (data) r.write(data);
    r.end();
  });

  const ana = { id: 7000, first_name: 'Ana', username: 'ana', allows_write_to_pm: true };
  const leo = { id: 7001, first_name: 'Leo' }; // no write access
  const idAna = initDataFor(ana, { startParam: 'es_app1' });
  const idLeo = initDataFor(leo, { startParam: 'es_app2' });

  await t('initData: valid accepted; tampered, wrong token, expired rejected', async () => {
    assert.strictEqual(validateInitData(idAna, BOT_TOKEN, { nowSec: Math.floor(clock / 1000) }).user.id, 7000);
    assert.strictEqual(validateInitData(idAna.replace('Ana', 'Eve'), BOT_TOKEN), null);
    assert.strictEqual(validateInitData(initDataFor(ana, { token: '999:other' }), BOT_TOKEN), null);
    const old = initDataFor(ana, { authDate: Math.floor(clock / 1000) - 2 * 86400 });
    assert.strictEqual(validateInitData(old, BOT_TOKEN, { nowSec: Math.floor(clock / 1000) }), null);
  });

  await t('API without initData -> 401', async () => {
    assert.strictEqual((await req('GET', '/api/state')).status, 401);
  });

  await t('static mini app served with CSP allowing Telegram frames', async () => {
    const r = await req('GET', '/app/');
    assert.strictEqual(r.status, 200);
    assert.match(r.body, /Palco Privado/);
    assert.match(r.body, /No somos una casa de apuestas/);
    assert.match(r.headers['content-security-policy'], /frame-ancestors https:\/\/telegram\.org https:\/\/\*\.telegram\.org/);
    assert.strictEqual((await req('GET', '/app/app.js')).status, 200);
  });

  await t('privacy and terms pages render company details, no raw tokens', async () => {
    const p = await req('GET', '/app/privacy');
    assert.match(p.body, /305446632/);
    assert.match(p.body, /privacy@example\.test/);
    assert.doesNotMatch(p.body, /\{\{/);
    const tr = await req('GET', '/app/terms');
    assert.match(tr.body, /no es una casa de apuestas/i);
    assert.strictEqual((await req('GET', '/app/privacy.html')).status, 301);
  });

  await t('first /api/state registers the user from the mini app with source and PM flag', async () => {
    const r = await req('GET', '/api/state', { initData: idAna });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.matches.length, 2);
    assert.strictEqual(r.json.matches[0].reveal, null, 'AI pick hidden before picking');
    const u = db.getUser(7000);
    assert.strictEqual(u.entry, 'webapp');
    assert.strictEqual(u.src, 'es_app1');
    assert.strictEqual(u.pm_allowed, 1);
    await req('GET', '/api/state', { initData: idLeo });
    assert.strictEqual(db.getUser(7001).pm_allowed, 0);
  });

  await t('pick -> reveal; duplicate returns the existing pick; bad input 400', async () => {
    const r = await req('POST', '/api/pick', { initData: idAna, body: { matchId: 'fb-001', pick: 'away' } });
    assert.strictEqual(r.json.status, 'ok');
    assert.strictEqual(r.json.reveal.aiPick, 'home');
    assert.strictEqual(r.json.reveal.sameAsAi, false);
    assert.strictEqual(r.json.reveal.agree, 3);
    const d = await req('POST', '/api/pick', { initData: idAna, body: { matchId: 'fb-001', pick: 'home' } });
    assert.strictEqual(d.json.status, 'already');
    assert.strictEqual(d.json.myPick, 'away');
    assert.strictEqual((await req('POST', '/api/pick', { initData: idAna, body: { matchId: 'fb-001', pick: 'x' } })).status, 400);
    const s = await req('GET', '/api/state', { initData: idAna });
    assert.strictEqual(s.json.matches[0].myPick, 'away');
    assert.ok(s.json.matches[0].reveal);
  });

  await t('Leo picks; mini-app user without write access is not messaged and not marked blocked', async () => {
    await req('POST', '/api/pick', { initData: idLeo, body: { matchId: 'fb-001', pick: 'home' } });
    clock += 90 * 60_000 + 2 * 3600_000 + 60_000;
    // result arrives
    const orig = api.byId;
    api.byId = async (id) => { const m = await orig(id); return m && m.id === 'fb-001' ? { ...m, result: { score: '2-0', outcome: 'home' } } : m; };
    await funnel.tick();
    api.byId = orig;
    assert.ok(sent.some((s) => s.id === 7000 && /Esta vez no/.test(s.html)), 'Ana gets result in Telegram');
    assert.strictEqual(sent.filter((s) => s.id === 7001).length, 0, 'Leo not messaged');
    assert.strictEqual(db.getUser(7001).blocked, 0);
    assert.strictEqual(db.getUser(7001).score_user, 1, 'Leo still graded');
  });

  await t('history shows graded picks with score', async () => {
    const idLeo2 = initDataFor(leo);
    const s = await req('GET', '/api/state', { initData: idLeo2 });
    const h = s.json.history[0];
    assert.deepStrictEqual([h.graded, h.correct, h.aiCorrect, h.score], [true, true, true, '2-0']);
    assert.strictEqual(s.json.user.scoreUser, 1);
  });

  await t('WhatsApp: consent required, invalid phone rejected, saved masked, webhook sent', async () => {
    const id = initDataFor(ana);
    assert.strictEqual((await req('POST', '/api/wa', { initData: id, body: { phone: '612345678', adult: true, consent: false } })).json.error, 'consent_required');
    assert.strictEqual((await req('POST', '/api/wa', { initData: id, body: { phone: '12', adult: true, consent: true } })).json.error, 'invalid_phone');
    const ok = await req('POST', '/api/wa', { initData: id, body: { phone: '612 345 678', adult: true, consent: true } });
    assert.strictEqual(ok.json.ok, true);
    assert.strictEqual(ok.json.phone, maskPhone('+34612345678'));
    assert.match(ok.json.phone, /^\+34 6•+78$/);
    const u = db.getUser(7000);
    assert.strictEqual(u.wa_phone, '+34612345678');
    assert.strictEqual(u.wa_phone_source, 'webapp_form');
    assert.strictEqual(u.consent_version, 'wa-v1');
    const last = hooks[hooks.length - 1];
    assert.strictEqual(last.type, 'lead');
    assert.strictEqual(last.entry, 'webapp');
    assert.strictEqual(last.src, 'es_app1');
  });

  await t('WhatsApp opt-out deletes the number and notifies webhook', async () => {
    const r = await req('POST', '/api/wa/optout', { initData: initDataFor(ana), body: {} });
    assert.strictEqual(r.json.hadPhone, true);
    assert.strictEqual(db.getUser(7000).wa_phone, null);
    assert.strictEqual(hooks[hooks.length - 1].type, 'optout');
  });

  await t('write access granted from the app enables Telegram messages', async () => {
    await req('POST', '/api/pm', { initData: initDataFor(leo), body: { allowed: true } });
    assert.strictEqual(db.getUser(7001).pm_allowed, 1);
  });

  await t('top lists names only', async () => {
    const r = await req('GET', '/api/top', { initData: initDataFor(leo) });
    assert.deepStrictEqual(r.json.rows.map((x) => [x.name, x.wins, x.me]), [['Leo', 1, true]]);
    assert.ok(!('id' in r.json.rows[0]));
  });

  srv.close();
  Date.now = realNow;
  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
