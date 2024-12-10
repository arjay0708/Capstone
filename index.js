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

// Set up MySQL connection pool
const pool = mysql.createPool({
  uri: process.env.MYSQL_URL,  // Use the environment variable for MySQL connection URL
});

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
app.get('/test-db-connection', (req, res) => {
    pool.getConnection((err, connection) => {
        if (err) {
            console.error('Database connection failed:', err);
            return res.status(500).send('Database connection failed');
        }
        connection.release();  // Release the connection back to the pool
        res.send('Database connection successful');
    });
});

// Serve static files from the uploads directory
app.get('/', (req, res) => {
    res.send('Static file serving setup is working');
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
