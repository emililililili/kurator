// Kurator -> Google Sheets archive (optional integration).
//
// Receives webhook POSTs from the Worker and mirrors kurate entries into a
// sheet, refreshing scores and pruning recent non-positive picks on each
// digest run. The Worker treats this as best-effort, so script errors never
// affect Slack.
//
// Deploy as a Web App (Deploy -> New deployment -> Web app):
//   Execute as:      Me
//   Who has access:  Anyone
//
// Project Settings -> Script Properties:
//   SHEETS_WEBHOOK_SECRET  (required)  same string set in `wrangler secret put`
//   SHEET_NAME             (optional)  tab to write to; defaults to the first tab

const HEADERS = [
  'timestamp', 'kurator_id', 'kurator_name', 'category', 'title',
  'author', 'link', 'why', 'score', 'message_ts',
];
const COL = {
  TIMESTAMP: HEADERS.indexOf('timestamp'),
  SCORE: HEADERS.indexOf('score'),
  MESSAGE_TS: HEADERS.indexOf('message_ts'),
};
const DEFAULT_WINDOW_DAYS = 14; // fallback if the digest payload omits windowDays

function doPost(e) {
  if (!e || !e.postData || e.postData.type !== 'application/json') {
    return resp_({ ok: false });
  }
  let d;
  try { d = JSON.parse(e.postData.contents); }
  catch (err) { return resp_({ ok: false }); }

  const secret = PropertiesService.getScriptProperties()
    .getProperty('SHEETS_WEBHOOK_SECRET');
  if (!secret || typeof d.secret !== 'string'
      || !timingSafeEqual_(d.secret, secret)) {
    return resp_({ ok: false });
  }

  const sheet = getSheet_();
  if (d.kind === 'entry')  return handleEntry_(sheet, d);
  if (d.kind === 'scores') return handleScores_(sheet, d);
  if (d.kind === 'delete') return handleDelete_(sheet, d);
  return resp_({ ok: false });
}

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const name = PropertiesService.getScriptProperties().getProperty('SHEET_NAME');
  const sheet = (name && ss.getSheetByName(name)) || ss.getSheets()[0];
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS); // fresh sheet
  return sheet;
}

function handleEntry_(sheet, d) {
  // Append with a blank score and placeholder message_ts, then write the
  // message_ts into a text-formatted cell. Slack timestamps look numeric
  // ("1718900000.123456"); without forcing text the sheet rounds them, and
  // later score/delete lookups by message_ts would never match.
  sheet.appendRow([
    d.timestamp, d.kurator_id, d.kurator_name, d.category,
    d.title, d.author, d.link, d.why, '', '',
  ]);
  sheet.getRange(sheet.getLastRow(), COL.MESSAGE_TS + 1)
    .setNumberFormat('@')
    .setValue(String(d.message_ts));
  return resp_({ ok: true });
}

function handleScores_(sheet, d) {
  const data = sheet.getDataRange().getValues();
  const active = new Map((d.active || []).map((a) => [String(a.ts), a.score]));
  const windowDays = Number(d.windowDays) || DEFAULT_WINDOW_DAYS;
  const cutoff = Date.now() - windowDays * 86400000;
  const rowsToDelete = [];
  for (let i = 1; i < data.length; i++) {
    const ts = String(data[i][COL.MESSAGE_TS]);
    if (active.has(ts)) {
      sheet.getRange(i + 1, COL.SCORE + 1).setValue(active.get(ts));
    } else if (new Date(data[i][COL.TIMESTAMP]).getTime() > cutoff) {
      rowsToDelete.push(i + 1); // within the window but not active -> remove
    } // older than the window -> leave as archive
  }
  for (let i = rowsToDelete.length - 1; i >= 0; i--) {
    sheet.deleteRow(rowsToDelete[i]); // bottom-up keeps indices valid
  }
  return resp_({ ok: true });
}

function handleDelete_(sheet, d) {
  const data = sheet.getDataRange().getValues();
  const target = String(d.message_ts);
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][COL.MESSAGE_TS]) === target) {
      sheet.deleteRow(i + 1);
      break;
    }
  }
  return resp_({ ok: true });
}

function timingSafeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function resp_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput('Method not allowed');
}
