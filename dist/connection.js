"use strict";
const mysql = require('mysql2');
const nodemailer = require('nodemailer');
const { google } = require('googleapis'); // Import googleapis for OAuth2.0
require('dotenv').config();
// MySQL connection pool setup
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
}).promise();
// Test database connection
pool.getConnection((err, connection) => {
    if (err) {
        console.error('Error connecting to the database:', err);
        return;
    }
    console.log('Connected to the database');
    connection.release(); // Release the connection immediately after getting it
});
module.exports = pool;
