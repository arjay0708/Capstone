const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

// Load the credentials
const credentials = JSON.parse(fs.readFileSync(path.join(__dirname, './total-method-444314-e1-0bee22582587.json')));
const auth = new google.auth.JWT(credentials.client_email, null, credentials.private_key, ['https://www.googleapis.com/auth/spreadsheets']);
const sheets = google.sheets({ version: 'v4', auth });
const spreadsheetId = '1TQIgaqQZKJrnbN6gV_xjK3FeNT0kiQzWC728tNnWaig'; // Your spreadsheet ID
const sheetName = 'Employee'; // The name of the sheet for employees/admins

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

// Function to log admin/employee activities
async function logEmployeeActivity(username, role, response, action) {
    const timestamp = formatTimestamp(new Date());
    const data = [[timestamp, username, role, action, response]];

    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${sheetName}!A:E`, // Append data to columns A to E
            valueInputOption: 'RAW',
            resource: { values: data }
        });
        console.log('Logged to Admin sheet successfully.');
    } catch (error) {
        console.error('Error logging employee data:', error);
    }
}

module.exports = {
    logEmployeeActivity
};
