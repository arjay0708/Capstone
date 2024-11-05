const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const pool = require('./connection'); // Make sure this points to your database connection
require('dotenv').config(); // Ensure you have dotenv installed

// Customer registration endpoint
router.post('/register', async (req, res) => {
    const { username, password, fname, lname, email, address, phone } = req.body;

    try {
        // Ensure required fields are provided
        if (!username || !password || !fname || !lname || !email) {
            return res.status(400).send('Missing required fields');
        }

        // Check if the customer already exists (check both username and email)
        const [existingAccount] = await pool.query('SELECT * FROM Accounts WHERE username = ? OR email = ?', [username, email]);

        if (existingAccount.length > 0) {
            return res.status(409).send('Account with this username or email already exists');
        }

        // Hash the password
        const hashedPassword = await bcrypt.hash(password, 12); // Use a salt round of 12 for security

        // Insert the new customer into the database
        const [result] = await pool.query(
            'INSERT INTO Accounts (username, password, fname, lname, email, address, phone, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [username, hashedPassword, fname, lname, email, address, phone, 'customer']
        );

        if (result.affectedRows > 0) {
            return res.status(201).send('Customer registered successfully');
        } else {
            throw new Error('Failed to register customer');
        }
    } catch (error) {
        console.error('Error during customer registration:', error);
        return res.status(500).send('Server error');
    }
});

// Customer login endpoint
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        if (!username || !password) {
            return res.status(400).send('Username and password are required');
        }

        // Query to get the customer by username and ensure the role is 'customer'
        const [results] = await pool.query(
            'SELECT * FROM Accounts WHERE username = ? AND role = "customer"', 
            [username]
        );

        if (results.length === 0) {
            return res.status(401).send('Invalid username or password');
        }

        const match = await bcrypt.compare(password, results[0].password);
        if (!match) {
            return res.status(401).send('Invalid username or password');
        }

        const token = jwt.sign({ accountId: results[0].account_id }, process.env.JWT_SECRET_KEY, { expiresIn: '1h' }); // Use environment variable for secret key

        res.status(200).json({ token });
    } catch (error) {
        console.error('Error during authentication:', error);
        res.status(500).send('Server error');
    }
});

module.exports = router;
