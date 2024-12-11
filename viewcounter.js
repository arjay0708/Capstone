const express = require('express');
const router = express.Router();
const pool = require('./connection'); // Your database connection
const cookieParser = require('cookie-parser');

router.use(cookieParser()); // Make sure cookie-parser is used in your app

router.post('/increment-view', async (req, res) => {
    try {
        // Check if the 'viewedShop' cookie is set
        if (!req.cookies.viewedShop) {
            // Insert a new view record with the current timestamp
            const [results] = await pool.query('INSERT INTO Shopviews (view_count, view_date) VALUES (1, NOW())');
            
            // Set a cookie to prevent counting this user again in this session
            res.cookie('viewedShop', 'true', { maxAge: 3600000 }); // Cookie expires in 1 hour
            res.status(200).json({ message: 'View count incremented' });
        } else {
            // User has already been counted; no need to increment the view count
            res.status(200).json({ message: 'View already counted in this session' });
        }
    } catch (err) {
        console.error('Error inserting view record:', err);
        res.status(500).json({ error: 'Error inserting view record' });
    }
});

// Get metrics data
router.get('/metrics', async (req, res) => {
    try {
        // Query to get the total view count
        const totalViewsQuery = 'SELECT COUNT(*) AS total_views FROM Shopviews';
        const [totalViewsResults] = await pool.query(totalViewsQuery);
        const totalViews = totalViewsResults[0] ? totalViewsResults[0].total_views : 0;

        // Query to get views by month
        const viewsByMonthQuery = `
            SELECT 
                MONTH(view_date) AS month, 
                COUNT(*) AS view_count
            FROM 
                Shopviews
            WHERE
                view_date BETWEEN DATE_SUB(NOW(), INTERVAL 1 YEAR) AND NOW()
            GROUP BY 
                MONTH(view_date)
            ORDER BY 
                MONTH(view_date)
        `;
        const [viewsByMonthResults] = await pool.query(viewsByMonthQuery);

        // Prepare data for response
        const monthlyViews = Array(12).fill(0); // Initialize with 0s for each month
        viewsByMonthResults.forEach(row => {
            monthlyViews[row.month - 1] = row.view_count;
        });

        res.json({
            totalViews,
            viewsByMonth: monthlyViews
        });
    } catch (error) {
        console.error('Error retrieving metrics:', error);
        res.status(500).json({ error: 'Error retrieving metrics' });
    }
});

module.exports = router;
