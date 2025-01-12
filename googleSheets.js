const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

// Load the credentials file (service account JSON file)
const credentials = JSON.parse(fs.readFileSync(path.join(__dirname, './total-method-444314-e1-0bee22582587.json')));

// Set up the JWT client with the service account credentials
const auth = new google.auth.JWT(
  credentials.client_email, // Service account email
  null, 
  credentials.private_key, // Private key from the credentials
  ['https://www.googleapis.com/auth/spreadsheets'], // Scope for Google Sheets API
  null
);

// Set up the Google Sheets API client
const sheets = google.sheets({ version: 'v4', auth });

// Specify your spreadsheet ID and the sheet name
const spreadsheetId = '1TQIgaqQZKJrnbN6gV_xjK3FeNT0kiQzWC728tNnWaig';
const sheetName = 'Admin';  // Replace with your sheet name (or create a new one)

// Function to format the timestamp in 'YYYY-MM-DD HH:mm:ss' format
function formatTimestamp(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// Function to log the data (without the account field)
async function logLoginActivity(username, role, response, action) {
    const timestamp = formatTimestamp(new Date());  // Get current timestamp in 'YYYY-MM-DD HH:mm:ss' format

    const data = [
        [timestamp, username, role, action, response]  // Log timestamp, username, role, action, response
    ];

    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: spreadsheetId,  // Your spreadsheet ID
            range: `${sheetName}!A:E`,  // Columns A to E (add an extra column for the action)
            valueInputOption: 'RAW',  // Input type for values (RAW means no formatting)
            resource: {
                values: data  // Data to be added
            }
        });
        console.log('Logged to Google Sheets successfully.');
    } catch (error) {
        console.error('Error logging data to Google Sheets:', error);
    }
}

module.exports = {
    logLoginActivity
};
