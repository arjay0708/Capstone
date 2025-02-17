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
const { logLoginActivity } = require('./googleSheets');
const { logCustomerActivity } = require('./customerLogger');
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
router.post('/', authMiddleware, upload.array('images'), async (req, res) => {
    const { Pname, price, category, description, variants } = req.body;

    // Ensure req.user exists before using it
    if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized. User not authenticated.' });
    }

    const { username, role } = req.user; // Destructure username and role

    // Validate input fields
    if (!Pname || !price || !category || !variants) {
        // Log activity for missing required fields
        logLoginActivity(username, role, 'Failed', 'Create Product - Missing required fields');
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Parse variants to ensure correct format
    let parsedVariants = [];
    try {
        parsedVariants = Array.isArray(variants) ? variants : JSON.parse(variants);
    } catch (error) {
        console.error('Error parsing variants:', error);
        // Log activity for parsing error
        logLoginActivity(username, role, 'Failed', 'Create Product - Invalid variants data');
        return res.status(400).json({ error: 'Invalid variants data' });
    }

    // Check for uploaded files
    if (!req.files || req.files.length === 0) {
        // Log activity for no images uploaded
        logLoginActivity(username, role, 'Failed', 'Create Product - No images uploaded');
        return res.status(400).json({ error: 'No images uploaded' });
    }

    const images = req.files.map(file => file.filename); // Extract filenames
    const imagesJson = JSON.stringify(images); // Convert to JSON string for storage

    let connection;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // Check if a product with the same name already exists
        const [existingProduct] = await connection.query(
            'SELECT COUNT(*) AS count FROM Product WHERE Pname = ?',
            [Pname]
        );
        if (existingProduct[0].count > 0) {
            // Log activity for existing product error
            logLoginActivity(username, role, 'Failed', 'Create Product - Product already exists');
            return res.status(400).json({ error: 'A product with this name already exists' });
        }

        // Insert the product into the database
        const [productResult] = await connection.query(
            'INSERT INTO Product (Pname, price, images, category, description) VALUES (?, ?, ?, ?, ?)',
            [Pname, price, imagesJson, category, description]
        );

        const productID = productResult.insertId;

        // Insert variants
        const variantQueries = parsedVariants.map(variant =>
            connection.query(
                'INSERT INTO ProductVariant (product_id, gender, size, quantity) VALUES (?, ?, ?, ?)',
                [productID, variant.gender, variant.size, variant.quantity]
            )
        );

        await Promise.all(variantQueries);

        // Commit the transaction
        await connection.commit();

        // Log activity for successful product creation
        logLoginActivity(username, role, 'Success', 'Create Product - Success');
        
        // Return the success response with Product ID
        res.status(201).json({
            message: `Product created successfully - Product ID: ${productID}`,
            productID: productID // Include product ID in response
        });
    } catch (error) {
        console.error('Error creating product:', error);

        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Error during rollback:', rollbackError);
            }
        }

        // Log activity for server error
        logLoginActivity(username, role, 'Failed', 'Create Product - Server Error');
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
    router.put('/update/:id', authMiddleware, async (req, res) => {
        const productId = req.params.id;
        const { price, variants } = req.body;
        const { username, role } = req.user; // Assuming `req.user` is set from the auth middleware
    
        let connection;
    
        try {
            connection = await pool.getConnection();
            await connection.beginTransaction();
    
            // Update product price if provided
            if (price !== undefined) {
                await connection.query(
                    'UPDATE Product SET price = ? WHERE product_id = ?',
                    [price, productId]
                );
                // Log the price update activity
                logLoginActivity(username, role, 'Success', `Update Product - Updated price for product ID: ${productId}`);
            }
    
            // Update or add product variants' quantities
            if (variants && variants.length > 0) {
                for (const variant of variants) {
                    const { size, quantity } = variant;
    
                    // Check if the variant already exists for this product
                    const [existingVariant] = await connection.query(
                        'SELECT * FROM ProductVariant WHERE product_id = ? AND size = ?',
                        [productId, size]
                    );
    
                    if (existingVariant.length > 0) {
                        // If the variant exists, update the quantity
                        await connection.query(
                            'UPDATE ProductVariant SET quantity = ? WHERE product_id = ? AND size = ?',
                            [quantity, productId, size]
                        );
                        // Log the variant update activity
                        logLoginActivity(username, role, 'Success', `Update Product - Updated quantity for variant size: ${size} of product ID: ${productId}`);
                    } else {
                        // If the variant does not exist, insert it as a new variant
                        // Automatically assign the gender based on the existing variants
    
                        // Fetch the gender of an existing variant for the product
                        const [existingVariants] = await connection.query(
                            'SELECT DISTINCT gender FROM ProductVariant WHERE product_id = ? LIMIT 1',
                            [productId]
                        );
    
                        // If gender is found, use that; else default to 'Male'
                        const gender = existingVariants.length > 0 ? existingVariants[0].gender : 'Male';
    
                        // Insert the new variant with the assigned gender
                        await connection.query(
                            'INSERT INTO ProductVariant (product_id, gender, size, quantity) VALUES (?, ?, ?, ?)',
                            [productId, gender, size, quantity]
                        );
                        // Log the variant insertion activity
                        logLoginActivity(username, role, 'Success', `Update Product - Added new variant size: ${size} for product ID: ${productId} with gender: ${gender}`);
                    }
                }
    
                // Ensure the `updated_at` column in `Product` is updated when variants are modified
                await connection.query(
                    'UPDATE Product SET updated_at = NOW() WHERE product_id = ?',
                    [productId]
                );
    
                // Log the variant update activity
                logLoginActivity(username, role, 'Success', `Update Product - Updated variants for product ID: ${productId}`);
            }
    
            await connection.commit();
            connection.release();
            
            // Log the successful update activity
            logLoginActivity(username, role, 'Success', `Update Product - Successfully updated product ID: ${productId}`);
            
            res.status(200).json({ message: 'Product price and variants updated successfully' });
        } catch (err) {
            if (connection) {
                await connection.rollback();
                connection.release();
            }
            console.error(err);
            
            // Log the failed update activity
            logLoginActivity(username, role, 'Failed', `Update Product - Error updating product ID: ${productId}`);
            
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
                LIMIT 48
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
router.delete('/delete/:id', authMiddleware, async (req, res) => {
    const productId = req.params.id;
    const { username, role } = req.user; // Assuming `req.user` is set from the auth middleware

    const connection = await pool.getConnection().catch(err => {
        // Log the DB connection error
        logLoginActivity(username, role, 'Failed', `Delete Product - DB connection error for product ID: ${productId}`);
        return res.status(500).json({ error: 'DB connection error' });
    });

    try {
        await connection.beginTransaction();

        // Log the start of the deletion process
        logLoginActivity(username, role, 'Success', `Delete Product - Started deletion process for product ID: ${productId}`);

        // Delete product variants
        await connection.query('DELETE FROM ProductVariant WHERE product_id = ?', [productId]);

        // Delete the product itself
        await connection.query('DELETE FROM Product WHERE product_id = ?', [productId]);

        // Commit the transaction
        await connection.commit();

        // Log successful deletion
        logLoginActivity(username, role, 'Success', `Delete Product - Successfully deleted product ID: ${productId}`);

        // Return success response
        res.status(200).json({ message: 'Product and variants deleted' });
    } catch (err) {
        // Rollback in case of error
        await connection.rollback();

        // Log the error during deletion
        logLoginActivity(username, role, 'Failed', `Delete Product - Error during deletion of product ID: ${productId} - ${err.message}`);

        res.status(500).json({ error: 'Error during deletion' });
    } finally {
        // Release the DB connection
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
    const { search, category, gender } = req.query;

    if (!search && !category && !gender) {
        return res.status(400).json({ error: 'At least one query parameter (search, category, or gender) is required' });
    }

    try {
        const connection = await pool.getConnection();
        
        // Build the dynamic query and parameters
        let query = 'SELECT * FROM Product WHERE 1=1';
        const params = [];

        if (search) {
            query += ' AND Pname LIKE ?';
            params.push(`%${search}%`);
        }

        if (category) {
            query += ' AND category = ?';
            params.push(category);
        }

        if (gender) {
            query += ' AND gender = ?';
            params.push(gender);
        }

        const [results] = await connection.query(query, params);
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
            p.updated_at,
            p.description, 
            pv.gender, 
            pv.size, 
            pv.quantity,
            SUM(oi.quantity) AS total_sales, -- Add total sales for each product variant
            IFNULL(SUM(vs.view_count), 0) AS total_views -- Add total views for each product
        FROM 
            Product p
        LEFT JOIN 
            ProductVariant pv ON p.product_id = pv.product_id
        LEFT JOIN 
            OrderItem oi ON pv.variant_id = oi.product_variant_id -- Join with OrderItem to calculate sales
        LEFT JOIN 
            Shopviews vs ON p.product_id = vs.product_id -- Join with Viewshop to get views
        GROUP BY 
            p.product_id, pv.variant_id -- Group by product_id and variant_id to sum sales per variant
        ORDER BY 
            p.created_at DESC
    `;

    try {
        const connection = await pool.getConnection();
        const [results] = await connection.query(query);
        connection.release();

        // Organize products with their variants and views
        const products = results.reduce((acc, row) => {
            if (!acc[row.product_id]) {
                acc[row.product_id] = {
                    id: row.product_id,
                    Pname: row.Pname,
                    category: row.category,
                    description: row.description,
                    price: parseFloat(row.productPrice), // Ensure price is parsed as a number
                    date: row.created_at,
                    updated_at: row.updated_at,
                    images: row.images ? JSON.parse(row.images) : [], // Ensure images are parsed correctly
                    variants: [],
                    total_sales: 0, // Initialize total sales for the product
                    total_views: 0 // Initialize total views for the product
                };
            }

            // Add variants to product
            if (row.gender) {
                // Ensure sales and views are treated as numbers
                const sales = parseInt(row.total_sales) || 0; // Parse as number, default to 0 if null or undefined
                const views = parseInt(row.total_views) || 0; // Parse views as number, default to 0 if null or undefined

                acc[row.product_id].variants.push({
                    gender: row.gender,
                    size: row.size,
                    quantity: row.quantity,
                });

                // Sum total sales and total views for the product (across all variants)
                acc[row.product_id].total_sales += sales; // Sum sales as numbers
                acc[row.product_id].total_views += views; // Sum views as numbers
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

        // Convert the object to an array and sort by total views in descending order
        const sortedProducts = Object.values(products).sort((a, b) => b.total_views - a.total_views);

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
    const { username, role } = req.user; // Assuming authMiddleware sets req.user with username and role

    let connection;

    try {
        connection = await pool.getConnection();

        // Fetch account_id for the provided username
        const [result] = await connection.query(
            'SELECT account_id FROM Accounts WHERE username = ?',
            [username]
        );

        if (result.length === 0) {
            // Log invalid username activity
            logLoginActivity(username, role, 'Failed', `Preparing Order - Invalid username for order ID: ${order_id}`);
            return res.status(400).json({ error: 'Invalid username. No matching account found.' });
        }

        const account_id = result[0].account_id;

        // Update the order status
        const [updateResult] = await connection.query(
            'UPDATE Orders SET order_status = ?, prepared_by = ?, prepared_at = NOW() WHERE order_id = ?',
            ['Preparing', account_id, order_id]
        );

        if (updateResult.affectedRows === 0) {
            // Log if no matching order was found
            logLoginActivity(username, role, 'Failed', `Preparing Order - No matching order for ID: ${order_id}`);
            return res.status(404).json({ message: 'Order not found.' });
        }

        // Log the successful update activity
        logLoginActivity(username, role, 'Success', `Preparing Order - Order ID: ${order_id} updated to Preparing by account ID: ${account_id}`);

        res.status(200).json({ message: 'Order status updated to Preparing.' });
    } catch (error) {
        console.error('Error updating order status:', error);

        // Log the error during the update
        logLoginActivity(username, role, 'Failed', `Preparing Order - Error updating order ID: ${order_id}`);

        res.status(500).json({ error: 'Error updating order status.' });
    } finally {
        if (connection) connection.release();
    }
});

router.put('/ship-order/:order_id', authMiddleware, roleCheckMiddleware(['admin', 'employee']), async (req, res) => {
    const { order_id } = req.params;
    const { tracking_number, carrier } = req.body;
    const { username, role } = req.user;

    if (!tracking_number || !carrier) {
        return res.status(400).json({ message: 'Tracking number and carrier are required.' });
    }

    try {
        const [order] = await pool.query('SELECT * FROM Orders WHERE order_id = ?', [order_id]);

        if (order.length === 0) {
            logLoginActivity(username, role, 'Failed', `Ship Order - Order not found for ID: ${order_id}`);
            return res.status(404).json({ message: 'Order not found.' });
        }

        if (['Shipped', 'Delivered'].includes(order[0].order_status)) {
            logLoginActivity(username, role, 'Failed', `Ship Order - Order ${order_id} is already ${order[0].order_status.toLowerCase()}.`);
            return res.status(400).json({ message: `Order is already ${order[0].order_status.toLowerCase()}.` });
        }

        const [existingTracking] = await pool.query(
            'SELECT * FROM Orders WHERE tracking_number = ? AND carrier = ?',
            [tracking_number, carrier]
        );

        if (existingTracking.length > 0) {
            logLoginActivity(username, role, 'Failed', `Ship Order - Tracking number ${tracking_number} is already in use for carrier ${carrier}.`);
            return res.status(400).json({
                message: `Tracking number "${tracking_number}" is already in use for carrier "${carrier}".`
            });
        }

        await pool.query(
            'UPDATE Orders SET order_status = ?, tracking_number = ?, carrier = ?, shipped_at = NOW() WHERE order_id = ?',
            ['Shipped', tracking_number, carrier, order_id]
        );

        // Log the successful status update
        logLoginActivity(username, role, 'Success', `Ship Order - Order ${order_id} marked as Shipped.`);

        // Auto-update to "Delivered"
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
        logLoginActivity(username, role, 'Failed', `Ship Order - Error updating status for order ID: ${order_id}`);
        res.status(500).json({ error: 'Error updating order status.' });
    }
});

router.put('/deliver-order/:order_id', authMiddleware, async (req, res) => {
    const { order_id } = req.params;
    const { username, role } = req.user;

    try {
        const [order] = await pool.query('SELECT * FROM Orders WHERE order_id = ?', [order_id]);

        if (order.length === 0) {
            logLoginActivity(username, role, 'Failed', `Deliver Order - Order not found for ID: ${order_id}`);
            return res.status(404).json({ message: 'Order not found.' });
        }

        if (order[0].order_status === 'Delivered') {
            logLoginActivity(username, role, 'Failed', `Deliver Order - Order ${order_id} is already delivered.`);
            return res.status(400).json({ message: 'Order is already delivered.' });
        }

        await pool.query(
            'UPDATE Orders SET order_status = ?, delivered_at = NOW(), date_received = NOW() WHERE order_id = ?',
            ['Delivered', order_id]
        );

        logLoginActivity(username, role, 'Success', `Deliver Order - Order ${order_id} marked as Delivered.`);
        res.status(200).json({ message: 'Order status updated to Delivered.' });
    } catch (error) {
        console.error('Error updating order status:', error);
        logLoginActivity(username, role, 'Failed', `Deliver Order - Error updating status for order ID: ${order_id}`);
        res.status(500).json({ error: 'Error updating order status.' });
    }
});

router.put('/cancel/:id/status', authMiddleware, async (req, res) => {
    const order_id = req.params.id; // Extract order ID from the request parameters
    const { status, cancel_reason } = req.body; // Expect status and cancel_reason in the request body
    const { username, role } = req.user; // Get the username and role from the authenticated user

    try {
        // Fetch the current order status
        const [order] = await pool.query('SELECT order_status FROM Orders WHERE order_id = ?', [order_id]);

        if (order.length === 0) {
            // Log failed cancellation attempt if the order is not found
            if (role === 'customer') {
                await logCustomerActivity(username, `Order not found for ID: ${order_id}`, 'Cancel Order - Failed');
            } else {
                await logLoginActivity(username, role, 'Failed', `Cancel Order - Order not found for ID: ${order_id}`);
            }
            return res.status(404).json({ message: 'Order not found' });
        }

        const currentStatus = order[0].order_status;

        if (currentStatus !== 'Pending') {
            // Log failed cancellation attempt if the order is not in 'Pending' status
            if (role === 'customer') {
                await logCustomerActivity(username, `Order ${order_id} cannot be cancelled as it is not in Pending status.`, 'Cancel Order - Failed');
            } else {
                await logLoginActivity(username, role, 'Failed', `Cancel Order - Order ${order_id} cannot be cancelled as it is not in Pending status.`);
            }
            return res.status(400).json({ message: 'Order can only be cancelled if it is in "Pending" status.' });
        }

        if (status === 'Cancelled' && !cancel_reason) {
            return res.status(400).json({ message: 'Cancel reason is required when status is "Cancelled".' });
        }

        const reasonToSet = cancel_reason || null;

        // Update the order status to "Cancelled" and set the cancel reason
        const [result] = await pool.query(
            'UPDATE Orders SET order_status = ?, cancel_reason = ? WHERE order_id = ?',
            ['Cancelled', reasonToSet, order_id]
        );

        if (result.affectedRows === 0) {
            // Log failed cancellation attempt if the order is already cancelled or does not exist
            if (role === 'customer') {
                await logCustomerActivity(username, `Order ${order_id} already cancelled or does not exist.`, 'Cancel Order - Failed');
            } else {
                await logLoginActivity(username, role, 'Failed', `Cancel Order - Order ${order_id} already cancelled or does not exist.`);
            }
            return res.status(404).json({ message: 'Order not found or already cancelled' });
        }

        // Log success or failure depending on the user role (customer or admin)
        if (role === 'customer') {
            // Log customer cancellation (this is where we log to the customer log)
            await logCustomerActivity(username, `Order ${order_id} successfully cancelled.`, 'Cancel Order - Success');
        } else if (role === 'admin') {
            // Log admin cancellation (this is where we log to the admin log)
            await logLoginActivity(username, role, 'Success', `Admin cancelled order ${order_id}. Reason: ${reasonToSet}`);
        }

        // Return success response
        res.status(200).json({ message: 'Order successfully cancelled', cancel_reason: reasonToSet });
    } catch (error) {
        console.error('Error updating order status:', error);

        // Log error in case of an exception
        if (role === 'customer') {
            await logCustomerActivity(username, `Error cancelling order ID: ${order_id}`, 'Cancel Order - Failed');
        } else {
            await logLoginActivity(username, role, 'Failed', `Cancel Order - Error cancelling order ID: ${order_id}`);
        }

        res.status(500).json({ error: 'An error occurred while cancelling the order' });
    }
});



router.put('/ship-order/:order_id', authMiddleware, roleCheckMiddleware(['admin', 'employee']), async (req, res) => {
    const { order_id } = req.params;
    const { tracking_number, carrier } = req.body;
    const { username, role } = req.user;

    if (!tracking_number || !carrier) {
        return res.status(400).json({ message: 'Tracking number and carrier are required.' });
    }

    try {
        const [order] = await pool.query('SELECT * FROM Orders WHERE order_id = ?', [order_id]);

        if (order.length === 0) {
            logLoginActivity(username, role, 'Failed', `Ship Order - Order not found for ID: ${order_id}`);
            return res.status(404).json({ message: 'Order not found.' });
        }

        if (['Shipped', 'Delivered'].includes(order[0].order_status)) {
            logLoginActivity(username, role, 'Failed', `Ship Order - Order ${order_id} is already ${order[0].order_status.toLowerCase()}.`);
            return res.status(400).json({ message: `Order is already ${order[0].order_status.toLowerCase()}.` });
        }

        const [existingTracking] = await pool.query(
            'SELECT * FROM Orders WHERE tracking_number = ? AND carrier = ?',
            [tracking_number, carrier]
        );

        if (existingTracking.length > 0) {
            logLoginActivity(username, role, 'Failed', `Ship Order - Tracking number ${tracking_number} is already in use for carrier ${carrier}.`);
            return res.status(400).json({
                message: `Tracking number "${tracking_number}" is already in use for carrier "${carrier}".`
            });
        }

        await pool.query(
            'UPDATE Orders SET order_status = ?, tracking_number = ?, carrier = ?, shipped_at = NOW() WHERE order_id = ?',
            ['Shipped', tracking_number, carrier, order_id]
        );

        // Log the successful status update
        logLoginActivity(username, role, 'Success', `Ship Order - Order ${order_id} marked as Shipped.`);

        // Auto-update to "Delivered"
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
        logLoginActivity(username, role, 'Failed', `Ship Order - Error updating status for order ID: ${order_id}`);
        res.status(500).json({ error: 'Error updating order status.' });
    }
});

router.put('/deliver-order/:order_id', authMiddleware, async (req, res) => {
    const { order_id } = req.params;
    const { username, role } = req.user; // Extract role from req.user

    console.log('User Role:', role);  // Debugging log to check role

    try {
        const [order] = await pool.query('SELECT * FROM Orders WHERE order_id = ?', [order_id]);

        if (order.length === 0) {
            console.log('Order not found for ID:', order_id); // Debugging log
            if (role === 'admin') {
                logLoginActivity(username, role, 'Failed', `Deliver Order - Order not found for ID: ${order_id}`);
            } else if (role === 'customer') {
                logCustomerActivity(username, 'Failed', `Deliver Order - Order not found for ID: ${order_id}`);
            }
            return res.status(404).json({ message: 'Order not found.' });
        }

        if (order[0].order_status === 'Delivered') {
            console.log('Order already delivered:', order_id); // Debugging log
            if (role === 'admin') {
                logLoginActivity(username, role, 'Failed', `Deliver Order - Order ${order_id} is already delivered.`);
            } else if (role === 'customer') {
                logCustomerActivity(username, 'Failed', `Deliver Order - Order ${order_id} is already delivered.`);
            }
            return res.status(400).json({ message: 'Order is already delivered.' });
        }

        await pool.query(
            'UPDATE Orders SET order_status = ?, delivered_at = NOW(), date_received = NOW() WHERE order_id = ?',
            ['Delivered', order_id]
        );

        // Log success for both sheets
        // Log to Admin Sheet
        logLoginActivity(username, role, 'Success', `Deliver Order - Order ${order_id} marked as Delivered.`);

        // Log to Customer Sheet (if the user is a customer)
        if (role === 'customer') {
            logCustomerActivity(username, 'Success', `Deliver Order - Order ${order_id} marked as Delivered.`);
        } else {
            // If the user is an admin, log this as well in the customer log
            logCustomerActivity(username, 'Success', `Admin delivered Order ${order_id}.`);
        }

        res.status(200).json({ message: 'Order status updated to Delivered.' });
    } catch (error) {
        console.error('Error updating order status:', error);
        if (role === 'admin') {
            logLoginActivity(username, role, 'Failed', `Deliver Order - Error updating status for order ID: ${order_id}`);
        } else if (role === 'customer') {
            logCustomerActivity(username, 'Failed', `Deliver Order - Error updating status for order ID: ${order_id}`);
        }
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
                    Orders.order_id, 
                    Orders.account_id,
                    Orders.total_amount,
                    Orders.order_status,
                    Orders.created_at,
                    Orders.shipped_at,
                    Orders.date_received,
                    Orders.delivered_at,
                    Orders.tracking_number,
                    Orders.carrier,
                    Orders.cancel_reason,
                    CONCAT(Accounts.fname, ' ', Accounts.lname) AS name,
                    Accounts.email,
                    Accounts.phone,
                    Accounts.address,
                    Orders.prepared_at,
                    PreparedBy.username
                FROM Orders
                JOIN Accounts ON Orders.account_id = Accounts.account_id
                LEFT JOIN Accounts AS PreparedBy ON Orders.prepared_by = PreparedBy.account_id
                WHERE Orders.order_id = ?
            `, [order_id]);

            if (order.length === 0) {
                return res.status(404).json({ message: 'Order not found' });
            }

            // Format the 'prepared_at' date
            const formatDate = (dateString) => {
                const date = new Date(dateString);
                const month = String(date.getMonth() + 1).padStart(2, '0'); // Get month (0-11) and pad it
                const day = String(date.getDate()).padStart(2, '0'); // Get day (1-31) and pad it
                const year = String(date.getFullYear()).slice(2); // Get last two digits of the year
                return `${month}/${day}/${year}`;
            };

            // Format only the 'prepared_at' date
            if (order[0].prepared_at) {
                order[0].prepared_at = formatDate(order[0].prepared_at);
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
                order: order[0], // Order with formatted 'prepared_at' field
                items: itemsWithImages
            });
        } else {
            // For non-admin users, ensure that the order belongs to the current user
            const [order] = await pool.query(`
                SELECT 
                    Orders.order_id,
                    Orders.account_id,
                    Orders.total_amount,
                    Orders.order_status,
                    Orders.created_at,
                    Orders.shipped_at,
                    Orders.date_received,
                    Orders.delivered_at,
                    Orders.tracking_number,
                    Orders.carrier,
                    Orders.cancel_reason,
                    CONCAT(Accounts.fname, ' ', Accounts.lname) AS name, 
                    Accounts.email,
                    Accounts.phone,
                    Accounts.address,
                    Orders.prepared_at,
                    PreparedBy.username
                FROM Orders
                JOIN Accounts ON Orders.account_id = Accounts.account_id
                LEFT JOIN Accounts AS PreparedBy ON Orders.prepared_by = PreparedBy.account_id
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
                order: order[0], // Order with formatted 'prepared_at' field
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
    const { status, cancel_reason } = req.body; // Expect status and cancel_reason in the request body
    const { username, role } = req.user; // Get the username and role from the authenticated user

    try {
        // Fetch the current order status
        const [order] = await pool.query('SELECT order_status FROM Orders WHERE order_id = ?', [order_id]);

        if (order.length === 0) {
            // Log failed cancellation attempt if the order is not found
            if (role === 'customer') {
                await logCustomerActivity(username, `Order not found for ID: ${order_id}`, 'customer', 'Cancel Order - Failed');
            } else {
                await logLoginActivity(username, role, 'Failed', `Cancel Order - Order not found for ID: ${order_id}`);
            }
            return res.status(404).json({ message: 'Order not found' });
        }

        const currentStatus = order[0].order_status;

        if (currentStatus !== 'Pending') {
            // Log failed cancellation attempt if the order is not in 'Pending' status
            if (role === 'customer') {
                await logCustomerActivity(username, `Order ${order_id} cannot be cancelled as it is not in Pending status.`, 'customer', 'Cancel Order - Failed');
            } else {
                await logLoginActivity(username, role, 'Failed', `Cancel Order - Order ${order_id} cannot be cancelled as it is not in Pending status.`);
            }
            return res.status(400).json({ message: 'Order can only be cancelled if it is in "Pending" status.' });
        }

        if (status === 'Cancelled' && !cancel_reason) {
            return res.status(400).json({ message: 'Cancel reason is required when status is "Cancelled".' });
        }

        const reasonToSet = cancel_reason || null;

        // Update the order status to "Cancelled" and set the cancel reason
        const [result] = await pool.query(
            'UPDATE Orders SET order_status = ?, cancel_reason = ? WHERE order_id = ?',
            ['Cancelled', reasonToSet, order_id]
        );

        if (result.affectedRows === 0) {
            // Log failed cancellation attempt if the order is already cancelled or does not exist
            if (role === 'customer') {
                await logCustomerActivity(username, `Order ${order_id} already cancelled or does not exist.`, 'customer', 'Cancel Order - Failed');
            } else {
                await logLoginActivity(username, role, 'Failed', `Cancel Order - Order ${order_id} already cancelled or does not exist.`);
            }
            return res.status(404).json({ message: 'Order not found or already cancelled' });
        }

        // Log success or failure depending on the user role (customer or admin)
        if (role === 'customer') {
            // Log customer cancellation (this is where we log to the customer log)
            await logCustomerActivity(username, `Order ${order_id} successfully cancelled.`, 'customer', 'Cancel Order - Success');
        } else if (role === 'admin') {
            // Log admin cancellation (this is where we log to the admin log)
            await logLoginActivity(username, role, 'Success', `Admin cancelled order ${order_id}. Reason: ${reasonToSet}`);
        }

        // Return success response
        res.status(200).json({ message: 'Order successfully cancelled', cancel_reason: reasonToSet });
    } catch (error) {
        console.error('Error updating order status:', error);

        // Log error in case of an exception
        if (role === 'customer') {
            await logCustomerActivity(username, `Error cancelling order ID: ${order_id}`, 'customer', 'Cancel Order - Failed');
        } else {
            await logLoginActivity(username, role, 'Failed', `Cancel Order - Error cancelling order ID: ${order_id}`);
        }
        
        res.status(500).json({ error: 'An error occurred while cancelling the order' });
    }
});





router.get('/sales/sales', async (req, res) => {
    const todayStart = moment().startOf('day').format('YYYY-MM-DD HH:mm:ss');
    const weekStart = moment().startOf('week').format('YYYY-MM-DD HH:mm:ss');
    const monthStart = moment().startOf('month').format('YYYY-MM-DD HH:mm:ss');

    try {
        // Existing sales calculations
        const [salesToday] = await pool.query('SELECT SUM(total_amount) AS total FROM Orders WHERE delivered_at >= ?', [todayStart]);
        const [salesWeekly] = await pool.query('SELECT SUM(total_amount) AS total FROM Orders WHERE delivered_at >= ?', [weekStart]);
        const [salesMonthly] = await pool.query('SELECT SUM(total_amount) AS total FROM Orders WHERE delivered_at >= ?', [monthStart]);

        // New calculations for total cancelled and delivered orders
        const [cancelledOrdersTotal] = await pool.query('SELECT COUNT(*) AS cancelled FROM Orders WHERE order_status = "cancelled"');
        const [deliveredOrdersTotal] = await pool.query('SELECT COUNT(*) AS delivered FROM Orders WHERE order_status = "delivered"');

        res.status(200).json({
            salesToday: salesToday[0]?.total || 0,
            salesWeekly: salesWeekly[0]?.total || 0,
            salesMonthly: salesMonthly[0]?.total || 0,
            cancelledOrdersTotal: cancelledOrdersTotal[0]?.cancelled || 0,
            deliveredOrdersTotal: deliveredOrdersTotal[0]?.delivered || 0
        });
    } catch (err) {
        res.status(500).json({ error: 'Error retrieving sales data' });
    }
});




module.exports = router;
