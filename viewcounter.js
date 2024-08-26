const express = require('express');
const router = express.Router();
const pool = require('./connection'); // Your database connection

router.post('/increment-view', (req, res) => {
    // Check if the 'viewedShop' cookie is set
    if (!req.cookies.viewedShop) {
        // Increment the view count
        pool.query('UPDATE ShopViews SET view_count = view_count + 1', (err, results) => {
            if (err) {
                return res.status(500).json({ error: 'Error updating view count 1' });
            }

            // Set a cookie to prevent counting this user again in this session
            res.cookie('viewedShop', 'true', { maxAge: 3600000 }); // Cookie expires in 1 hour
            res.status(200).json({ message: 'View count incremented' });
        });
    } else {
        // User has already been counted; no need to increment the view count
        res.status(200).json({ message: 'View already counted in this session' });
    }
});

module.exports = router;
