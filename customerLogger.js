const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

// Log the private key (for debugging)
// console.log('Private Key:', process.env.GOOGLE_CLOUD_PRIVATE_KEY);

// Load the credentials from environment variables
const credentials = {
    client_email: process.env.GOOGLE_CLOUD_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_CLOUD_PRIVATE_KEY.replace(/\\n/g, '\n') // Ensure newlines are correctly handled
};

// Use these credentials for authentication
const auth = new google.auth.JWT(
    credentials.client_email, 
    null, 
    credentials.private_key, 
    ['https://www.googleapis.com/auth/spreadsheets'], 
    null
);

const sheets = google.sheets({ version: 'v4', auth });
const spreadsheetId = '1TQIgaqQZKJrnbN6gV_xjK3FeNT0kiQzWC728tNnWaig'; // Your spreadsheet ID
const sheetName = 'Customer'; // The name of the sheet for customers

// Function to format the timestamp in GMT+8
function formatTimestamp(date) {
    // Adjust the time by adding 8 hours to GMT to get GMT+8
    const adjustedDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);  // Add 8 hours (in milliseconds)

    const year = adjustedDate.getFullYear();
    const month = String(adjustedDate.getMonth() + 1).padStart(2, '0');
    const day = String(adjustedDate.getDate()).padStart(2, '0');
    const hours = String(adjustedDate.getHours()).padStart(2, '0');
    const minutes = String(adjustedDate.getMinutes()).padStart(2, '0');
    const seconds = String(adjustedDate.getSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// Function to log customer activities
async function logCustomerActivity(username, response, action) {
    const timestamp = formatTimestamp(new Date());  // Get current timestamp in 'YYYY-MM-DD HH:mm:ss' format (GMT+8)
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
