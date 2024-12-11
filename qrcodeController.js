const express = require('express');
const router = express.Router();
const pool = require('./connection');
const cloudinary = require('cloudinary').v2; // Use CommonJS require syntax
const qr = require('qr-image');
const path = require('path');
const fs = require('fs');

require('dotenv').config();


// Route to retrieve all QR codes from the database
router.get('/', async (req, res) => {
    try {
        const [results] = await pool.query('SELECT * FROM QRCode');
        res.status(200).json(results);
    } catch (err) {
        res.status(500).send('Error retrieving QR codes');
    }
});

// Route to retrieve a specific QR code by ID
router.get('/:id', async (req, res) => {
    const qrId = req.params.id;
    try {
        const [results] = await pool.query('SELECT * FROM QRCode WHERE qr_id = ?', [qrId]);
        if (results.length === 0) {
            return res.status(404).send('QR code not found');
        }
        res.status(200).json(results[0]);
    } catch (err) {
        res.status(500).send('Error retrieving QR code');
    }
});

// Route to create a new QR code entry
router.post('/', async (req, res) => {
    const { productId } = req.body;

    try {
        const [result] = await pool.query('INSERT INTO QRCode (product_id) VALUES (?)', [productId]);
        res.status(201).send(`QR code created with ID: ${result.insertId}`);
    } catch (err) {
        res.status(500).send('Error creating QR code');
    }
});

// Route to delete a QR code entry
router.delete('/:id', async (req, res) => {
    const qrId = req.params.id;
    try {
        const [result] = await pool.query('DELETE FROM QRCode WHERE qr_id = ?', [qrId]);
        res.status(200).send('QR code deleted successfully');
    } catch (err) {
        res.status(500).send('Error deleting QR code');
    }
});

// Route to upload QR code to Cloudinary (with product_id as the filename)
router.post('/upload-qr', async (req, res) => {
    const { productId } = req.body;

    if (!productId) {
        return res.status(400).send('Product ID is required');
    }

    // Generate QR code for the given productId
    const qrURL = `https://gaposource.com/viewshop/inside/${productId}`;
    const qrImage = qr.imageSync(qrURL, { type: 'png' });

    // Upload the QR code to Cloudinary with product_id as the filename
    cloudinary.uploader.upload_stream(
        {
            folder: 'qr-codes',               // Specify the folder in Cloudinary
            public_id: `product_${productId}`, // Use productId as the filename (public_id)
            resource_type: 'image',           // Resource type is image
        },
        async (error, result) => {
            if (error) {
                console.error('Error uploading QR code to Cloudinary:', error);
                return res.status(500).send('Error uploading QR code');
            }

            // Save the QR code URL to the database
            try {
                const qrCodeUrl = result.secure_url;
                await pool.query('UPDATE QRCode SET qr_code_url = ? WHERE product_id = ?', [qrCodeUrl, productId]);

                // Send the Cloudinary URL as a response
                res.status(200).json({ qrCodeUrl });
            } catch (err) {
                console.error('Error updating QR code URL in database:', err);
                res.status(500).send('Error saving QR code URL to database');
            }
        }
    ).end(qrImage); // End the upload stream by sending the QR image
});

// Route to get QR code from Cloudinary (fetch by productId)


// Route to retrieve a specific QR code by ID
router.get('/qr-codes/:id', async (req, res) => {
    const { id } = req.params;
    const qrCodeFolder = path.join(__dirname, 'qr-codes'); // Replace with your actual QR code storage folder
    const qrCodeFileName = `product_${id}.png`; // Local file name pattern
    const qrCodePath = path.join(qrCodeFolder, qrCodeFileName);

    try {
        // Check if the QR code file exists locally
        if (fs.existsSync(qrCodePath)) {
            console.log(`Serving local QR code: ${qrCodePath}`);
            res.setHeader('Content-Disposition', `attachment; filename=${qrCodeFileName}`);
            return res.sendFile(qrCodePath);
        }

        // If the file doesn't exist locally, fetch it from Cloudinary
        const qrCodeUrl = `https://res.cloudinary.com/duqbdikz0/image/upload/v1733890541/qr-codes/${qrCodeFileName}`;
        console.log(`Fetching QR code from URL: ${qrCodeUrl}`);
        const response = await fetch(qrCodeUrl);

        if (!response.ok) {
            console.error(`Failed to fetch QR code from Cloudinary. HTTP status: ${response.status}`);
            return res.status(404).send('QR code not found');
        }

        // Download and save the QR code locally
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        fs.writeFileSync(qrCodePath, buffer);

        // Serve the downloaded QR code
        res.setHeader('Content-Disposition', `attachment; filename=${qrCodeFileName}`);
        res.sendFile(qrCodePath);
    } catch (error) {
        console.error('Error downloading or serving QR code:', error.message);
        res.status(500).send('Error downloading QR code');
    }
});


module.exports = router;
