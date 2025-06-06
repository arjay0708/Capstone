const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('./connection'); // Ensure this points to your database connection
const { authMiddleware, roleCheckMiddleware } = require('./authMiddleware'); // Adjust the path if necessary
require('dotenv').config(); // Ensure you have dotenv installed
const nodemailer = require('nodemailer');
const { logCustomerActivity } = require('./customerLogger');

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
    const verificationLink = `https://capstone-orcin.vercel.app/customer/verify-email/${verificationToken}`;

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
            // Log registration activity
            await logCustomerActivity(username, 'Registration successful', 'REGISTER');

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

        // Query to get the customer by username
        const [results] = await pool.query(
            'SELECT * FROM Accounts WHERE username = ? AND role = "customer"',
            [username]
        );

        if (results.length === 0) {
            return res.status(401).send('Invalid username or password');
        }

        const user = results[0];

        if (user.is_verified === 0) {
            return res.status(401).send('Please verify your email before logging in.');
        }

        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.status(401).send('Invalid username or password');
        }

        // Log successful login attempt
        console.log('Attempting to log customer activity...');
        await logCustomerActivity(username, 'Login successful', 'LOGIN');
        console.log('Logged customer activity');

        const token = jwt.sign({ accountId: user.account_id }, process.env.JWT_SECRET_KEY, { expiresIn: '1h' });

        res.status(200).json({
            token,
            accountId: user.account_id,
            role: user.role,
            username: user.username,
            profileImage: user.profile_image || '/assets/default-profile.png',
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
                CONCAT(Accounts.fname, ' ', Accounts.lname) AS name,
                Accounts.email,
                Accounts.phone,
                Accounts.address
            FROM Orders
            JOIN Accounts ON Orders.account_id = Accounts.account_id
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
                    Product.images,
                    ProductVariant.size
                FROM OrderItem
                JOIN ProductVariant ON OrderItem.product_variant_id = ProductVariant.variant_id
                JOIN Product ON ProductVariant.product_id = Product.product_id
                WHERE OrderItem.order_id = ?
            `, [order.order_id]);

            // Process images and other item data
            const itemsWithImages = orderItems.map(item => {
                // Ensure the images are parsed as an array and then converted to Cloudinary URLs
                const imageUrls = JSON.parse(item.images).map(imagePath => {
                    // Assuming the image path is relative to the Cloudinary upload folder
                    return `https://res.cloudinary.com/duqbdikz0/image/upload/v1733890541/${imagePath}`;
                });

                return {
                    ...item,
                    images: imageUrls,  // Update images to Cloudinary URLs
                    price_at_purchase: parseFloat(item.price_at_purchase)
                };
            });

            return {
                ...order,
                items: itemsWithImages  // Add items with images to the order
            };
        }));

        return res.status(200).json({ orders: ordersWithItems });
    } catch (error) {
        console.error('Error fetching user orders:', error);
        res.status(500).json({ error: 'An error occurred while retrieving user orders.' });
    }
});

router.put('/edit-profile', authMiddleware, async (req, res) => {
    const { username, phone, oldPassword, newPassword } = req.body;
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

        if (username) {
            if (user.username_updated) {
                return res.status(400).json({ message: 'Username can only be updated once.' });
            }
            updateFields.push('username = ?');
            params.push(username);
        }

        // Removed email field from update logic
        // If you want to log profile changes, you can track username and phone updates below

        if (phone) {
            if (!/^[0-9]{11}$/.test(phone)) {
                return res.status(400).json({ message: 'Phone number must be 11 digits.' });
            }
            updateFields.push('phone = ?');
            params.push(phone);
        }

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

        params.push(accountId);

        const updateQuery = `UPDATE Accounts SET ${updateFields.join(', ')} WHERE account_id = ?`;
        const [result] = await pool.query(updateQuery, params);

        if (result.affectedRows > 0) {
            // Log profile update activity without email change
            await logCustomerActivity(username, 'Profile updated successfully', 'UPDATE_PROFILE');
            return res.status(200).json({ message: 'Profile updated successfully.' });
        } else {
            return res.status(500).json({ message: 'Failed to update profile.' });
        }
    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});




router.post('/retrieve-account', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ message: 'Email is required.' });
    }

    try {
        // Check if the email exists in the database
        const [results] = await pool.query(
            'SELECT username, password, verification_token FROM Accounts WHERE email = ?',
            [email]
        );

        if (results.length === 0) {
            return res.status(404).json({ message: 'No account found with this email.' });
        }

        const account = results[0];

        // Generate a temporary password (e.g., 12 random characters)
        const temporaryPassword = crypto.randomBytes(6).toString('hex'); // 12-character password (6 bytes hex)

        // Hash the temporary password before saving it (use bcrypt to securely hash it)
        const hashedTemporaryPassword = await bcrypt.hash(temporaryPassword, 12);

        // Update the account with the hashed temporary password (optional: mark it as 'temporary')
        await pool.query(
            'UPDATE Accounts SET password = ?, is_temporary = 1 WHERE email = ?',
            [hashedTemporaryPassword, email]
        );

        // Email content
        const emailSubject = 'Temporary Password for Your Account';
        const emailBody = `
            Hello,

            Here is your temporary password for your account:

            Temporary Password: ${temporaryPassword}

            Please use this password to log in. Once logged in, you will be prompted to change your password.

            If you did not request this, please ignore this email.

            Regards,
            Your App Support Team
        `;

        // Send email
        await transporter.sendMail({
            from: `"Your App Support" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: emailSubject,
            text: emailBody,
        });

        return res.status(200).json({
            message: 'A temporary password has been sent to your registered email.',
        });
    } catch (error) {
        console.error('Error retrieving account details:', error);
        return res.status(500).json({ message: 'Internal server error.' });
    }
});


router.post('/reset-password/:token', async (req, res) => {
    const { token } = req.params;
    const { newPassword, confirmPassword } = req.body;

    // Check if the new password and confirm password are provided
    if (!newPassword || !confirmPassword) {
        return res.status(400).json({ message: 'New password and confirm password are required.' });
    }

    // Check if the new password and confirm password match
    if (newPassword !== confirmPassword) {
        return res.status(400).json({ message: 'New password and confirm password do not match.' });
    }

    // Password validation (at least 1 uppercase, 1 number, 1 special character)
    const passwordRegex = /^(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*])[A-Za-z\d!@#$%^&*]{8,}$/;
    if (!passwordRegex.test(newPassword)) {
        return res.status(400).json({
            message: 'Password must be at least 8 characters long and contain at least one uppercase letter, one number, and one special character.'
        });
    }

    try {
        // Find the user by the reset token
        const [results] = await pool.query(
            'SELECT * FROM Accounts WHERE verification_token = ?',
            [token]
        );

        if (results.length === 0) {
            return res.status(404).json({ message: 'Invalid or expired token.' });
        }

        const account = results[0];

        // Hash the new password
        const hashedPassword = await bcrypt.hash(newPassword, 12);

        // Update the user's password (no need to reset the token here)
        const [updateResult] = await pool.query(
            'UPDATE Accounts SET password = ? WHERE account_id = ?',
            [hashedPassword, account.account_id]
        );

        if (updateResult.affectedRows > 0) {
            return res.status(200).json({ message: 'Password has been reset successfully.' });
        } else {
            return res.status(500).json({ message: 'Failed to reset password.' });
        }
    } catch (error) {
        console.error('Error resetting password:', error);
        return res.status(500).json({ message: 'Internal server error.' });
    }
});

module.exports = router;
