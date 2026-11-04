# Palco Privado · Tú vs IA — football pick'em for Spain (GG Group)

Spanish version of the "You vs AI" game, for the **GG Group** Spain line (Coinplay is geoblocked in Spain and is not mentioned anywhere in this bot).

The user picks how LaLiga / Champions League matches end (home / draw / away), then sees what the AI models picked and why. After each match: right or wrong, streak, the score **Tú vs IA**, weekly rank. The goal of the funnel is a **WhatsApp number with explicit consent** for the LeadDeus follow-up.

No betting operator, bonus or prize inside the bot: it's a free football game. Operator messaging happens later over WhatsApp and must follow Spanish gambling-advertising rules — check with legal before those messages go out.

## Flow

1. `/start <source>` → intro + first match question (up to 5 matches in the next 48 h; only competitions in `LEAGUES`; only matches where at least `MIN_SHARE` of models agree; "needs a human" placeholders never shown). Picks close 5 min before kickoff. Times in Europe/Madrid.
2. **Reveal** after each pick: "Coincides con la IA" or "Te la juegas — 3 de 4 modelos van con …" + the AI's main reason.
3. **Grading** ~2 h after kickoff (re-checks every 30 min up to ~6 h): result, ✅/❌ for the user and the AI, Tú–IA score, streak, weekly rank. Draws count as an outcome.
4. **WhatsApp ask — A/B by telegram_id:** **A** (even) right after the first pick · **B** (odd) after the first graded result. Plus late asks at +26 h and +72 h for users who picked but haven't left a number. Max 3 asks per user.
5. **Consent:** one tap "Acepto (18+)" on a message that states the 18+ confirmation, the purpose (football picks and commercial messages over WhatsApp), the company (`COMPANY_NAME`), how to opt out (/baja or "BAJA"), and the privacy link (`PRIVACY_URL`). Consent time and version are stored.
6. **Number:** Telegram's native "share my number" button (only the user's own contact is accepted) or typed (612 345 678 → +34612345678). After saving, the user can type another number if their WhatsApp differs. Then a button to the community (`COMMUNITY_URL`).
7. **Daily push** for 14 days when matches are open.
8. **/baja** deletes the number, withdraws consent and sends an `optout` event to the webhook.

## Leads

- **Webhook (optional):** every new / updated lead and every opt-out is POSTed as JSON to `LEAD_WEBHOOK_URL` (LeadDeus, Make.com…): `telegram_id, username, first_name, phone, phone_source, es_mobile, src, variant, consent_at, consent_version, picks, score_user, score_ai`.
- **/export** (admins) — CSV of all leads; **/export <source>** — one source only, for the batch testing by source (never mix sources in one batch).
- **/stats** — by source × variant: starts, users who picked, asked, leads, Spanish mobile leads, opt-outs, blocked.

## Bot profile

Name chosen against SPY_TG (Nov 2026): in Spanish Telegram ads "club privado", "grupo privado", "exclusivo" and "VIP" are used by trading-signal and paid-tipster channels with fake scarcity ("30 plazas gratis y luego 19,99 €"). "Palco Privado" keeps the private-club feel with a football image, and the copy says the opposite of those channels: no gifted tips, no limited spots.

- **Name:** Palco Privado · Tú vs IA
- **Username (check availability):** `@PalcoPrivadoBot`, `@palco_privado_bot`, `@palcoprivado_ia_bot`
- **About (≤120):** Tu palco privado de LaLiga y Champions: tú eliges el resultado, 4 modelos de IA eligen el suyo. 18+
- **Description (≤512):**
  > Bienvenido al Palco Privado.
  >
  > Aquí no te regalamos pronósticos: los haces tú. Cada jornada eliges cómo acaban los partidos de LaLiga y Champions y después ves qué eligieron nuestros modelos de IA y por qué.
  >
  > Tras cada partido: acierto o fallo, tu racha y el marcador Tú vs IA. Top semanal del palco.
  >
  > Gratis. Sin premios ni plazas limitadas: entra quien sabe de fútbol. 18+
- **Avatar:** dark-green velvet of a stadium box, a large football half made of glowing neural-network lines. No text.

## Ads (ES, ≤160 chars, tag `?start=es_p<code>`)

| Code | Text | Angle | Target |
| --- | --- | --- | --- |
| p1 | Entra al Palco Privado: tú eliges cómo acaba [partido], 4 modelos de IA eligen el suyo. El marcador manda ⚽ | Match + mechanism | football channels |
| p2 | Aquí no se regalan pronósticos: los haces tú. Elige resultados de LaLiga y compite contra la IA. | Contrast with tipsters | football channels |
| p3 | Todos dicen que lo vieron venir. En el Palco se apunta: tu pronóstico, el de la IA y el resultado final. | Identification | broad |
| p4 | ¿Lees LaLiga mejor que una IA? Palco Privado: cada jornada, tú contra 4 modelos. Gratis ⚽ | Challenge | broad |
| p5 | Sin plazas limitadas ni «cuotones» regalados. Eliges resultado, la IA elige el suyo y el partido decide. | Honesty | football channels |
| p6 | La IA ya tiene su resultado para [partido]. ¿Y tú? Haz tu pronóstico en el Palco y compara. | Curiosity | broad |
| p7 | Para los que analizan antes del pitido inicial: elige el resultado y compáralo con 4 modelos de IA. | Identification | broad |
| p8 | Tu racha contra la IA empieza la próxima jornada. Palco Privado: gratis, un toque por partido. | Ease | broad |

Fill `[partido]` with a real fixture on the day; on Monday–Tuesday prefer p3, p4, p7, p8. If moderation rejects "cuotones" in p5, use "sin pronósticos de pago". No ad uses "apuesta", bonuses or scarcity — it's a free game open to everyone.

Start test: contrast (p2, p5 in football channels) vs challenge (p4, p8 broad) vs identification (p3, p7). Judge by cost per WhatsApp number; export each batch with `/export es_p<code>`.

## Mini app (same service, same domain)

The bot's Express server also serves the mini app — nothing extra to deploy:

| Path | What |
| --- | --- |
| `/app/` | The game: match tickets, pick home / draw / away, AI reveal after your pick, Tú–IA scoreboard, results, weekly top |
| `/app/privacy`, `/app/terms` | Privacy policy and terms (Spanish), filled from `COMPANY_*`, `PRIVACY_EMAIL`, `LEGAL_UPDATED` |
| `/api/*` | JSON API; every call is authenticated with Telegram `initData` (HMAC with the bot token, max age 24 h) |

Same database, same game: a pick made in the app is graded by the same scheduler; the user gets the result in the bot chat if they allowed messages (`allows_write_to_pm`, or the "Avisarme en Telegram" button → `requestWriteAccess`). Users who never allowed messages are not messaged and not counted as blocked. `/stats` shows `via app` per source.

**White-hat by design (for mini-app moderation):** no betting words, no operator, no bonus, no prizes, no money; footer says "free football prediction game, no real money, not a bookmaker"; terms state no affiliation with LaLiga / UEFA / clubs; the AI pick is shown only after the user picks; WhatsApp is an optional form with two unticked boxes (18+, consent) and a privacy link; one-tap opt-out deletes the number. The community link (Apuestas Guru) is **not** shown in the app — only in the bot after the number is saved.

### Setup

1. Railway variables: `PUBLIC_URL` (the service domain), `BOT_USERNAME`, `PRIVACY_EMAIL` (shown in the privacy page — required before launch), optionally `COMPANY_*`, `LEGAL_UPDATED`. With `PUBLIC_URL` set, `PRIVACY_URL` defaults to `<PUBLIC_URL>/app/privacy` (also used in the bot's consent text).
2. The bot sets a **"Jugar"** menu button that opens `<PUBLIC_URL>/app/` on start.
3. BotFather → `/newapp` → choose the bot → title "Palco Privado", short description, 640×360 image, URL `<PUBLIC_URL>/app/`, short name e.g. `palco`. Direct link: `https://t.me/<BOT_USERNAME>/palco`.
4. Telegram Ads to the mini app: `https://t.me/<BOT_USERNAME>/palco?startapp=es_app<code>` — the start param becomes the user's source (same rules as `/start`: letters, digits, `_`, `-`, up to 64), so `/export es_app1` gives that batch.
5. BotFather → `/setprivacy_policy`-style field in the bot profile (Bot Settings → Privacy Policy) → `<PUBLIC_URL>/app/privacy`.

**Have a lawyer read `public/privacy.html` and `public/terms.html` before launch** — they're a reasonable GDPR-shaped draft, not legal advice. In particular: the list of processors (hosting, WhatsApp sending platform), data transfers outside the EEA, and retention periods must match what you actually use.

### Mini app tests

`npm test` runs both suites; `test/webapp.js` covers initData validation (valid / tampered / wrong token / expired), 401 without auth, static pages + CSP, legal pages rendering, registration from the app with source and message permission, picks and duplicates, AI hidden before the pick, grading for app users without message permission, history, WhatsApp consent / invalid phone / masking / webhook, opt-out, write-access grant, top without ids.

## Data source

`SETS_URL` + `SETS_TOKEN` — the football predictions export. Football has three outcomes; `src/api.js → normalizeSet()` maps picks to home / draw / away (team name, "1/X/2", "draw", "empate"…) and takes the result from `result.winner`/`outcome` or from the score ("2-1"). Check it against one real record before launch; `SETS_MOCK=1` runs on `fixtures/sets.sample.json`.

## Deploy (Railway)

Volume at `/data`, variables from `.env.example` (set `PRIVACY_URL` before collecting numbers — the bot warns at startup if it's empty), `npm start` (long polling).

## Tests

`npm test` — offline: phone normalization, 3-way normalizer, slate filters, reveal, A/B ask timing, consent, own-contact check, typed numbers and updates, cancel / invalid input, lock, grading with draws, late asks and the 3-ask limit, /baja + webhook, CSV export with formula guard, stats, blocked users.
