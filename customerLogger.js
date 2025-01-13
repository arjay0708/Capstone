const { google } = require('googleapis');

// Retrieve credentials from environment variables
const clientEmail = process.env.GOOGLE_CLOUD_CLIENT_EMAIL;
const privateKey = process.env.GOOGLE_CLOUD_PRIVATE_KEY;
const spreadsheetId = process.env.SPREADSHEET_ID;  // Your spreadsheet ID
const sheetName = 'Customer';  // The name of the sheet for customers

// Set up the JWT client with the service account credentials from environment variables
const auth = new google.auth.JWT(
  clientEmail,
  null,
  privateKey,
  ['https://www.googleapis.com/auth/spreadsheets']
);

const sheets = google.sheets({ version: 'v4', auth });

// Function to format the timestamp
function formatTimestamp(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// Function to log customer activities
async function logCustomerActivity(username, response, action) {
    const timestamp = formatTimestamp(new Date());
    const data = [[timestamp, username, 'customer', action, response]]; // Role is always "customer" here

    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${sheetName}!A:E`, // Append data to columns A to E
            valueInputOption: 'RAW',
            resource: { values: data }
        });
        console.log('Logged to Customer sheet successfully.');
    } catch (error) {
        console.error('Error logging customer data:', error);
    }
}

module.exports = {
    logCustomerActivity
};
