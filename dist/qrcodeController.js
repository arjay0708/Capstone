"use strict";
const express = require('express');
const router = express.Router();
const pool = require('./connection');
const QRCode = require('qrcode');
const qr = require('qr-image');
const path = require('path');
const fs = require('fs');
// Retrieve all QR codes
router.get('/', (req, res) => {
    pool.query('SELECT * FROM QRCode', (err, results) => {
        if (err) {
            return res.status(500).send('Error retrieving QR codes');
        }
        res.status(200).json(results);
    });
});
// Retrieve a specific QR code by ID
router.get('/:id', (req, res) => {
    const qrId = req.params.id;
    pool.query('SELECT * FROM QRCode WHERE qr_id = ?', [qrId], (err, results) => {
        if (err) {
            return res.status(500).send('Error retrieving QR code');
        }
        if (results.length === 0) {
            return res.status(404).send('QR code not found');
        }
        res.status(200).json(results[0]);
    });
});
// Create a new QR code
router.post('/', (req, res) => {
    const productId = req.body.productId;
    pool.query('INSERT INTO QRCode (product_id) VALUES (?)', [productId], (err, result) => {
        if (err) {
            return res.status(500).send('Error creating QR code');
        }
        res.status(201).send(`QR code created with ID: ${result.insertId}`);
    });
});
// Delete a QR code
router.delete('/:id', (req, res) => {
    const qrId = req.params.id;
    pool.query('DELETE FROM QRCode WHERE qr_id = ?', [qrId], (err, result) => {
        if (err) {
            return res.status(500).send('Error deleting QR code');
        }
        res.status(200).send('QR code deleted successfully');
    });
});
router.get('/qr-codes/:id', (req, res) => {
    const { id } = req.params;
    // Check if the QR code file exists
    if (fs.existsSync(qrCodePath)) {
        res.setHeader('Content-Disposition', `attachment; filename=product_${id}.png`);
        res.sendFile(qrCodePath);
    }
    else {
        res.status(404).send('QR code not found');
    }
});
module.exports = router;
