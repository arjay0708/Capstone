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


// testing
app.get('/', async (req, res) => {
    const query = `
        SELECT 
            p.product_id, 
            p.Pname, 
            p.price AS productPrice, 
            p.images, 
            p.category,
            p.created_at,
            p.description, 
            pv.gender, 
            pv.size, 
            pv.quantity
        FROM 
            Product p
        LEFT JOIN 
            ProductVariant pv ON p.product_id = pv.product_id
        ORDER BY 
            p.created_at DESC
    `;

    try {
        const connection = await pool.getConnection();
        const [results] = await connection.query(query);
        connection.release();

        // Organize products with their variants
        const products = results.reduce((acc, row) => {
            if (!acc[row.product_id]) {
                acc[row.product_id] = {
                    id: row.product_id,
                    Pname: row.Pname,
                    category: row.category,
                    description: row.description,
                    price: row.productPrice,
                    date: row.created_at,
                    images: JSON.parse(row.images).map(image => `/uploads/${path.basename(image)}`),
                    variants: []
                };
            }

            if (row.gender) {
                acc[row.product_id].variants.push({
                    gender: row.gender,
                    size: row.size,
                    quantity: row.quantity
                });
            }

            return acc;
        }, {});

        // Convert the object to an array and sort by date in descending order
        const sortedProducts = Object.values(products).sort((a, b) => new Date(b.date) - new Date(a.date));

        res.json(sortedProducts);
    } catch (error) {
        console.error('Error executing query:', error);
        res.status(500).json({ error: 'Error retrieving products' });
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
