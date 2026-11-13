/**
 * Веб-приложение для приёма лидов от Telegram-бота.
 * Вставляется в саму таблицу: Расширения -> Apps Script.
 *
 * Как работает:
 *  - принимает POST с {secret, rows:[{...}]}
 *  - пишет во вкладку TAB_NAME, сопоставляя поля со строкой заголовков (timestamp, phone, quiz_id ...)
 *  - если в этой вкладке нет колонки "phone", НЕ портит его, а создаёт отдельный лист FALLBACK_TAB
 *  - дубликаты по номеру телефона пропускает
 */
const TAB_NAME = 'Untitled';     // имя вкладки, куда падают лиды
const FALLBACK_TAB = 'Chollos bot';
const FALLBACK_HEADERS = [
  'timestamp', 'lead_id', 'quiz_id', 'geo', 'club', 'email', 'phone', 'whatsapp_consent',
  'favourite_team', 'bet_frequency', 'answers_json', 'consent', 'consent_text_version',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid',
  'brand', 'landing_url', 'referrer', 'telegram_id', 'username', 'first_name', 'source'
];

function doPost(e) {
  const out = (o) => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  try {
    const body = JSON.parse(e.postData.contents);
    const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
    if (!secret || body.secret !== secret) return out({ ok: false, error: 'forbidden' });

    const lock = LockService.getScriptLock();
    lock.waitLock(20000); // два лида одновременно не перепишут друг друга
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const tz = ss.getSpreadsheetTimeZone();
      let sheet = ss.getSheetByName(TAB_NAME);
      let headers = readHeaders(sheet);

      if (headers.indexOf('phone') === -1) {
        sheet = ss.getSheetByName(FALLBACK_TAB) || ss.insertSheet(FALLBACK_TAB);
        if (sheet.getLastRow() === 0) sheet.appendRow(FALLBACK_HEADERS);
        headers = readHeaders(sheet);
      }

      const phoneIdx = headers.indexOf('phone');
      const lastRow = sheet.getLastRow();
      const known = new Set(
        lastRow > 1
          ? sheet.getRange(2, phoneIdx + 1, lastRow - 1, 1).getValues().map((r) => digits(r[0]))
          : []
      );

      let added = 0, skipped = 0;
      (body.rows || []).forEach((row) => {
        const d = digits(row.phone);
        if (!d || known.has(d)) { skipped++; return; }
        const r = {};
        Object.keys(row).forEach((k) => { r[k] = row[k]; });
        if (r.timestamp) r.timestamp = Utilities.formatDate(new Date(r.timestamp), tz, 'dd/MM/yyyy HH:mm:ss');
        const values = headers.map((h) => (r[h] === undefined || r[h] === null ? '' : r[h]));
        const target = sheet.getLastRow() + 1;
        sheet.getRange(target, phoneIdx + 1).setNumberFormat('@'); // иначе "+34..." превратится в число
        sheet.getRange(target, 1, 1, values.length).setValues([values]);
        known.add(d);
        added++;
      });
      return out({ ok: true, added: added, skipped: skipped, tab: sheet.getName() });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function readHeaders(sheet) {
  if (!sheet || sheet.getLastColumn() === 0) return [];
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h).trim());
}

function digits(v) {
  return String(v === undefined || v === null ? '' : v).replace(/\D/g, '');
}
