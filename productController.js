const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const qr = require('qr-image');
const pool = require('./connection'); // Adjust the path to your database connection file

// Set up storage for Multer
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'D:/Capstone/Capstone/uploads'); // Ensure this path is correct and exists
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });

// POST route to create a product
router.post('/', upload.array('images'), async (req, res) => {
    const { Pname, price, category, description, variants } = req.body;

    // Log received files and data for debugging
    console.log('Received files:', req.files);
    console.log('Received body data:', { Pname, price, category, description, variants });

    // Check if files were uploaded
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
    }

    const images = req.files.map(file => file.filename); // Get the uploaded filenames

    // Ensure `variants` is an array
    let parsedVariants = [];
    try {
        parsedVariants = Array.isArray(variants) ? variants : JSON.parse(variants);
    } catch (error) {
        console.error('Error parsing variants:', error);
        return res.status(400).json({ error: 'Invalid variants data' });
    }

    let connection;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Convert images array to JSON string
        const imagesJson = JSON.stringify(images);

        const [productResult] = await connection.query(
            'INSERT INTO Product (Pname, price, images, category, description) VALUES (?, ?, ?, ?, ?)',
            [Pname, price, imagesJson, category, description]
        );

        const productID = productResult.insertId;

        // Validate and insert variants
        const variantQueries = parsedVariants.map(variant =>
            connection.query(
                'INSERT INTO ProductVariant (product_id, gender, size, quantity) VALUES (?, ?, ?, ?)',
                [productID, variant.gender, variant.size, variant.quantity]
            )
        );

        // Ensure QR code directory exists
        const qrCodeDir = 'D:/Capstone/Capstone/qr-codes';
        if (!fs.existsSync(qrCodeDir)) {
            fs.mkdirSync(qrCodeDir, { recursive: true });
        }

        const qrURL = `https://gaposource.com/viewshop/inside/${productID}`;
        const qrImage = qr.imageSync(qrURL, { type: 'png' });
        const qrImagePath = path.join(qrCodeDir, `product_${productID}.png`); // Ensure this path exists

        fs.writeFileSync(qrImagePath, qrImage);

        await Promise.all(variantQueries);
        await connection.commit();

        res.status(201).json({
            message: `Product created with ID: ${productID}`,
            qr_id: productID
        });
    } catch (error) {
        console.error('Error creating product:', error);
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Error rolling back transaction:', rollbackError);
            }
        }
        res.status(500).json({ error: 'Error creating product' });
    } finally {
        if (connection) connection.release();
    }
});

// PUT update product and its variants
router.put('/:id', upload.array('images'), (req, res) => {
    const productId = req.params.id;
    const { Pname, price, sizes, size_type, size_value, variants } = req.body;
    const images = req.files ? req.files.map(file => file.filename) : [];

    pool.getConnection((err, connection) => {
        if (err) return res.status(500).json({ error: 'Error connecting to the database' });

        connection.beginTransaction((transactionErr) => {
            if (transactionErr) {
                connection.release();
                return res.status(500).json({ error: 'Error starting database transaction' });
            }

            const imagesJson = JSON.stringify(images);
            connection.query('UPDATE Product SET Pname = ?, price = ?, sizes = ?, images = ?, size_type = ?, size_value = ? WHERE product_id = ?',
                [Pname, price, sizes, imagesJson, size_type, size_value, productId],
                (productErr) => {
                    if (productErr) {
                        connection.rollback(() => {
                            connection.release();
                            return res.status(500).json({ error: 'Error updating product' });
                        });
                    }

                    connection.query('DELETE FROM ProductVariant WHERE product_id = ?', [productId], (deleteErr) => {
                        if (deleteErr) {
                            connection.rollback(() => {
                                connection.release();
                                return res.status(500).json({ error: 'Error deleting existing variants' });
                            });
                        }

                        const variantQueries = variants.map(variant => (
                            new Promise((resolve, reject) => {
                                connection.query('INSERT INTO ProductVariant (product_id, gender, size, quantity) VALUES (?, ?, ?, ?)',
                                    [productId, variant.gender, variant.size, variant.quantity],
                                    (err) => {
                                        if (err) reject(err);
                                        else resolve();
                                    });
                            })
                        ));

                        Promise.all(variantQueries)
                            .then(() => {
                                connection.commit((commitErr) => {
                                    if (commitErr) {
                                        connection.rollback(() => {
                                            connection.release();
                                            return res.status(500).json({ error: 'Error committing transaction' });
                                        });
                                    }

                                    connection.release();
                                    res.status(200).json({ message: 'Product updated successfully' });
                                });
                            })
                            .catch((variantErr) => {
                                connection.rollback(() => {
                                    connection.release();
                                    res.status(500).json({ error: 'Error updating product variants' });
                                });
                            });
                    });
                });
        });
    });
});


// DELETE a product and its variants
router.delete('/:id', (req, res) => {
    const productId = req.params.id;

    pool.getConnection((err, connection) => {
        if (err) return res.status(500).json({ error: 'Error connecting to the database' });

        connection.beginTransaction((transactionErr) => {
            if (transactionErr) {
                connection.release();
                return res.status(500).json({ error: 'Error starting database transaction' });
            }

            connection.query('DELETE FROM ProductVariant WHERE product_id = ?', [productId], (deleteVariantsErr) => {
                if (deleteVariantsErr) {
                    connection.rollback(() => {
                        connection.release();
                        return res.status(500).json({ error: 'Error deleting product variants' });
                    });
                }

                connection.query('DELETE FROM Product WHERE product_id = ?', [productId], (deleteProductErr) => {
                    if (deleteProductErr) {
                        connection.rollback(() => {
                            connection.release();
                            return res.status(500).json({ error: 'Error deleting product' });
                        });
                    }

                    connection.commit((commitErr) => {
                        if (commitErr) {
                            connection.rollback(() => {
                                connection.release();
                                return res.status(500).json({ error: 'Error committing transaction' });
                            });
                        }

                        connection.release();
                        res.status(200).json({ message: 'Product and its variants deleted successfully' });
                    });
                });
            });
        });
    });
});

// GET QR code for a specific product
router.get('/:id/qr-id', (req, res) => {
    const productId = req.params.id;

    pool.query('SELECT qr_id FROM qrcode WHERE product_id = ?', [productId], (err, results) => {
        if (err) {
            console.error('Error retrieving QR code:', err);
            return res.status(500).json({ error: 'Error retrieving QR code' });
        }

        if (results.length === 0) {
            return res.status(404).json({ error: 'QR code not found for the product' });
        }

        const qrId = results[0].qr_id;
        const qrImagePath = path.join(__dirname, 'qr-codes', `${qrId}.png`);

        res.download(qrImagePath, `product_${productId}_qr.png`, (downloadErr) => {
            if (downloadErr) {
                console.error('Error downloading QR code:', downloadErr);
                res.status(500).json({ error: 'Error downloading QR code' });
            }
        });
    });
});

// GENERATE QR code for a product
router.get('/generate-qr/:productId', (req, res) => {
    const productId = req.params.productId;

    const productURL = `https://gaposource.com/viewshop/inside/${productId}`;
    const qrImage = qr.imageSync(productURL, { type: 'png' });
    res.type('png');
    res.send(qrImage);
});

// TEST route
router.get('/test', (req, res) => {
    console.log('Test route hit');
    res.send('Test route works');
});

// GET product details from the encoded identifier
router.get('/product-details/:productId', (req, res) => {
    const productId = req.params.productId;

    pool.query('SELECT * FROM Product WHERE product_id = ?', [productId], (err, results) => {
        if (err) {
            return res.status(500).json({ error: 'Error retrieving product' });
        }
        if (results.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        res.redirect(`/products/${productId}`);
    });
});

// FILTER products by category and gender
router.get('/filter', async (req, res) => {
    const { category, gender } = req.query;

    const genderMapping = {
        "Men's Wear": 'Male',
        "Women's Wear": 'Female',
        "Unisex": null
    };

    const mappedGender = genderMapping[gender] || gender;

    let productQuery = 'SELECT DISTINCT p.* FROM Product p WHERE 1=1';
    let productParams = [];

    if (category && category !== '0') {
        productQuery += ' AND p.category = ?';
        productParams.push(category);
    }

    let variantQuery = 'SELECT pv.product_id FROM ProductVariant pv WHERE 1=1';
    let variantParams = [];

    if (mappedGender) {
        if (mappedGender !== 'Unisex') {
            variantQuery += ' AND pv.gender = ?';
            variantParams.push(mappedGender);
        }
    } else {
        variantQuery = 'SELECT DISTINCT pv.product_id FROM ProductVariant pv';
    }

    try {
        const connection = await pool.getConnection();
        const [products] = await connection.query(productQuery, productParams);
        const [variantResults] = await connection.query(variantQuery, variantParams);
        connection.release();

        const variantProductIds = new Set(variantResults.map(v => v.product_id));
        const filteredProducts = products.filter(product => variantProductIds.has(product.product_id));

        if (filteredProducts.length === 0) {
            return res.status(404).json({ error: 'No products found' });
        }

        res.json(filteredProducts);
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({ error: 'Error fetching products' });
    }
});

// SEARCH products by name
router.get('/search', async (req, res) => {
    const { search } = req.query;

    if (!search) {
        return res.status(400).json({ error: 'Search query parameter is required' });
    }

    try {
        const connection = await pool.getConnection();
        const [results] = await connection.query(
            'SELECT * FROM Product WHERE Pname LIKE ?',
            [`%${search}%`]
        );
        connection.release();

        if (results.length === 0) {
            return res.status(404).json({ error: 'No products found' });
        }

        res.json(results);
    } catch (error) {
        console.error('Error searching products:', error);
        res.status(500).json({ error: 'Error searching products' });
    }
});

router.get('/', async (req, res) => {
    const query = `
        SELECT 
            p.product_id, 
            p.Pname, 
            p.price AS productPrice, 
            p.images, 
            p.category,
            p.description, 
            pv.gender, 
            pv.size, 
            pv.quantity
        FROM 
            Product p
        LEFT JOIN 
            ProductVariant pv ON p.product_id = pv.product_id
    `;

    try {
        const connection = await pool.getConnection();
        const [results] = await connection.query(query);
        connection.release();

        // Organize products with their variants
        const products = results.reduce((acc, row) => {
            if (!acc[row.product_id]) {
                acc[row.product_id] = {
                    product_id: row.product_id,
                    Pname: row.Pname,
                    description: row.description,
                    price: row.productPrice,
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

        res.json(Object.values(products));
    } catch (error) {
        console.error('Error executing query:', error);
        res.status(500).json({ error: 'Error retrieving products' });
    }
});

router.get('/categories', async (req, res) => {
    try {
        // Query to get distinct categories from the Product table
        const query = 'SELECT DISTINCT category FROM Product';
        
        // Get a connection from the pool
        const connection = await pool.getConnection();
        
        // Execute the query
        const [results] = await connection.query(query);
        
        // Release the connection
        connection.release();
        
        // Extract the categories from the results
        const categories = results.map(row => row.category);

        // Return the categories as JSON
        res.json(categories);
    } catch (error) {
        console.error('Error fetching categories:', error);
        res.status(500).json({ error: 'Error fetching categories' });
    }
});


// Route to get product by ID
router.get('/:id', async (req, res) => {
    const productId = req.params.id;
    const query = `
        SELECT 
            p.product_id AS id, 
            p.Pname, 
            p.price AS productPrice, 
            p.images, 
            p.category,
            p.description, 
            pv.gender, 
            pv.size, 
            pv.quantity
        FROM 
            Product p
        LEFT JOIN 
            ProductVariant pv ON p.product_id = pv.product_id
        WHERE 
            p.product_id = ?
    `;

    let connection;

    try {
        connection = await pool.getConnection();
        const [results] = await connection.query(query, [productId]);

        if (results.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        const product = results.reduce((acc, row) => {
            if (!acc) {
                acc = {
                    id: row.id,
                    Pname: row.Pname,
                    productPrice: row.productPrice,
                    description: row.description,
                    category: row.category,
                    images: JSON.parse(row.images).map(image => `uploads/${path.basename(image)}`),
                    variants: []
                };
            }

            if (row.gender) {
                acc.variants.push({
                    gender: row.gender,
                    size: row.size,
                    quantity: row.quantity
                });
            }

            return acc;
        }, null);

        res.status(200).json(product);
    } catch (error) {
        console.error('Error retrieving product:', error);
        res.status(500).json({ error: 'Error retrieving product' });
    } finally {
        if (connection) connection.release();
    }
});

module.exports = router;
