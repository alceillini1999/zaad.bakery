// sheets.js
const { google } = require('googleapis');

let sheetsClientSingleton = null;

async function getSheetsClient() {
  if (sheetsClientSingleton) return sheetsClientSingleton;

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON env var');
  }
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const authClient = await auth.getClient();
  sheetsClientSingleton = google.sheets({ version: 'v4', auth: authClient });
  return sheetsClientSingleton;
}

async function appendRow({ spreadsheetId, range, values }) {
  const sheets = await getSheetsClient();
  return sheets.spreadsheets.values.append({
    spreadsheetId,
    range, // مثال: 'Sales!A:F'
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
}

module.exports = { getSheetsClient, appendRow };
