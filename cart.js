const express = require('express');
const router = express.Router();
const pool = require('./connection');
const { authMiddleware, roleCheckMiddleware } = require('./authMiddleware');

// Add item to cart (requires authentication)
router.post('/add-to-cart', authMiddleware, async (req, res) => {
    const { product_variant_id, quantity } = req.body;
    const account_id = req.user.account_id; // Retrieved from the middleware

    try {
        if (!product_variant_id || !quantity || quantity <= 0) {
            return res.status(400).json({ error: 'Valid Product Variant ID and Quantity are required' });
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
            // Update the quantity if item already exists
            await pool.query(
                'UPDATE CartItem SET quantity = quantity + ? WHERE cart_id = ? AND product_variant_id = ?',
                [quantity, cart.cart_id, product_variant_id]
            );
        } else {
            // Insert new item if it doesn't exist in the cart
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
router.get('/view-cart', authMiddleware, async (req, res) => {
    const account_id = req.user.account_id; // Retrieved from the middleware

    try {
        // Retrieve cart by account ID
        const [cart] = await pool.query('SELECT * FROM Cart WHERE account_id = ?', [account_id]);

        if (cart.length === 0) {
            return res.status(404).json({ message: 'No cart found for this account' });
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
                Product.Pname
             FROM CartItem 
             JOIN ProductVariant ON CartItem.product_variant_id = ProductVariant.variant_id
             JOIN Product ON ProductVariant.product_id = Product.product_id
             WHERE CartItem.cart_id = ?`,
            [cart_id]
        );

        res.status(200).json({
            cart_id,
            account_id,
            items
        });
    } catch (error) {
        console.error('Error viewing cart:', error);
        res.status(500).json({ error: 'Error retrieving cart' });
    }
});

module.exports = router;