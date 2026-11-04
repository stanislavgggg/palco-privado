const path = require('path');

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

const config = {
  botToken: process.env.BOT_TOKEN || '',
  adminIds: list(process.env.ADMIN_IDS).map(Number),
  port: Number(process.env.PORT || 3000),

  // Football predictions export
  setsUrl: process.env.SETS_URL || '',
  setsToken: process.env.SETS_TOKEN || '',
  setsMock: process.env.SETS_MOCK === '1' || !process.env.SETS_URL,
  leagues: list(process.env.LEAGUES || 'LaLiga,Champions League'),
  minShare: Number(process.env.MIN_SHARE || 0.5),
  timeZone: process.env.TIME_ZONE || 'Europe/Madrid',

  // Community link shown after the lead is saved (optional)
  communityUrl: process.env.COMMUNITY_URL || '',
  communityLabel: process.env.COMMUNITY_LABEL || 'Apuestas Guru',

  // Data controller & consent (GDPR) — shown in the consent step
  companyName: process.env.COMPANY_NAME || 'UAB "GG Group Media"',
  privacyUrl: process.env.PRIVACY_URL || '',
  consentVersion: process.env.CONSENT_VERSION || 'wa-v1',

  // Optional: POST each new lead as JSON (e.g. to LeadDeus / Make.com)
  leadWebhookUrl: process.env.LEAD_WEBHOOK_URL || '',
  leadWebhookToken: process.env.LEAD_WEBHOOK_TOKEN || '',

  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bot.sqlite'),
  tickSeconds: Number(process.env.TICK_SECONDS || 60),
};

module.exports = config;
