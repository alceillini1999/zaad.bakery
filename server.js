// server.js — Zaad Bakery Data Entry (Light UI)
// Backend: Express + Google Sheets

import express from 'express';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ---------- Basic Auth ----------
const PUBLIC_AUTH_USER = process.env.PUBLIC_AUTH_USER || 'admin';
const PUBLIC_AUTH_PASS = process.env.PUBLIC_AUTH_PASS || 'password';

app.use((req, res, next) => {
  // skip auth for healthz
  if (req.path === '/healthz') return next();

  // only protect app/api, allow static assets (css/js/img) to pass
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Zaad Bakery"');
    return res.status(401).end('Auth required');
  }
  const creds = Buffer.from(h.split(' ')[1] || '', 'base64').toString();
  const [u, p] = creds.split(':');
  if (u === PUBLIC_AUTH_USER && p === PUBLIC_AUTH_PASS) return next();

  res.set('WWW-Authenticate', 'Basic realm="Zaad Bakery"');
  return res.status(401).end('Invalid credentials');
});

// ---------- Static / JSON ----------
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Google Sheets ----------
const SHEETS_ENABLED = String(process.env.SHEETS_ENABLED || 'true').toLowerCase() === 'true';
const SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID || '';
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';

let sheetsClient = null;

async function getSheets() {
  if (!SHEETS_ENABLED) return null;
  if (!SPREADSHEET_ID) throw new Error('Missing SHEETS_SPREADSHEET_ID');
  if (!GOOGLE_APPLICATION_CREDENTIALS) throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS');

  // ensure credentials file exists (on Render: /etc/secrets/google.json)
  if (!fs.existsSync(GOOGLE_APPLICATION_CREDENTIALS)) {
    throw new Error(`Service account file not found: ${GOOGLE_APPLICATION_CREDENTIALS}`);
  }

  if (!sheetsClient) {
    const auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
  }
  return sheetsClient;
}

async function appendRow(tabName, values) {
  if (!SHEETS_ENABLED) return { ok: true, skipped: true };
  const sheets = await getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${tabName}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });
  return { ok: true };
}

// ---------- Helpers ----------
function nowISO() {
  return new Date().toISOString();
}
function toNum(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

// ---------- APIs ----------
app.get('/healthz', (_, res) => res.json({ ok: true, ts: nowISO() }));

// Sales: POST /api/sales
// Body: { amount?, product?, quantity?, unitPrice?, method, tillNumber?, note? }
app.post('/api/sales', async (req, res) => {
  try {
    const {
      product = '',
      quantity = '',
      unitPrice = '',
      amount,
      method = 'Cash',
      tillNumber = '',
      note = '',
    } = req.body || {};

    const q = toNum(quantity);
    const up = toNum(unitPrice);
    const gross = amount !== undefined ? toNum(amount) : (q * up);

    const row = [
      nowISO(),       // A: DateTime
      product,        // B: Product
      q,              // C: Quantity
      up,             // D: UnitPrice
      gross,          // E: GrossAmount
      method,         // F: PaymentMethod
      tillNumber,     // G: TillNumber
      note,           // H: Note
    ];
    await appendRow('Sales', row);
    res.json({ ok: true, row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Expenses: POST /api/expenses
// Body: { amount, category, method, note }
app.post('/api/expenses', async (req, res) => {
  try {
    const { amount = 0, category = '', method = 'Cash', note = '' } = req.body || {};
    const row = [
      nowISO(),            // A: DateTime
      toNum(amount),       // B: Amount
      method,              // C: PayMethod
      category,            // D: Item/Category
      note,                // E: Note
    ];
    await appendRow('Expenses', row);
    res.json({ ok: true, row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Cash Count: POST /api/cashcount
// Body: { CountDate?, Session: 'Morning'|'Evening', denominations: {1000,500,200,100,50,40,20,10,5,1}, note? }
app.post('/api/cashcount', async (req, res) => {
  try {
    const { CountDate, Session = 'Morning', denominations = {}, Note = '' } = req.body || {};
    const den = {
      1000: toNum(denominations[1000]),
      500: toNum(denominations[500]),
      200: toNum(denominations[200]),
      100: toNum(denominations[100]),
      50: toNum(denominations[50]),
      40: toNum(denominations[40]),
      20: toNum(denominations[20]),
      10: toNum(denominations[10]),
      5: toNum(denominations[5]),
      1: toNum(denominations[1]),
    };
    const total =
      1000 * den[1000] + 500 * den[500] + 200 * den[200] + 100 * den[100] +
      50 * den[50] + 40 * den[40] + 20 * den[20] + 10 * den[10] + 5 * den[5] + 1 * den[1];

    const row = [
      (CountDate ? new Date(CountDate).toISOString().slice(0, 10) : nowISO().slice(0, 10)), // A: Date (YYYY-MM-DD)
      Session,                 // B
      den[1000], den[500], den[200], den[100], den[50], den[40], den[20], den[10], den[5], den[1], // C..L
      total,                   // M: CashTotal
      Note || '',              // N: Note
    ];
    await appendRow('CashCount', row);
    res.json({ ok: true, total, row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Mobile Ledger: POST /api/mobile/ledger
// Body: { Channel: 'Withdraw Cash'|'Buy Goods'|'Send Money', OpeningBalance?, OutflowWithdrawn?, ClosingBalanceActual?, Note? }
app.post('/api/mobile/ledger', async (req, res) => {
  try {
    const {
      Channel = 'Withdraw Cash',
      OpeningBalance = 0,
      OutflowWithdrawn = 0,
      ClosingBalanceActual = 0,
      Note = '',
    } = req.body || {};

    // Expected = Opening + (sales inflow is tracked in "Sales" tab, but we keep zero here) - Outflow - expenses on that channel (not provided)
    const ClosingBalanceExpected = toNum(OpeningBalance) - toNum(OutflowWithdrawn);
    const Variance = toNum(ClosingBalanceActual) - ClosingBalanceExpected;

    const row = [
      nowISO().slice(0, 10),    // A: Date
      Channel,                  // B
      toNum(OpeningBalance),    // C
      0,                        // D: InflowFromSales (kept 0; reporting can aggregate from Sales tab)
      toNum(OutflowWithdrawn),  // E
      0,                        // F: ExpensesOnChannel (kept 0)
      ClosingBalanceExpected,   // G
      toNum(ClosingBalanceActual), // H
      Variance,                 // I
      Note,                     // J
    ];
    await appendRow('MobileLedger', row);
    res.json({ ok: true, variance: Variance, row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Fallback: serve the app ----------
app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const ip = process.env.RENDER ? '0.0.0.0' : 'localhost';
  console.log(`Zaad Bakery server listening on http://${ip}:${PORT}`);
});