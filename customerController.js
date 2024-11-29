const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const pool = require('./connection'); // Ensure this points to your database connection
const { authMiddleware, roleCheckMiddleware } = require('./authMiddleware'); // Adjust the path if necessary
require('dotenv').config(); // Ensure you have dotenv installed
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid'); // To generate a verification token

// Setup for the email transport (using Gmail in this case)
const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
    },
});

// Define the sendVerificationEmail function
async function sendVerificationEmail(email, fname, verificationToken) {
    const verificationLink = `${process.env.BASE_URL}/customer/verify-email/${verificationToken}`;

    try {
        await transporter.sendMail({
            from: `"SourceGapo Support" <sourcegapo@gmail.com>`, // Display name with a different email
            to: email, // Receiver email
            subject: 'Please verify your email address',
            text: `Hello ${fname},\n\nPlease verify your email address by clicking the link below:\n\n${verificationLink}\n\nThank you!`,
        });
    } catch (error) {
        console.error('Error sending email:', error);
        throw new Error('Error sending verification email');
    }
}

// Customer registration endpoint
router.post('/register', async (req, res) => {
    const { username, password, email, fname, lname } = req.body;

    if (!username || !password || !email || !fname || !lname) {
        return res.status(400).send('Missing required fields');
    }

    try {
        // Check if the email already exists in the Accounts table
        const [existingAccount] = await pool.query('SELECT * FROM Accounts WHERE email = ?', [email]);
        if (existingAccount.length > 0) {
            return res.status(409).send('Email already in use');
        }

        // Hash password before saving to database
        const hashedPassword = await bcrypt.hash(password, 12);

        // Generate a unique verification token
        const verificationToken = uuidv4();

        // Insert new account into the Accounts table
        const [result] = await pool.query(
            'INSERT INTO Accounts (username, password, email, fname, lname, verification_token, is_verified) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [username, hashedPassword, email, fname, lname, verificationToken, false]
        );

        if (result.affectedRows > 0) {
            // Send verification email with a link containing the token
            await sendVerificationEmail(email, fname, verificationToken);
            return res.status(201).send('Registration successful. Please verify your email.');
        } else {
            return res.status(500).send('Error registering account');
        }
    } catch (error) {
        console.error('Registration error:', error);
        return res.status(500).send('Server error');
    }
});

// Email verification endpoint
router.get('/verify-email/:token', async (req, res) => {
    const { token } = req.params;

    try {
        // Find the user by the verification token
        const [user] = await pool.query('SELECT * FROM Accounts WHERE verification_token = ?', [token]);

        if (user.length === 0) {
            return res.status(404).send('Invalid or expired verification token');
        }

        // If user found, update is_verified to true and clear the verification token
        const [updateResult] = await pool.query(
            'UPDATE Accounts SET is_verified = ?, verification_token = NULL WHERE verification_token = ?',
            [true, token]
        );

        if (updateResult.affectedRows > 0) {
            // Send confirmation to user
            return res.status(200).send('Email verified successfully!');
        } else {
            return res.status(500).send('Error updating verification status');
        }
    } catch (error) {
        console.error('Error verifying email:', error);
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

        // Query to get the customer by username, ensure the role is 'customer'
        const [results] = await pool.query(
            'SELECT * FROM Accounts WHERE username = ? AND role = "customer"',
            [username]
        );

        if (results.length === 0) {
            return res.status(401).send('Invalid username or password');
        }

        // Check if the account is verified (1 for verified, 0 for not verified)
        const user = results[0];
        if (user.is_verified === 0) {
            return res.status(401).send('Please verify your email before logging in.');
        }

        // Compare the hashed password with the provided password
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.status(401).send('Invalid username or password');
        }

        // Generate a JWT token upon successful authentication
        const token = jwt.sign({ accountId: user.account_id }, process.env.JWT_SECRET_KEY, { expiresIn: '1h' });

        // Send the token as a response
        res.status(200).json({ token });
    } catch (error) {
        console.error('Error during authentication:', error);
        res.status(500).send('Server error');
    }
});


router.get('/buyer-details', authMiddleware, async (req, res) => {
    const account_id = req.user.account_id; // Retrieved from the middleware (authenticated user)

    try {
        // Query to get the buyer's details using the account_id
        const [results] = await pool.query(
            'SELECT fname, lname, mname, address, phone FROM Accounts WHERE account_id = ?',
            [account_id]
        );

        if (results.length === 0) {
            return res.status(404).json({ message: 'Buyer not found.' });
        }

        // Sending back the buyer's details
        res.status(200).json({
            fname: results[0].fname,
            lname: results[0].lname,
            mname: results[0].mname,
            address: results[0].address,
            phone: results[0].phone
        });
    } catch (error) {
        console.error('Error retrieving buyer details:', error);
        res.status(500).json({ error: 'Error retrieving buyer details' });
    }
});

module.exports = router;
