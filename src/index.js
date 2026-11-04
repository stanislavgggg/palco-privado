const express = require('express');
const { Telegraf } = require('telegraf');
const config = require('./config');
const { openDb } = require('./db');
const { createApi } = require('./api');
const { createFunnel } = require('./funnel');

if (!config.botToken) {
  console.error('BOT_TOKEN is not set');
  process.exit(1);
}
if (config.setsMock) console.warn('[api] SETS_URL not set or SETS_MOCK=1 — using fixtures/sets.sample.json');
if (!config.privacyUrl) console.warn('[consent] PRIVACY_URL is empty — set it before collecting numbers');

const db = openDb(config.dbPath);
const api = createApi(config);
const bot = new Telegraf(config.botToken);

const tg = { send: (userId, html, extra) => bot.telegram.sendMessage(userId, html, extra) };
const http = {
  async post(url, body, headers = {}) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },
};
const funnel = createFunnel({ db, api, config, tg, http });

const isAdmin = (ctx) => config.adminIds.includes(ctx.from.id);
const safe = (fn) => async (ctx) => {
  try {
    await fn(ctx);
  } catch (e) {
    console.error('[handler]', e);
  } finally {
    if (ctx.callbackQuery) ctx.answerCbQuery().catch(() => {});
  }
};

bot.start(safe((ctx) => funnel.onStart(ctx.from, ctx.startPayload)));
bot.action('slate', safe((ctx) => funnel.onSlate(ctx.from)));
bot.action(/^pick:(.{1,40}):(home|draw|away)$/, safe((ctx) => funnel.onPick(ctx.from, ctx.match[1], ctx.match[2])));
bot.action('top', safe((ctx) => funnel.onTop(ctx.from)));
bot.action('me', safe((ctx) => funnel.onMe(ctx.from)));
bot.action(/^wa:(yes|later)$/, safe((ctx) => funnel.onWa(ctx.from, ctx.match[1])));
bot.command(['partidos', 'picks'], safe((ctx) => funnel.onSlate(ctx.from)));
bot.command('top', safe((ctx) => funnel.onTop(ctx.from)));
bot.command(['yo', 'me'], safe((ctx) => funnel.onMe(ctx.from)));
bot.command('baja', safe((ctx) => funnel.onOptout(ctx.from)));
bot.command('whatsapp', safe((ctx) => funnel.onWa(ctx.from, 'yes')));

// Admin
bot.command('stats', safe(async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = db.stats();
  if (!rows.length) return ctx.reply('No users yet.');
  return ctx.reply(rows.map((r) =>
    `${r.src} [${r.variant}]: start ${r.starts} · picked ${r.pickers} · asked ${r.asked} · leads ${r.leads} (ES mobile ${r.es_leads}) · optout ${r.optouts} · blocked ${r.blocked}`,
  ).join('\n'));
}));
// /export            → all leads
// /export esp_q1     → leads from one source (batch testing by source)
bot.command('export', safe(async (ctx) => {
  if (!isAdmin(ctx)) return;
  const src = (ctx.message.text.split(/\s+/)[1] || '').trim() || undefined;
  const { count, csv } = funnel.leadsCsv(src);
  const name = `leads_${src || 'all'}_${new Date().toISOString().slice(0, 10)}.csv`;
  await ctx.replyWithDocument({ source: Buffer.from(csv, 'utf8'), filename: name }, { caption: `${count} leads` });
}));

bot.on('contact', safe((ctx) => funnel.onContact(ctx.from, ctx.message.contact)));
bot.on('text', safe((ctx) => {
  if (ctx.chat.type !== 'private') return;
  return funnel.onText(ctx.from, ctx.message.text);
}));

const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));
app.listen(config.port, () => console.log(`[http] listening on :${config.port}`));

let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    const done = await funnel.tick();
    if (done.length) console.log(`[tick] ${done.length} jobs`, done.map((d) => `${d.kind}:${d.res}`).join(' '));
  } catch (e) {
    console.error('[tick]', e);
  } finally {
    ticking = false;
  }
}, config.tickSeconds * 1000);

bot.launch({ dropPendingUpdates: true }).catch((e) => {
  console.error('[bot] launch failed', e);
  process.exit(1);
});
console.log('[bot] started');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
