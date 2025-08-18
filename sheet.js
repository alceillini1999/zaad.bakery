// sheets.js
// Lightweight helper to append rows to Google Sheets

const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');

let sheets = null;
let spreadsheetId = null;
let enabled = false;

async function initSheets() {
  enabled = String(process.env.SHEETS_ENABLED || '').toLowerCase() === 'true';
  spreadsheetId = process.env.SHEETS_SPREADSHEET_ID || '';

  if (!enabled) { console.log('Sheets: disabled'); return; }
  if (!spreadsheetId) { console.warn('Sheets: missing SHEETS_SPREADSHEET_ID'); enabled = false; return; }

  try {
    const auth = new GoogleAuth({
      // Render: ضع GOOGLE_APPLICATION_CREDENTIALS لمسار Secret File
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const client = await auth.getClient();
    sheets = google.sheets({ version: 'v4', auth: client });
    console.log('Sheets: initialized');
  } catch (e) {
    enabled = false;
    console.error('Sheets init error:', e.message);
  }
}

// ensure headers once per sheet (best-effort)
async function ensureHeader(sheet, header) {
  if (!enabled || !sheets) return;
  try {
    const r = await sheets.spreadsheets.values.get({
      spreadsheetId, range: `${sheet}!A1:Z1`,
    });
    const values = r.data.values || [];
    if (!values.length || !values[0] || values[0].join('').trim() === '') {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheet}!A1:${String.fromCharCode(64 + header.length)}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [header] },
      });
      console.log(`Sheets: header written for ${sheet}`);
    }
  } catch (_) { /* ignore */ }
}

async function appendRow(sheet, header, rowValues) {
  if (!enabled || !sheets) return;
  try {
    await ensureHeader(sheet, header);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${sheet}!A:Z`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowValues] },
    });
  } catch (e) {
    console.error(`Sheets append error (${sheet}):`, e.message);
  }
}

module.exports = { initSheets, appendRow };
