const express = require('express');
require('dotenv').config();
const router = express.Router();
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary'); // Use this method to create storage
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const qr = require('qr-image');
const fetch = import('node-fetch');
const moment = require('moment');
const streamifier = require('streamifier');
const { authMiddleware, roleCheckMiddleware } = require('./authMiddleware');
const pool = require('./connection'); // Adjust the path to your database connection file

// Configure Cloudinary with your credentials from the .env file
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  
  // Set up Cloudinary storage for Multer
  const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
      folder: 'products', // Optionally specify a folder on Cloudinary
      allowed_formats: ['jpg', 'jpeg', 'png', 'gif'], // Restrict file formats
      transformation: [{ width: 500, height: 500, crop: 'limit' }] // Resize to 500x500 if needed
    }
  });
  
  const upload = multer({ storage });

  // POST route to create a product
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

    // Ensure variants is an array
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

        // Insert the product data into the database
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

        // Generate QR code URL (if you need to generate QR but not save it locally)
        const qrURL = `https://gaposource.com/viewshop/inside/${productID}`;
        const qrImage = qr.imageSync(qrURL, { type: 'png' });

        // Upload the QR code directly to Cloudinary, using product_id as the filename
        const qrImageUpload = await cloudinary.uploader.upload_stream(
            {
                folder: 'qr-codes', // Specify the folder in Cloudinary
                public_id: `product_${productID}`, // Use product_id as the filename (public_id)
                resource_type: 'image', // Image resource type
            },
            (error, result) => {
                if (error) {
                    console.error('Error uploading QR code to Cloudinary:', error);
                    return res.status(500).send('Error uploading QR code');
                }
                const qrCodeUrl = result.secure_url;

                // Insert the variants into the database
                Promise.all(variantQueries)
                    .then(async () => {
                        await connection.commit();

                        // Return the response with product creation and QR code URL
                        res.status(201).json({
                            message: `Product created with ID: ${productID}`,
                            qr_code_url: qrCodeUrl,  // Return QR code URL from Cloudinary
                        });
                    })
                    .catch(async (error) => {
                        console.error('Error inserting variants:', error);
                        await connection.rollback();
                        res.status(500).json({ error: 'Error inserting variants' });
                    });
            }
        );

        // Pipe the QR image to Cloudinary
        qrImageUpload.end(qrImage);
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
  
    router.get('/image/*', async (req, res) => {
        const imagePath = req.params[0]; // Get the image path after /image/
    
        // Construct the full Cloudinary URL
        const cloudinaryUrl = `https://res.cloudinary.com/duqbdikz0/image/upload/${imagePath}`;
    
        try {
            // Fetch the image and stream it back to the client
            const response = await fetch(cloudinaryUrl);
            if (!response.ok) {
                return res.status(404).send('Image not found');
            }
    
            // Set the correct content type for image response
            const contentType = response.headers.get('Content-Type');
            res.setHeader('Content-Type', contentType);
    
            // Pipe the image data to the response
            response.body.pipe(res);
        } catch (error) {
            console.error('Error fetching image from Cloudinary:', error);
            res.status(500).send('Error fetching image');
        }
    });
    
    // PUT update product price and its variants' quantity
    router.put('/update/:id', async (req, res) => {
        const productId = req.params.id;
        const { price, variants } = req.body;
    
        let connection;
        try {
            connection = await pool.getConnection();
            await connection.beginTransaction();
    
            // Update product price
            await connection.query('UPDATE Product SET price = ? WHERE product_id = ?', [price, productId]);
    
            // Update product variants' quantities
            for (const variant of variants) {
                await connection.query('UPDATE ProductVariant SET quantity = ? WHERE product_id = ? AND size = ?', 
                    [variant.quantity, productId, variant.size]);
            }
    
            await connection.commit();
            connection.release();
            res.status(200).json({ message: 'Product price and variants updated successfully' });
        } catch (err) {
            if (connection) {
                await connection.rollback();
                connection.release();
            }
            console.error(err);
            res.status(500).json({ error: 'Error updating product' });
        }
    });
    
    // Get the latest products
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
    
            // Parse image URLs and map them to Cloudinary URLs
            const productsWithImages = latestProducts.map(product => {
                const images = JSON.parse(product.images).map(image => {
                    // Assuming images are in the 'products' folder on Cloudinary
                    return `https://res.cloudinary.com/duqbdikz0/image/upload/v1733890541/${image}`;
                });
                return { ...product, images };
            });
    
            res.status(200).json(productsWithImages);
        } catch (error) {
            console.error('Error fetching latest products:', error);
            res.status(500).send('Server error');
        }
    });
// DELETE a product and its variants
router.delete('/delete/:id', async (req, res) => {
    const productId = req.params.id;

    const connection = await pool.getConnection().catch(err => {
        return res.status(500).json({ error: 'DB connection error' });
    });

    try {
        await connection.beginTransaction();

        await connection.query('DELETE FROM ProductVariant WHERE product_id = ?', [productId]);
        await connection.query('DELETE FROM Product WHERE product_id = ?', [productId]);

        await connection.commit();
        res.status(200).json({ message: 'Product and variants deleted' });
    } catch (err) {
        await connection.rollback();
        res.status(500).json({ error: 'Error during deletion' });
    } finally {
        connection.release();
    }
});
// GET QR code for a specific product
router.get('/:id/qr-id', async (req, res) => {
    const productId = req.params.id;

    try {
        const [results] = await pool.query('SELECT qr_id FROM qrcode WHERE product_id = ?', [productId]);

        if (results.length === 0) {
            return res.status(404).json({ error: 'QR code not found for the product' });
        }

        const qrId = results[0].qr_id;
        const qrImageUrl = `https://res.cloudinary.com/duqbdikz0/image/upload/v1733890541/qr-codes/${qrId}.png`;

        // Set the response to download the QR code from Cloudinary
        res.redirect(qrImageUrl); // This will trigger the download automatically in the browser
    } catch (err) {
        console.error('Error retrieving QR code:', err);
        res.status(500).json({ error: 'Error retrieving QR code' });
    }
});

// GENERATE QR code for a product
router.get('/generate-qr/:productId', (req, res) => {
    const productId = req.params.productId;

    const productURL = `https://gaposource.com/viewshop/inside/${productId}`;
    const qrImage = qr.imageSync(productURL, { type: 'png' });
    res.type('png');
    res.send(qrImage);
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

    // Map gender categories to database-friendly values
    const genderMapping = {
        "Men's Wear": 'Male',
        "Women's Wear": 'Female',
        "Unisex": null
    };

    const mappedGender = genderMapping[gender] || gender;

    // Base query for filtering products by category and including variants
    let productQuery = 'SELECT DISTINCT p.* FROM Product p';
    let productParams = [];

    // Adding condition for category if provided
    if (category && category !== '0') {
        productQuery += ' WHERE p.category = ?';
        productParams.push(category);
    } else {
        productQuery += ' WHERE 1=1';  // Add generic condition if category is not provided
    }

    // Base query for filtering product variants
    let variantQuery = 'SELECT DISTINCT pv.product_id FROM ProductVariant pv';
    let variantParams = [];

    // Adding condition for gender if provided
    if (mappedGender) {
        variantQuery += ' WHERE pv.gender = ?';
        variantParams.push(mappedGender);
    }

    try {
        const connection = await pool.getConnection();

        // Fetch products based on the category
        const [products] = await connection.query(productQuery, productParams);

        // Fetch variant results for the filtered gender
        const [variantResults] = await connection.query(variantQuery, variantParams);

        // Release connection back to the pool
        connection.release();

        // If no variants are found based on the gender, return an empty response
        if (variantResults.length === 0) {
            return res.status(404).json({ error: 'No products found for the given gender' });
        }

        // Create a set of product_ids that match the gender filter
        const variantProductIds = new Set(variantResults.map(v => v.product_id));

        // Filter products by checking if their IDs match the ones from the variant query
        const filteredProducts = products.filter(product => variantProductIds.has(product.product_id));

        // If no products match the criteria, return a 404
        if (filteredProducts.length === 0) {
            return res.status(404).json({ error: 'No products found' });
        }

        // Return filtered products
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
                    price: parseFloat(row.productPrice), // Ensure price is parsed as a number
                    date: row.created_at,
                    images: row.images ? JSON.parse(row.images) : [], // Ensure images are parsed correctly
                    variants: []
                };
            }

            // Add variants to product
            if (row.gender) {
                acc[row.product_id].variants.push({
                    gender: row.gender,
                    size: row.size,
                    quantity: row.quantity
                });
            }

            return acc;
        }, {});

        // Function to fetch Cloudinary URLs for product images
        const fetchImageUrls = (imagePaths) => {
            return imagePaths.map(imagePath => {
                // Construct Cloudinary URL using a base URL for your Cloudinary account
                return `https://res.cloudinary.com/duqbdikz0/image/upload/v1733890541/${imagePath}`;
            });
        };

        // Update the products with Cloudinary image URLs
        for (let productId in products) {
            const product = products[productId];
            // Fetch Cloudinary URLs
            product.images = fetchImageUrls(product.images);
        }

        // Convert the object to an array and sort by date in descending order
        const sortedProducts = Object.values(products).sort((a, b) => new Date(b.date) - new Date(a.date));

        // Return the sorted products as JSON
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
        FROM Product
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

        // Function to fetch Cloudinary URLs
        const fetchImageUrls = async (imagePaths) => {
            try {
                // Assuming the images are stored in Cloudinary's 'products' folder
                const cloudinaryUrls = imagePaths.map(imagePath => {
                    return `https://res.cloudinary.com/duqbdikz0/image/upload/v1733890541/${imagePath}`;
                });
                return cloudinaryUrls;
            } catch (error) {
                console.error('Error fetching Cloudinary image URLs:', error);
                return [];
            }
        };

        const product = results.reduce((acc, row) => {
            if (!acc) {
                acc = {
                    id: row.id,
                    Pname: row.Pname,
                    productPrice: row.productPrice,
                    description: row.description,
                    category: row.category,
                    date: row.created_at,
                    images: JSON.parse(row.images), // Get the raw image paths from DB
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

        // Fetch Cloudinary URLs for the images
        const imageUrls = await fetchImageUrls(product.images);
        product.images = imageUrls; // Replace the raw paths with Cloudinary URLs

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
        // Fetch all orders and join with user details, including order status
        const [orders] = await pool.query(`
            SELECT 
                Orders.*,
                Orders.order_status,  -- Add the order_status column
                CONCAT(Accounts.fname, ' ', Accounts.lname) AS name,
                Accounts.email AS email,
                Accounts.phone AS phone,
                Accounts.address AS address
            FROM Orders
            JOIN Accounts ON Orders.account_id = Accounts.account_id
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
                ProductVariant.size,
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
            customer_name: order.name,
            customer_email: order.email,
            customer_phone: order.phone,
            customer_address: order.address,
            items: orderItems
                .filter(item => item.order_id === order.order_id)
                .map(item => ({
                    ...item,
                    images: JSON.parse(item.images).map(image => 
                        `https://res.cloudinary.com/duqbdikz0/image/upload/v1733890541/${image}`), // Cloudinary URL
                    price_at_purchase: parseFloat(item.price_at_purchase)
                }))
        }));

        res.status(200).json(ordersWithItems);
    } catch (error) {
        console.error('Error retrieving all orders:', error);
        res.status(500).json({ error: 'Error retrieving all orders' });
    }
});

router.put('/preparing-order/:order_id', authMiddleware, async (req, res) => {
    const { order_id } = req.params;

    try {
        // Check if the order exists
        const [order] = await pool.query('SELECT * FROM Orders WHERE order_id = ?', [order_id]);

        if (order.length === 0) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        // Check if the order is already delivered
        if (order[0].order_status === 'preparing') {
            return res.status(400).json({ message: 'Order is already Preparing.' });
        }

        // Update the order status to Delivered and set delivered_at timestamp
        await pool.query(
            'UPDATE Orders SET order_status = ?, delivered_at = NOW() WHERE order_id = ?',
            ['Preparing', order_id]
        );

        res.status(200).json({ message: 'Order status updated to Preparing.' });
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ error: 'Error updating order status.' });
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
                    CONCAT(Accounts.fname, ' ', Accounts.lname) AS name,
                    Accounts.email,
                    Accounts.phone,
                    Accounts.address
                FROM Orders
                JOIN Accounts ON Orders.account_id = Accounts.account_id
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
                    OrderItem.price_at_purchase,
                    Product.Pname,
                    ProductVariant.size,
                    Product.images
                FROM OrderItem
                JOIN ProductVariant ON OrderItem.product_variant_id = ProductVariant.variant_id
                JOIN Product ON ProductVariant.product_id = Product.product_id
                WHERE OrderItem.order_id = ?
            `, [order_id]);

            // Map images and ensure price_at_purchase is a number
            const itemsWithImages = orderItems.map(item => ({
                ...item,
                images: JSON.parse(item.images).map(image => 
                    `https://res.cloudinary.com/duqbdikz0/image/upload/v1733890541/${image}`), // Cloudinary URL
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
                    CONCAT(Accounts.fname, ' ', Accounts.lname) AS name, 
                    Accounts.email,
                    Accounts.phone,
                    Accounts.address
                FROM Orders
                JOIN Accounts ON Orders.account_id = Accounts.account_id
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
                    ProductVariant.size,
                    Product.images
                FROM OrderItem
                JOIN ProductVariant ON OrderItem.product_variant_id = ProductVariant.variant_id
                JOIN Product ON ProductVariant.product_id = Product.product_id
                WHERE OrderItem.order_id = ?
            `, [order_id]);

            // Map images and ensure price_at_purchase is a number
            const itemsWithImages = orderItems.map(item => ({
                ...item,
                images: JSON.parse(item.images).map(image => 
                    `https://res.cloudinary.com/duqbdikz0/image/upload/v1733890541/${image}`), // Cloudinary URL
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
router.put('/cancel/:id/status', authMiddleware, async (req, res) => {
    const order_id = req.params.id; // Extract order ID from the request parameters
    const { status } = req.body;   // Expect status in the request body

    try {
        // Check the current status of the order
        const [order] = await pool.query('SELECT order_status FROM Orders WHERE order_id = ?', [order_id]);

        if (order.length === 0) {
            return res.status(404).json({ message: 'Order not found' });
        }

        const currentStatus = order[0].order_status;

        // Only allow cancellation if the status is 'Pending'
        if (currentStatus !== 'Pending') {
            return res.status(400).json({ message: 'Order can only be cancelled if it is in "Pending" status.' });
        }

        // Update the order status to 'Cancelled'
        const [result] = await pool.query(
            'UPDATE Orders SET order_status = ? WHERE order_id = ?',
            ['Cancelled', order_id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Order not found or already cancelled' });
        }

        res.status(200).json({ message: 'Order successfully cancelled' });
    } catch (error) {
        console.error('Error updating order status:', error);
        res.status(500).json({ error: 'An error occurred while cancelling the order' });
    }
});



router.get('/sales/sales', async (req, res) => {
    const todayStart = moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
    const weekStart = moment().startOf('week').format('YYYY-MM-DD HH:mm:ss');
    const monthStart = moment().startOf('month').format('YYYY-MM-DD HH:mm:ss');

    try {
        const [salesToday] = await pool.query('SELECT SUM(total_amount) AS total FROM Orders WHERE delivered_at >= ?', [todayStart]);
        const [salesWeekly] = await pool.query('SELECT SUM(total_amount) AS total FROM Orders WHERE delivered_at >= ?', [weekStart]);
        const [salesMonthly] = await pool.query('SELECT SUM(total_amount) AS total FROM Orders WHERE delivered_at >= ?', [monthStart]);

        res.status(200).json({
            salesToday: salesToday[0]?.total || 0,
            salesWeekly: salesWeekly[0]?.total || 0,
            salesMonthly: salesMonthly[0]?.total || 0
        });
    } catch (err) {
        res.status(500).json({ error: 'Error retrieving sales data' });
    }
});



module.exports = router;
