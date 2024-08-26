const express = require('express');
const router = express.Router();
const pool = require('./connection');
const qr = require('qr-image');
const fs = require('fs');
const path = require('path');

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
        // Get a connection from the pool
        const connection = await pool.getConnection();
        
        // Execute the query
        const [results] = await connection.query(query);

        // Release the connection
        connection.release();

        // Organize products with their variants
        const products = results.reduce((acc, row) => {
            if (!acc[row.product_id]) {
                acc[row.product_id] = {
                    product_id: row.product_id,
                    Pname: row.Pname,
                    description: row.description,
                    price: row.productPrice,
                    images: JSON.parse(row.images), // Parse images if stored as JSON
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

        // Send organized data
        res.json(Object.values(products));
    } catch (error) {
        console.error('Error executing query:', error); // Log detailed error
        res.status(500).json({ error: 'Error retrieving products' });
    }
});


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
        // Get a connection from the pool
        connection = await pool.getConnection();

        // Execute the query
        const [results] = await connection.query(query, [productId]);

        // Release the connection
        connection.release();

        // Check if any results were found
        if (results.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }

        // Organize the product with its variants
        const product = results.reduce((acc, row) => {
            if (!acc) {
                acc = {
                    id: row.id,
                    Pname: row.Pname,
                    productPrice: row.productPrice,
                    description: row.description,
                    category: row.category,
                    images: JSON.parse(row.images), // Parse images if stored as JSON
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

        // Send organized data
        res.status(200).json(product);
    } catch (error) {
        console.error('Error retrieving product:', error); // Log detailed error
        res.status(500).json({ error: 'Error retrieving product' });
    } finally {
        if (connection) connection.release();
    }
});


// Create a new product with variants and QR code generation
router.post('/', async (req, res) => {
    const { Pname, price, images, category, description, variants } = req.body;

    let connection;

    try {
        // Get a connection from the pool
        connection = await pool.getConnection();

        // Start a transaction
        await connection.beginTransaction();

        // Convert images to JSON string
        const imagesJson = JSON.stringify(images);

        // Insert product into Product table
        const [productResult] = await connection.query(
            'INSERT INTO Product (Pname, price, images, category, description) VALUES (?, ?, ?, ?, ?)',
            [Pname, price, imagesJson, category, description] // Added category and description
        );

        const productID = productResult.insertId;

        // Insert product variants
        const variantQueries = variants.map(variant =>
            connection.query(
                'INSERT INTO ProductVariant (product_id, gender, size, quantity) VALUES (?, ?, ?, ?)',
                [productID, variant.gender, variant.size, variant.quantity]
            )
        );

        // Generate QR code for the product
        const qrURL = `https://gaposource.com/viewshop/inside/${productID}`;
        const qrImage = qr.imageSync(qrURL, { type: 'png' });
        const qrImagePath = path.join(__dirname, 'qr-codes', `product_${productID}.png`);

        fs.writeFileSync(qrImagePath, qrImage);

        // Execute all variant insert queries
        await Promise.all(variantQueries);

        // Commit the transaction
        await connection.commit();

        res.status(201).json({
            message: `Product created with ID: ${productID}`,
            qr_id: productID // Assuming the product ID is used as qr_id
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



// Update an existing product and its variants
router.put('/:id', (req, res) => {
    const productId = req.params.id;
    const { Pname, price, sizes, images, size_type, size_value, variants } = req.body;

    pool.getConnection((err, connection) => {
        if (err) {
            return res.status(500).json({ error: 'Error connecting to the database' });
        }

        connection.beginTransaction((transactionErr) => {
            if (transactionErr) {
                connection.release();
                return res.status(500).json({ error: 'Error starting database transaction' });
            }

            // Update product details
            connection.query('UPDATE Product SET Pname = ?, price = ?, sizes = ?, images = ?, size_type = ?, size_value = ? WHERE product_id = ?',
                [Pname, price, sizes, images, size_type, size_value, productId],
                (productErr) => {
                    if (productErr) {
                        connection.rollback(() => {
                            connection.release();
                            return res.status(500).json({ error: 'Error updating product' });
                        });
                    }

                    // Delete existing variants
                    connection.query('DELETE FROM ProductVariant WHERE product_id = ?', [productId], (deleteErr) => {
                        if (deleteErr) {
                            connection.rollback(() => {
                                connection.release();
                                return res.status(500).json({ error: 'Error deleting existing variants' });
                            });
                        }

                        // Insert updated variants
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

                        // Commit the transaction if product and variants update succeed
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

// Delete a product and its variants
router.delete('/:id', (req, res) => {
    const productId = req.params.id;

    pool.getConnection((err, connection) => {
        if (err) {
            return res.status(500).json({ error: 'Error connecting to the database' });
        }

        connection.beginTransaction((transactionErr) => {
            if (transactionErr) {
                connection.release();
                return res.status(500).json({ error: 'Error starting database transaction' });
            }

            // Delete product variants
            connection.query('DELETE FROM ProductVariant WHERE product_id = ?', [productId], (deleteVariantsErr) => {
                if (deleteVariantsErr) {
                    connection.rollback(() => {
                        connection.release();
                        return res.status(500).json({ error: 'Error deleting product variants' });
                    });
                }

                // Delete product
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

// Download or print QR code for a specific product
router.get('/:id/qr-id', (req, res) => {
    const productId = req.params.id;

    // Query the database to retrieve QR code information from the qrcode table
    pool.query('SELECT qr_id FROM qrcode WHERE product_id = ?', [productId], (err, results) => {
        if (err) {
            console.error('Error retrieving QR code:', err);
            return res.status(500).json({ error: 'Error retrieving QR code' });
        }

        // Check if QR code exists for the product
        if (results.length === 0) {
            return res.status(404).json({ error: 'QR code not found for the product' });
        }

        // Extract qr_id from the query results
        const qrId = results[0].qr_id;

        // Construct the file path for the QR code image
        const qrImagePath = path.join(__dirname, 'qr-codes', `${qrId}.png`); // Assuming qr_id is a file name

        // Send the QR code image file as a response for download
        res.download(qrImagePath, `product_${productId}_qr.png`, (downloadErr) => {
            if (downloadErr) {
                console.error('Error downloading QR code:', downloadErr);
                res.status(500).json({ error: 'Error downloading QR code' });
            }
        });
    });
});

// Generate QR code for a product
router.get('/generate-qr/:productId', (req, res) => {
    const productId = req.params.productId;

    // Construct the product URL or unique identifier
    const productURL = `https://gaposource.com/viewshop/inside/${productId}`;

    // Generate QR code with the product URL encoded
    const qrImage = qr.imageSync(productURL, { type: 'png' });
    res.type('png');
    res.send(qrImage);
});

// Retrieve product details from the encoded identifier
router.get('/product-details/:productId', (req, res) => {
    const productId = req.params.productId;

    // Retrieve product details from the database using the productId
    pool.query('SELECT * FROM Product WHERE product_id = ?', [productId], (err, results) => {
        if (err) {
            return res.status(500).json({ error: 'Error retrieving product' });
        }
        if (results.length === 0) {
            return res.status(404).json({ error: 'Product not found' });
        }
        // Redirect user to the product page
        res.redirect(`/products/${productId}`);
    });
});

module.exports = router;
