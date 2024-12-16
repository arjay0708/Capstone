const express = require('express');
const router = express.Router();
const pool = require('./connection');
const nodemailer = require('nodemailer');
const { authMiddleware, roleCheckMiddleware } = require('./authMiddleware');
const Paymongo = require('paymongo'); // Initialize PayMongo

const paymongo = new Paymongo('sk_test_MSHiWbz5qZgiBEirfabCsFqC');

// Function to send the order confirmation email
// Updated sendOrderConfirmationEmail
const sendOrderConfirmationEmail = async (userEmail, orderDetails, username) => {
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,     // Use the EMAIL_USER from .env
            pass: process.env.EMAIL_PASSWORD, // Use the EMAIL_PASSWORD from .env
        },
    });

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: userEmail,
        subject: `Order Confirmation`,
        html: `
            <h1>Order Confirmation</h1>
            <p>Hi ${username},</p>
            <p>Thank you for your order!</p>
            <h3>Order Details:</h3>
            <ul>
                ${orderDetails.items
                    .map(item => `
                        <li>
                            <strong>Product Name:</strong> ${item.Pname} <br>
                            <strong>Size:</strong> ${item.size} <br>
                            <strong>Quantity:</strong> ${item.order_quantity} <br>
                            <strong>Price:</strong> ₱${Number(item.price).toFixed(2)}
                        </li>
                    `).join('')}
            </ul>
            <p><strong>Delivery Fee:</strong> ₱${orderDetails.delivery_fee.toFixed(2)}</p>
            <p><strong>Total Amount:</strong> ₱${orderDetails.total_amount.toFixed(2)}</p>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log('Order confirmation email sent!');
    } catch (error) {
        console.error('Error sending email:', error);
    }
};


// Add item to cart (requires authentication)
router.post('/add-to-cart', authMiddleware, async (req, res) => {
    const { product_variant_id, quantity } = req.body;
    const account_id = req.user.account_id; // Retrieved from the middleware

    try {
        if (!product_variant_id || !quantity || quantity <= 0) {
            return res.status(400).json({ error: 'Valid Product Variant ID and Quantity are required' });
        }

        // Check the available quantity of the product variant
        const [variant] = await pool.query(
            'SELECT quantity AS available_quantity FROM ProductVariant WHERE variant_id = ?',
            [product_variant_id]
        );

        if (variant.length === 0) {
            return res.status(404).json({ error: 'Product variant not found' });
        }

        const availableQuantity = variant[0].available_quantity;

        if (quantity > availableQuantity) {
            return res.status(400).json({ error: `Only ${availableQuantity} unit(s) available for this product variant` });
        }

        // Check if the user has an existing cart
        let [cart] = await pool.query('SELECT * FROM Cart WHERE account_id = ?', [account_id]);

        if (cart.length === 0) {
            // Create a new cart if none exists
            const [newCart] = await pool.query('INSERT INTO Cart (account_id) VALUES (?)', [account_id]);
            cart = { cart_id: newCart.insertId };
        } else {
            cart = cart[0];
        }

        // Check if the item already exists in the cart
        const [existingItem] = await pool.query(
            'SELECT * FROM CartItem WHERE cart_id = ? AND product_variant_id = ?',
            [cart.cart_id, product_variant_id]
        );

        if (existingItem.length > 0) {
            const newQuantity = existingItem[0].quantity + quantity;

            if (newQuantity > availableQuantity) {
                return res.status(400).json({
                    error: `Adding this quantity exceeds available stock. Maximum allowed is ${availableQuantity - existingItem[0].quantity}.`
                });
            }

            // Update the quantity if item already exists
            await pool.query(
                'UPDATE CartItem SET quantity = ? WHERE cart_id = ? AND product_variant_id = ?',
                [newQuantity, cart.cart_id, product_variant_id]
            );
        } else {
            // Insert new item if it doesn't exist in the cart
            if (quantity > availableQuantity) {
                return res.status(400).json({ error: `Only ${availableQuantity} unit(s) available for this product variant` });
            }

            await pool.query(
                'INSERT INTO CartItem (cart_id, product_variant_id, quantity) VALUES (?, ?, ?)',
                [cart.cart_id, product_variant_id, quantity]
            );
        }

        res.status(200).json({ message: 'Item added to cart successfully' });
    } catch (error) {
        console.error('Error adding item to cart:', error);
        res.status(500).json({ error: 'Error adding item to cart' });
    }
});

// View cart for a specific account (requires authentication)
router.get('/view', authMiddleware, async (req, res) => {
    const account_id = req.user.account_id; // Retrieved from the middleware

    try {
        // Retrieve cart by account ID
        const [cart] = await pool.query('SELECT * FROM Cart WHERE account_id = ?', [account_id]);

        if (cart.length === 0) {
            return res.status(200).json({ message: 'Your cart is empty', items: [] });
        }

        const cart_id = cart[0].cart_id;

        // Retrieve items in the cart along with product and variant details
        const [items] = await pool.query(
            `SELECT 
                CartItem.cart_item_id,
                CartItem.product_variant_id,
                CartItem.quantity,
                ProductVariant.size,
                ProductVariant.gender,
                ProductVariant.quantity AS available_quantity,
                Product.price,
                Product.Pname,
                Product.images
             FROM CartItem 
             JOIN ProductVariant ON CartItem.product_variant_id = ProductVariant.variant_id
             JOIN Product ON ProductVariant.product_id = Product.product_id
             WHERE CartItem.cart_id = ?`,
            [cart_id]
        );

        if (items.length === 0) {
            return res.status(200).json({ message: 'Your cart is empty', items: [] });
        }

        // Parse images and update them to include full Cloudinary URL
        const updatedItems = items.map(item => {
            // Assuming 'images' is a JSON array stored in the 'Product' table
            const images = JSON.parse(item.images).map(image => {
                // Construct the Cloudinary URL
                return `https://res.cloudinary.com/duqbdikz0/image/upload/v1733890541/${image}`;
            });
            return { ...item, images };
        });

        res.status(200).json({
            cart_id,
            account_id,
            items: updatedItems
        });
    } catch (error) {
        console.error('Error viewing cart:', error);
        res.status(500).json({ error: 'Error retrieving cart' });
    }
});

router.delete('/remove/:cart_item_id', authMiddleware, async (req, res) => {
    const { cart_item_id } = req.params;
    const account_id = req.user.account_id;

    try {
        // Verify the cart item belongs to the user's cart
        const [cartItem] = await pool.query(
            `SELECT CartItem.cart_item_id 
             FROM CartItem 
             JOIN Cart ON CartItem.cart_id = Cart.cart_id 
             WHERE CartItem.cart_item_id = ? AND Cart.account_id = ?`,
            [cart_item_id, account_id]
        );

        if (cartItem.length === 0) {
            return res.status(404).json({ message: 'Cart item not found or does not belong to this account' });
        }

        // Delete the cart item
        await pool.query('DELETE FROM CartItem WHERE cart_item_id = ?', [cart_item_id]);

        res.status(200).json({ message: 'Product removed from cart successfully' });
    } catch (error) {
        console.error('Error removing product from cart:', error);
        res.status(500).json({ error: 'Error removing product from cart' });
    }
});

// router.post('/create-order', authMiddleware, async (req, res) => {
//     const account_id = req.user.account_id;
//     const { cart_item_ids, payment_method, payment_details } = req.body;

//     // Ensure cart items are selected
//     if (!cart_item_ids || cart_item_ids.length === 0) {
//         return res.status(400).json({ message: 'No cart items selected for order' });
//     }

//     try {
//         // Validate cart items for the user's account
//         const [cartItems] = await pool.query(
//             `SELECT 
//                 CartItem.cart_item_id,
//                 CartItem.product_variant_id,
//                 CartItem.quantity AS order_quantity,
//                 ProductVariant.quantity AS available_quantity,
//                 Product.price,
//                 Product.Pname,
//                 ProductVariant.size
//              FROM CartItem
//              JOIN ProductVariant ON CartItem.product_variant_id = ProductVariant.variant_id
//              JOIN Product ON ProductVariant.product_id = Product.product_id
//              JOIN Cart ON CartItem.cart_id = Cart.cart_id
//              WHERE CartItem.cart_item_id IN (?) AND Cart.account_id = ?`,
//             [cart_item_ids, account_id]
//         );

//         if (cartItems.length === 0) {
//             return res.status(404).json({ message: 'No valid cart items found for this account' });
//         }

//         let totalAmount = 0;
//         let totalQuantity = 0;
//         const items = [];

//         // Process each cart item
//         for (const item of cartItems) {
//             if (item.order_quantity > item.available_quantity) {
//                 return res.status(400).json({
//                     message: `Insufficient stock for item ID ${item.product_variant_id}.`
//                 });
//             }
//             totalAmount += item.price * item.order_quantity;
//             totalQuantity += item.order_quantity;
//             items.push(item);
//         }

//         // Delivery fee logic: base 100 PHP, + 20 PHP for each additional item
//         const deliveryFee = 100 + (totalQuantity - 1) * 20;
//         const finalAmount = totalAmount + deliveryFee;

//         // Fetch the username from the database
//         const [userDetails] = await pool.query('SELECT username, email FROM Accounts WHERE account_id = ?', [account_id]);

//         if (!userDetails || userDetails.length === 0) {
//             return res.status(404).json({ message: 'User not found' });
//         }

//         const username = userDetails[0].username;
//         const userEmail = userDetails[0].email;

//         // Handle payment creation or skipping based on the payment method
//         if (payment_method === 'online') {
//             try {
//                 // Ensure the method inside payment_details is correctly defined
//                 const allowedPaymentMethods = ['gcash', 'card'];
//                 const paymentMethod = payment_details?.method;  // Safely extract payment method

//                 if (!allowedPaymentMethods.includes(paymentMethod)) {
//                     return res.status(400).json({ message: 'Invalid payment method for online payment' });
//                 }

//                 // Ensure payment method is not blank and structure is correct
//                 if (!paymentMethod) {
//                     return res.status(400).json({ message: 'Payment method cannot be empty' });
//                 }

//                 // Create the PayMongo payment intent
//                 const paymentIntent = await paymongo.paymentIntents.create({
//                     amount: finalAmount * 100,  // Convert to centavos
//                     currency: 'PHP',            // Ensure currency is PHP
//                     description: `Order Total Amount: PHP ${finalAmount}`,  // Payment description
//                     metadata: { order_id: 'temporary_order_id' },  // Add a temporary order ID placeholder
//                     payment_method_allowed: [paymentMethod],  // Ensure this is an array with the selected payment method
//                     payment_method: { type: paymentMethod }, // Correctly pass the payment method as an object
//                     statement_descriptor: 'Order Payment',  // Payment description for statement
//                 });

//                 // Check if the payment intent is successfully created and has the correct status
//                 if (!paymentIntent || paymentIntent.data.attributes.status !== 'pending') {
//                     return res.status(500).json({ error: 'Payment creation failed. Please try again.' });
//                 }

//                 const paymentUrl = paymentIntent.data.attributes.next_action.redirect.url;

//                 // 1. Insert the order into the database with a placeholder order ID (for now)
//                 const [newOrder] = await pool.query(
//                     'INSERT INTO Orders (account_id, total_amount, payment_method, payment_status) VALUES (?, ?, ?, ?)',
//                     [account_id, finalAmount, payment_method, 'pending']  // Payment status set to 'pending' for online payments
//                 );
//                 const order_id = newOrder.insertId;  // Now we have the order_id

//                 // 2. Update the payment intent metadata with the correct order ID
//                 await paymongo.paymentIntents.update(paymentIntent.data.id, {
//                     metadata: { order_id: order_id }
//                 });

//                 // 3. Insert items into the OrderItem table and update inventory
//                 for (const item of cartItems) {
//                     await pool.query(
//                         'INSERT INTO OrderItem (order_id, product_variant_id, quantity, price_at_purchase) VALUES (?, ?, ?, ?)',
//                         [order_id, item.product_variant_id, item.order_quantity, item.price]
//                     );
//                     await pool.query(
//                         'UPDATE ProductVariant SET quantity = quantity - ? WHERE variant_id = ?',
//                         [item.order_quantity, item.product_variant_id]
//                     );
//                 }

//                 // 4. Remove processed cart items
//                 await pool.query('DELETE FROM CartItem WHERE cart_item_id IN (?)', [cart_item_ids]);

//                 // 5. Send the order confirmation email with username
//                 const orderDetails = {
//                     order_id,
//                     total_amount: finalAmount,
//                     delivery_fee: deliveryFee,
//                     items,
//                 };

//                 // Send email with the username
//                 await sendOrderConfirmationEmail(userEmail, orderDetails, username);

//                 // 6. Return response to the user
//                 res.status(200).json({
//                     message: 'Order placed successfully, please proceed with payment',
//                     order_id,
//                     payment_url: paymentUrl,
//                     payment_method: 'online',
//                 });

//             } catch (error) {
//                 console.error('Error creating payment intent:', error);
//                 return res.status(500).json({ error: `Error creating payment intent: ${error.message}` });
//             }
//         } else if (payment_method === 'cod') {
//             // For Cash on Delivery (COD), set the payment status to 'approved'
//             try {
//                 // Insert the order into the database with COD status (approved)
//                 const [newOrder] = await pool.query(
//                     'INSERT INTO Orders (account_id, total_amount, payment_method, payment_status) VALUES (?, ?, ?, ?)',
//                     [account_id, finalAmount, 'cod', 'approved']  // Payment status set to 'approved' for COD
//                 );
//                 const order_id = newOrder.insertId;

//                 // Insert items into the OrderItem table and update inventory
//                 for (const item of cartItems) {
//                     await pool.query(
//                         'INSERT INTO OrderItem (order_id, product_variant_id, quantity, price_at_purchase) VALUES (?, ?, ?, ?)',
//                         [order_id, item.product_variant_id, item.order_quantity, item.price]
//                     );
//                     await pool.query(
//                         'UPDATE ProductVariant SET quantity = quantity - ? WHERE variant_id = ?',
//                         [item.order_quantity, item.product_variant_id]
//                     );
//                 }

//                 // Remove processed cart items
//                 await pool.query('DELETE FROM CartItem WHERE cart_item_id IN (?)', [cart_item_ids]);

//                 // Send the order confirmation email with username
//                 const orderDetails = {
//                     order_id,
//                     total_amount: finalAmount,
//                     delivery_fee: deliveryFee,
//                     items,
//                 };

//                 // Send email with the username
//                 await sendOrderConfirmationEmail(userEmail, orderDetails, username);

//                 // Return response to the user
//                 res.status(200).json({
//                     message: 'Order placed successfully. Cash on Delivery selected.',
//                     order_id,
//                     payment_method: 'cod',
//                 });
//             } catch (error) {
//                 console.error('Error processing COD order:', error);
//                 return res.status(500).json({ error: 'Error placing COD order. Please try again.' });
//             }
//         } else {
//             return res.status(400).json({ message: 'Invalid payment method selected' });
//         }
//     } catch (error) {
//         console.error('Error placing order:', error);
//         res.status(500).json({ error: 'Error placing order. Please try again.' });
//     }
// });

router.post('/create-order', authMiddleware, async (req, res) => {
    const account_id = req.user.account_id;
    const { cart_item_ids } = req.body; // Array of selected cart item IDs

    if (!cart_item_ids || cart_item_ids.length === 0) {
        return res.status(400).json({ message: 'No cart items selected for order' });
    }

    try {
        // Validate that the selected cart items belong to the user's cart
        const [cartItems] = await pool.query(
            `SELECT 
                CartItem.cart_item_id,
                CartItem.product_variant_id,
                CartItem.quantity AS order_quantity,
                ProductVariant.quantity AS available_quantity,
                Product.price,
                Product.Pname,
                ProductVariant.size
             FROM CartItem
             JOIN ProductVariant ON CartItem.product_variant_id = ProductVariant.variant_id
             JOIN Product ON ProductVariant.product_id = Product.product_id
             JOIN Cart ON CartItem.cart_id = Cart.cart_id
             WHERE CartItem.cart_item_id IN (?) AND Cart.account_id = ?`,
            [cart_item_ids, account_id]
        );

        if (cartItems.length === 0) {
            return res.status(404).json({ message: 'No valid cart items found for this account' });
        }

        let totalAmount = 0;
        let totalQuantity = 0;

        // Check stock availability and calculate total amount
        cartItems.forEach(item => {
            if (item.order_quantity > item.available_quantity) {
                throw new Error(`Insufficient stock for item ID ${item.product_variant_id}`);
            }
            totalAmount += item.price * item.order_quantity;
            totalQuantity += item.order_quantity;
        });

        // Delivery fee logic: base 100 PHP + 20 PHP per additional item
        const deliveryFee = 100 + (totalQuantity - 1) * 20;
        const finalAmount = totalAmount + deliveryFee;

        // Create the order in the database
        const [newOrder] = await pool.query(
            'INSERT INTO Orders (account_id, total_amount) VALUES (?, ?)',
            [account_id, finalAmount]
        );
        const order_id = newOrder.insertId;

        // Insert order items and update product stock
        for (const item of cartItems) {
            await pool.query(
                'INSERT INTO OrderItem (order_id, product_variant_id, quantity, price_at_purchase) VALUES (?, ?, ?, ?)',
                [order_id, item.product_variant_id, item.order_quantity, item.price]
            );

            await pool.query(
                'UPDATE ProductVariant SET quantity = quantity - ? WHERE variant_id = ?',
                [item.order_quantity, item.product_variant_id]
            );
        }

        // Remove the selected items from the cart
        await pool.query('DELETE FROM CartItem WHERE cart_item_id IN (?)', [cart_item_ids]);

        // Fetch user's email and username
        const [userResult] = await pool.query(
            'SELECT email, username FROM Accounts WHERE account_id = ?',
            [account_id]
        );

        if (!userResult || userResult.length === 0) {
            return res.status(404).json({ message: 'User account not found' });
        }

        const { email: userEmail, username } = userResult[0];

        // Prepare order details for the email
        const orderDetails = {
            order_id,
            total_amount: finalAmount, // Total includes delivery fee
            delivery_fee: deliveryFee,
            items: cartItems.map(item => ({
                Pname: item.Pname,
                size: item.size,
                order_quantity: item.order_quantity,
                price: item.price, // Include product price
            })),
        };

        // Send order confirmation email
        await sendOrderConfirmationEmail(userEmail, orderDetails, username);

        // Send response to the client
        res.status(200).json({
            message: 'Order placed successfully',
            order_id,
            totalAmount: finalAmount,
        });
    } catch (error) {
        console.error('Error placing order:', error);
        const errorMessage = error.message || 'Error placing order';
        res.status(500).json({ error: errorMessage });
    }
});



module.exports = router;