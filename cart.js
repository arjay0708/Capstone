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

        // Parse images and update them to include full URL
        const updatedItems = items.map(item => {
            const images = JSON.parse(item.images).map(image => `/uploads/${image}`);
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
                Product.price
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
        for (const item of cartItems) {
            if (item.order_quantity > item.available_quantity) {
                return res.status(400).json({
                    message: `Insufficient stock for item ID ${item.product_variant_id}.`
                });
            }
            totalAmount += item.price * item.order_quantity;
        }

        const [newOrder] = await pool.query(
            'INSERT INTO Orders (account_id, total_amount) VALUES (?, ?)',
            [account_id, totalAmount]
        );
        const order_id = newOrder.insertId;

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

        // Remove only the selected items from the cart
        await pool.query('DELETE FROM CartItem WHERE cart_item_id IN (?)', [cart_item_ids]);

        res.status(200).json({
            message: 'Order placed successfully',
            order_id,
            totalAmount
        });
    } catch (error) {
        console.error('Error placing order:', error);
        res.status(500).json({ error: 'Error placing order' });
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

module.exports = router;