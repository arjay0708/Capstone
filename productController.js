const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');
const qr = require('qr-image');
const { authMiddleware, roleCheckMiddleware } = require('./authMiddleware');
const pool = require('./connection'); // Adjust the path to your database connection file


// Set up storage for Multer
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'D:/Capstone/uploads'); // Ensure this path is correct and exists
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


router.get('/latest', async (req, res) => {
    try {
      const query = `
        SELECT 
          p.product_id, 
          p.Pname, 
          p.price AS productPrice, 
          p.images, 
          p.category,
          p.created_at,
          p.description 
        FROM Product p
        ORDER BY p.created_at DESC
        LIMIT 4
      `;
  
      const [latestProducts] = await pool.query(query);
  
      // Parse image URLs
      const productsWithImages = latestProducts.map(product => {
        product.images = JSON.parse(product.images).map(image => `/uploads/${path.basename(image)}`);
        return product;no
      });
  
      res.status(200).json(productsWithImages);
    } catch (error) {
      console.error('Error fetching latest products:', error);
      res.status(500).send('Server error');
    }
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

router.get('/category-counts', async (req, res) => {
    try {
        const query = `
        SELECT category, COUNT(*) AS count
        FROM product
        GROUP BY category
      `;
        const connection = await pool.getConnection();
        const [results] = await connection.query(query);
        res.json(results);
    } catch (error) {
        console.error('Error fetching category counts:', error);
        res.status(500).send('Server error');
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
            p.created_at,
            p.description, 
            pv.gender, 
            pv.size, 
            pv.quantity,
            pv.variant_id
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
                    date: row.created_at,
                    images: JSON.parse(row.images).map(image => `/uploads/${path.basename(image)}`),
                    variants: []
                };
            }

            if (row.gender) {
                acc.variants.push({
                    gender: row.gender,
                    size: row.size,
                    quantity: row.quantity,
                    variant_id: row.variant_id
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


router.get('/orders/all', async (req, res) => {
    try {
        // Fetch all orders and join with user details
        const [orders] = await pool.query(`
            SELECT 
                Orders.*,
                 CONCAT(accounts.fname, ' ', accounts.lname) AS name,
                accounts.email AS email,
                accounts.phone AS phone,
                accounts.address AS address
            FROM Orders
            JOIN accounts ON Orders.account_id = accounts.account_id  -- Assuming 'account_id' links to 'user_id' in 'Users' table
            ORDER BY Orders.created_at DESC
        `);

        if (orders.length === 0) {
            return res.status(404).json({ message: 'No orders found' });
        }

        // Fetch associated items for all orders
        const orderIds = orders.map(order => order.order_id);
        if (!orderIds.length) {
            return res.status(404).json({ message: 'No order items found' });
        }

        const [orderItems] = await pool.query(
            `SELECT 
                OrderItem.order_item_id,
                OrderItem.order_id,
                OrderItem.product_variant_id,
                OrderItem.quantity,
                OrderItem.price_at_purchase,
                Product.Pname,
                Product.images
             FROM OrderItem
             JOIN ProductVariant ON OrderItem.product_variant_id = ProductVariant.variant_id
             JOIN Product ON ProductVariant.product_id = Product.product_id
             WHERE OrderItem.order_id IN (?) 
             ORDER BY OrderItem.order_id`,
            [orderIds]
        );

        // Organize items under their respective orders
        const ordersWithItems = orders.map(order => ({
            ...order,
            customer_name: order.customer_name,
            customer_email: order.customer_email,
            customer_phone: order.customer_phone,
            customer_address: order.customer_address,
            items: orderItems
                .filter(item => item.order_id === order.order_id)
                .map(item => ({
                    ...item,
                    // Parse JSON images and generate paths for each image
                    images: JSON.parse(item.images).map(image => `/uploads/${image}`), // assuming images are stored under /uploads/
                    price_at_purchase: parseFloat(item.price_at_purchase) // Ensure it's a number
                }))
        }));

        res.status(200).json(ordersWithItems);
    } catch (error) {
        console.error('Error retrieving all orders:', error);
        res.status(500).json({ error: 'Error retrieving all orders' });
    }
});



router.put('/ship-order/:order_id', authMiddleware, roleCheckMiddleware(['admin', 'employee']), async (req, res) => {
    const { order_id } = req.params;
    const { tracking_number, carrier } = req.body;

    if (!tracking_number || !carrier) {
        return res.status(400).json({ message: 'Tracking number and carrier are required.' });
    }

    try {
        const [order] = await pool.query('SELECT * FROM Orders WHERE order_id = ?', [order_id]);

        if (order.length === 0) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        if (['Shipped', 'Delivered'].includes(order[0].order_status)) {
            return res.status(400).json({ message: `Order is already ${order[0].order_status.toLowerCase()}.` });
        }

        // Update status to "Shipped"
        await pool.query(
            'UPDATE Orders SET order_status = ?, tracking_number = ?, carrier = ?, shipped_at = NOW() WHERE order_id = ?',
            ['Shipped', tracking_number, carrier, order_id]
        );

        // Schedule auto-update to "Delivered"
        setTimeout(async () => {
            try {
                await pool.query(
                    'UPDATE Orders SET order_status = ?, delivered_at = NOW() WHERE order_id = ? AND order_status = ?',
                    ['Delivered', order_id, 'Shipped']
                );
                console.log(`Order ${order_id} auto-updated to Delivered.`);
            } catch (error) {
                console.error(`Error auto-updating order ${order_id} to Delivered:`, error);
            }
        }, 10 * 24 * 60 * 60 * 1000); // 10 days in milliseconds

        res.status(200).json({ message: 'Order status updated to Shipped with tracking information.' });
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ error: 'Error updating order status.' });
    }
});

cron.schedule('0 0 * * *', async () => { // Runs daily at midnight
    try {
        await pool.query(
            `UPDATE Orders 
             SET order_status = 'Delivered', delivered_at = NOW() 
             WHERE order_status = 'Shipped' 
               AND shipped_at <= NOW() - INTERVAL 10 DAY`
        );
        console.log('Auto-updated shipped orders to Delivered.');
    } catch (error) {
        console.error('Error in auto-update cron job:', error);
    }
});

router.put('/deliver-order/:order_id', authMiddleware, async (req, res) => {
    const { order_id } = req.params;

    try {
        // Check if the order exists
        const [order] = await pool.query('SELECT * FROM Orders WHERE order_id = ?', [order_id]);

        if (order.length === 0) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        // Check if the order is already delivered
        if (order[0].order_status === 'Delivered') {
            return res.status(400).json({ message: 'Order is already delivered.' });
        }

        // Update the order status to Delivered and set delivered_at timestamp
        await pool.query(
            'UPDATE Orders SET order_status = ?, delivered_at = NOW() WHERE order_id = ?',
            ['Delivered', order_id]
        );

        res.status(200).json({ message: 'Order status updated to Delivered.' });
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ error: 'Error updating order status.' });
    }
});





// Read all orders for the logged-in user
router.get('/orders', authMiddleware, async (req, res) => {
    const account_id = req.user.account_id;

    try {
        const [orders] = await pool.query('SELECT * FROM Orders WHERE account_id = ?', [account_id]);
        res.status(200).json(orders);
    } catch (error) {
        console.error('Error retrieving orders:', error);
        res.status(500).json({ error: 'Error retrieving orders' });
    }
});


router.get('/order/:id', authMiddleware, roleCheckMiddleware(['admin', 'employee']), async (req, res) => {
    const account_id = req.user.account_id;
    const order_id = req.params.id;

    try {
        // Check if the user is admin/employee, and allow them to see any order
        if (req.user.role === 'admin' || req.user.role === 'employee') {
            const [order] = await pool.query(`
                SELECT 
                    Orders.*,
                    CONCAT(accounts.fname, ' ', accounts.lname) AS name,
                    accounts.email,
                    accounts.phone,
                    accounts.address
                FROM Orders
                JOIN accounts ON Orders.account_id = accounts.account_id
                WHERE Orders.order_id = ?
            `, [order_id]);

            if (order.length === 0) {
                return res.status(404).json({ message: 'Order not found' });
            }

            // Fetch items for the order
            const [orderItems] = await pool.query(`
                SELECT 
                    OrderItem.order_item_id,
                    OrderItem.product_variant_id,
                    OrderItem.quantity,
                    OrderItem.size
                    OrderItem.price_at_purchase,
                    Product.Pname,
                    Product.images
                FROM OrderItem
                JOIN ProductVariant ON OrderItem.product_variant_id = ProductVariant.variant_id
                JOIN Product ON ProductVariant.product_id = Product.product_id
                WHERE OrderItem.order_id = ?
            `, [order_id]);

            // Map images and ensure price_at_purchase is a number
            const itemsWithImages = orderItems.map(item => ({
                ...item,
                images: JSON.parse(item.images).map(image => `/uploads/${image}`), // Assuming images are stored under /uploads/
                price_at_purchase: parseFloat(item.price_at_purchase) // Ensure it's a number
            }));

            // Send the response
            return res.status(200).json({
                order: order[0],
                items: itemsWithImages
            });
        } else {
            // For non-admin users, ensure that the order belongs to the current user
            const [order] = await pool.query(`
                SELECT 
                    Orders.*,
                    CONCAT(accounts.fname, ' ', accounts.lname) AS name, 
                    accounts.email,
                    accounts.phone,
                    accounts.address
                FROM Orders
                JOIN accounts ON Orders.account_id = accounts.account_id
                WHERE Orders.order_id = ? AND Orders.account_id = ?
            `, [order_id, account_id]);

            if (order.length === 0) {
                return res.status(404).json({ message: 'Order not found or unauthorized access' });
            }

            // Fetch items for the order
            const [orderItems] = await pool.query(`
                SELECT 
                    OrderItem.order_item_id,
                    OrderItem.product_variant_id,
                    OrderItem.quantity,
                    OrderItem.price_at_purchase,
                    Product.Pname,
                    Product.images
                FROM OrderItem
                JOIN ProductVariant ON OrderItem.product_variant_id = ProductVariant.variant_id
                JOIN Product ON ProductVariant.product_id = Product.product_id
                WHERE OrderItem.order_id = ?
            `, [order_id]);

            // Map images and ensure price_at_purchase is a number
            const itemsWithImages = orderItems.map(item => ({
                ...item,
                images: JSON.parse(item.images).map(image => `/uploads/${image}`), // Assuming images are stored under /uploads/
                price_at_purchase: parseFloat(item.price_at_purchase) // Ensure it's a number
            }));

            // Send the response
            return res.status(200).json({
                order: order[0],
                items: itemsWithImages
            });
        }
    } catch (error) {
        console.error('Error retrieving order details:', error);
        res.status(500).json({ error: 'Error retrieving order details' });
    }
});

// Update an order status
router.put('/order/:id/status', authMiddleware, async (req, res) => {
    const order_id = req.params.id;
    const { status } = req.body; // Expect status to be one of 'Pending', 'Shipped', 'Delivered', 'Cancelled'

    try {
        const [result] = await pool.query(
            'UPDATE Orders SET order_status = ? WHERE order_id = ?',
            [status, order_id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Order not found or status not updated' });
        }

        res.status(200).json({ message: 'Order status updated successfully' });
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ error: 'Error updating order status' });
    }
});

// Delete an order (cancel the order)
router.delete('/order/:id', authMiddleware, async (req, res) => {
    const account_id = req.user.account_id;
    const order_id = req.params.id;

    try {
        const [order] = await pool.query(
            'SELECT * FROM Orders WHERE order_id = ? AND account_id = ? AND order_status = "Pending"',
            [order_id, account_id]
        );

        if (order.length === 0) {
            return res.status(400).json({ message: 'Order not found or cannot be cancelled' });
        }

        await pool.query('DELETE FROM Orders WHERE order_id = ?', [order_id]);
        await pool.query('DELETE FROM OrderItem WHERE order_id = ?', [order_id]);

        res.status(200).json({ message: 'Order cancelled successfully' });
    } catch (error) {
        console.error('Error cancelling order:', error);
        res.status(500).json({ error: 'Error cancelling order' });
    }
});




module.exports = router;
