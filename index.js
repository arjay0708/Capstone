const express = require('express');
const app = express();
const cors = require('cors');
const bodyParser = require('body-parser');
const mysql = require('mysql2');
const adminRouter = require('./adminController.js');
const productRouter = require('./productController.js');
const qrcodeRouter = require('./qrcodeController.js');
const countsRouter = require('./viewcounter.js');
const customerRouter = require('./customerController.js');
const cartRouter = require('./cart.js');
const path = require('path');
const pool = require('./connection.js');


// Use CORS for cross-origin requests
app.use(cors({
    origin: 'https://gaposource.com', // Adjust to match your Angular frontend URL
}));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const port = 8080;
app.use(bodyParser.json());

// Enable CORS for all routes
app.use('/admins', adminRouter);
app.use('/products', productRouter);
app.use('/qrcodes', qrcodeRouter);
app.use('/counts', countsRouter);
app.use('/customer', customerRouter);
app.use('/cart', cartRouter);

// Test database connection route
app.get('/', async (req, res) => {
    try {
        const connection = await pool.getConnection(); // Get a connection from the pool
        connection.release(); // Release the connection immediately after testing
        res.send('Database connection successful!');
    } catch (error) {
        console.error('Database connection error:', error);
        res.status(500).send('Database connection failed.');
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
