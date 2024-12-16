const express = require('express');
const router = express.Router();
const axios = require('axios');
const pool = require('./connection');  // Your database connection

// Define the PayMongo secret key
const PAYMONGO_API_KEY = 'sk_test_MSHiWbz5qZgiBEirfabCsFqC';  // Your PayMongo Secret Key

router.post('/payment', async (req, res) => {
    const { amount, username, paymentMethod } = req.body;  // Extract payment details

    try {
        // Get account ID for the username
        const [accountDetails] = await pool.query('SELECT account_id FROM Accounts WHERE username = ?', [username]);

        if (accountDetails.length === 0) {
            return res.status(404).json({ message: 'Username not found' });
        }

        const accountId = accountDetails[0].account_id;  // Account ID for the username

        // Prepare payment intent data
        const paymentIntentData = {
            data: {
                attributes: {
                    amount: amount * 100,  // Amount in cents
                    currency: 'PHP',
                    payment_method_allowed: [paymentMethod || 'gcash'],  // Default to 'gcash'
                    description: `Payment for Order from Account #${accountId} (Username: ${username})`
                }
            }
        };

        // Make API request to PayMongo to create the payment intent
        const response = await axios.post(
            'https://api.paymongo.com/v1/payment_intents',
            paymentIntentData,
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(PAYMONGO_API_KEY + ':').toString('base64')}`,
                    'Content-Type': 'application/json',
                }
            }
        );

        // Extract payment URL from the response
        const paymentUrl = response.data.data.attributes.links[0].href;

        // Return payment URL
        return res.status(200).json({
            message: 'Payment intent created successfully.',
            payment_url: paymentUrl,
        });
    } catch (error) {
        console.error('Payment creation failed:', error);
        return res.status(500).json({
            message: 'Error creating payment intent.',
            error: error.message,
        });
    }
});

module.exports = router;

