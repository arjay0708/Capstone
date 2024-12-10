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
    tls: {
        rejectUnauthorized: false, // Allow self-signed certificates
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
    const { username, password, email, fname, lname, address, age, phone } = req.body;

    // Validate required fields
    if (!username || !password || !email || !fname || !lname || !address || !age || !phone) {
        return res.status(400).send('Missing required fields');
    }

    try {
        // Check if the email or username already exists in the Accounts table
        const [existingEmail] = await pool.query('SELECT * FROM Accounts WHERE email = ?', [email]);
        if (existingEmail.length > 0) {
            return res.status(409).send('Email already in use');
        }

        const [existingUsername] = await pool.query('SELECT * FROM Accounts WHERE username = ?', [username]);
        if (existingUsername.length > 0) {
            return res.status(409).send('Username already in use');
        }

        // Hash password before saving to the database
        const hashedPassword = await bcrypt.hash(password, 12);

        // Generate a unique verification token
        const verificationToken = uuidv4();

        // Insert new account into the Accounts table
        const [result] = await pool.query(
            'INSERT INTO Accounts (username, password, email, fname, lname, address, age, phone, verification_token, is_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [username, hashedPassword, email, fname, lname, address, age, phone, verificationToken, false]
        );

        if (result.affectedRows > 0) {
            // Send verification email with a link containing the token
            await sendVerificationEmail(email, fname, verificationToken);
            return res.status(201).json({ message: 'Registration successful. Please verify your email.' });
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

        // Send the token, username, and profile image as a response
        res.status(200).json({
            token,
            accountId: user.account_id,
            role: user.role,
            username: user.username,
            profileImage: user.profile_image || '/assets/default-profile.png', // default image if not available
        });
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

router.get('/user-orders/:accountId', authMiddleware, async (req, res) => {
    const accountId = req.params.accountId;

    try {
        // Retrieve orders for the specific user
        const [orders] = await pool.query(`
            SELECT 
                Orders.*,
                Orders.order_status,
                CONCAT(accounts.fname, ' ', accounts.lname) AS name,
                accounts.email,
                accounts.phone,
                accounts.address
            FROM Orders
            JOIN accounts ON Orders.account_id = accounts.account_id
            WHERE Orders.account_id = ?
        `, [accountId]);

        if (orders.length === 0) {
            return res.status(404).json({ message: 'No orders found for this user.' });
        }

        // Map through the orders to fetch their items
        const ordersWithItems = await Promise.all(orders.map(async (order) => {
            const [orderItems] = await pool.query(`
                SELECT 
                    OrderItem.order_item_id,
                    OrderItem.product_variant_id,
                    OrderItem.quantity,
                    OrderItem.price_at_purchase,
                    Product.Pname,
                    Product.images
                FROM OrderItem
                JOIN ProductVariant ON OrderItem.product_variant_id = ProductVariant.variant_id
                JOIN Product ON ProductVariant.product_id = Product.product_id
                WHERE OrderItem.order_id = ?
            `, [order.order_id]);

            const itemsWithImages = orderItems.map(item => ({
                ...item,
                images: JSON.parse(item.images).map(image => `/uploads/${image}`),
                price_at_purchase: parseFloat(item.price_at_purchase)
            }));

            return {
                ...order,
                items: itemsWithImages
            };
        }));

        return res.status(200).json({ orders: ordersWithItems });
    } catch (error) {
        console.error('Error fetching user orders:', error);
        res.status(500).json({ error: 'An error occurred while retrieving user orders.' });
    }
});

router.put('/edit-profile', authMiddleware, async (req, res) => {
    const { username, email, phone, oldPassword, newPassword } = req.body;
    const accountId = req.user.account_id; // Retrieved from authMiddleware

    try {
        // Fetch the current user
        const [userResult] = await pool.query('SELECT * FROM Accounts WHERE account_id = ?', [accountId]);
        if (userResult.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }
        const user = userResult[0];

        const updateFields = [];
        const params = [];

        // Update username (only if it's provided and has not been updated before)
        if (username) {
            if (user.username_updated) {
                return res.status(400).json({ message: 'Username can only be updated once.' });
            }
            updateFields.push('username = ?');
            params.push(username);
        }

        // Update email
        if (email) {
            updateFields.push('email = ?');
            params.push(email);
        }

        // Update phone number
        if (phone) {
            if (!/^[0-9]{11}$/.test(phone)) {
                return res.status(400).json({ message: 'Phone number must be 11 digits.' });
            }
            updateFields.push('phone = ?');
            params.push(phone);
        }

        // Update password
        if (oldPassword && newPassword) {
            const isMatch = await bcrypt.compare(oldPassword, user.password);
            if (!isMatch) {
                return res.status(401).json({ message: 'Old password is incorrect.' });
            }
            if (newPassword.length < 8) {
                return res.status(400).json({ message: 'New password must be at least 8 characters long.' });
            }
            const hashedPassword = await bcrypt.hash(newPassword, 12);
            updateFields.push('password = ?');
            params.push(hashedPassword);
        }

        if (updateFields.length === 0) {
            return res.status(400).json({ message: 'No updates provided.' });
        }

        // Append the accountId for the WHERE clause
        params.push(accountId);

        // Perform the update query
        const updateQuery = `UPDATE Accounts SET ${updateFields.join(', ')} WHERE account_id = ?`;
        const [result] = await pool.query(updateQuery, params);

        if (result.affectedRows > 0) {
            return res.status(200).json({ message: 'Profile updated successfully.' });
        } else {
            return res.status(500).json({ message: 'Failed to update profile.' });
        }
    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});




module.exports = router;
