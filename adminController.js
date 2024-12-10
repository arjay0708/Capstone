const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('./connection');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const qr = require('qr-image'); // Ensure you have this library installed
require('dotenv').config(); // Ensure you have dotenv installed
const { authMiddleware, roleCheckMiddleware } = require('./authMiddleware'); // Adjust the path if necessary


// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });

// Middleware function to verify JWT token
function verifyToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Extract token from 'Bearer <token>'

    console.log('Received Token:', token); // Log the token for debugging
  
    if (!token) {
        return res.status(403).send('Token is required');
    }
  
    jwt.verify(token, process.env.JWT_SECRET_KEY, (err, decoded) => { // Use environment variable for secret key
        if (err) {
            console.error('Token Verification Error:', err); // Log verification errors
            return res.status(401).send('Invalid token');
        }
        req.accountId = decoded.accountId;
        next();
    });
}

// Admin registration endpoint
router.post('/register', upload.single('image'), async (req, res) => {
    const { username, password, fname, lname, mname, suffix, age, address } = req.body;
    const image = req.file ? req.file.path : null;

    try {
        // Ensure required fields are defined
        if (!username || !password || !fname || !lname) {
            return res.status(400).send('Missing required fields');
        }

        // Check if the admin already exists
        const [existingAdmin] = await pool.query('SELECT * FROM Accounts WHERE username = ?', [username]);

        if (existingAdmin.length > 0) {
            return res.status(409).send('Admin with this username already exists');
        }

        // Hash the password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert the new admin into the database
        const [result] = await pool.query(
            'INSERT INTO Accounts (username, password, fname, lname, mname, suffix, age, address, images) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [username, hashedPassword, fname, lname, mname, suffix, age, address, image]
        );

        if (result.affectedRows > 0) {
            return res.status(201).send('Admin registered successfully');
        } else {
            throw new Error('Failed to register admin');
        }
    } catch (error) {
        console.error('Error during registration:', error);
        return res.status(500).send('Server error');
    }
});

// Admin login endpoint
router.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        if (!username || !password) {
            return res.status(400).send('Username and password are required');
        }

        // Query to fetch the user by username
        const [results] = await pool.query('SELECT * FROM Accounts WHERE username = ?', [username]);

        if (results.length === 0) {
            return res.status(401).send('Invalid username or password');
        }

        const match = await bcrypt.compare(password, results[0].password);
        if (!match) {
            return res.status(401).send('Invalid username or password');
        }

        // Check if the user role is 'admin' or 'employee'
        const role = results[0].role;
        if (role !== 'admin' && role !== 'employee') {
            return res.status(403).send('Access denied. Only admins and employees can log in.');
        }

        // If the credentials are valid, generate a JWT token
        const token = jwt.sign({ accountId: results[0].account_id, role: role }, process.env.JWT_SECRET_KEY, { expiresIn: '1h' }); // Use environment variable for secret key

        res.status(200).json({ token, role });

    } catch (error) {
        console.error('Error during authentication:', error);
        res.status(500).send('Server error');
    }
});

router.put('/changepassword', verifyToken, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const accountId = req.accountId;

    console.log("Account ID:", accountId);  // Log Account ID

    try {
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new passwords are required' });
        }

        const [results] = await pool.query('SELECT password FROM accounts WHERE account_id = ?', [accountId]);


        if (results.length === 0) {
            return res.status(404).json({ error: 'Account not found' });
        }

        const storedPassword = results[0].password;
        const isMatch = await bcrypt.compare(currentPassword, storedPassword);

        console.log("Password match:", isMatch);  // Log password match outcome

        if (!isMatch) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const hashedNewPassword = await bcrypt.hash(newPassword, 10);

        await pool.query('UPDATE accounts SET password = ? WHERE account_id = ?', [hashedNewPassword, accountId]);

        res.status(200).json({ message: 'Password updated successfully' });
    } catch (error) {
        console.error('Error changing password:', error);  // Log detailed error
        res.status(500).json({ error: 'Server error. Please try again later.' });
    }
});

// Admin Create Product
router.post('/', async (req, res) => {
    const { Pname, price, images, variants } = req.body;

    let connection;

    try {
        // Get a connection from the pool
        connection = await pool.getConnection();

        // Start a transaction
        await connection.beginTransaction();

        // Insert product into Product table
        const [productResult] = await connection.query(
            'INSERT INTO Product (Pname, price, images) VALUES (?, ?, ?)',
            [Pname, price, JSON.stringify(images)] // Store images as JSON string
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
        const qrURL = `http://localhost:4200/products/${productID}`;
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

// Admin edit endpoint
router.put('/:adminId', verifyToken, upload.single('image'), async (req, res) => {
    const adminId = req.params.adminId;
    const { fname, lname, mname, suffix, age, address } = req.body;
    const image = req.file ? req.file.path : req.body.images; // Use new image if uploaded, otherwise keep the existing

    // Update admin profile in the database
    pool.query('UPDATE Admin SET fname = ?, lname = ?, mname = ?, suffix = ?, age = ?, address = ?, images = ? WHERE admin_id = ?',
        [fname, lname, mname, suffix, age, address, image, adminId],
        (err, result) => {
            if (err) {
                return res.status(500).send('Error updating admin profile');
            }
            res.status(200).send('Admin profile updated successfully');
        });
});

// Retrieve all QR codes
router.get('/qrcodes', verifyToken, (req, res) => {
    pool.query('SELECT * FROM QRCode', (err, results) => {
        if (err) {
            return res.status(500).send('Error retrieving QR codes');
        }
        res.status(200).json(results);
    });
});

// Retrieve a specific QR code by ID
router.get('/qrcodes/:id', verifyToken, (req, res) => {
    const qrId = req.params.id;
    pool.query('SELECT * FROM QRCode WHERE qr_id = ?', [qrId], (err, results) => {
        if (err) {
            return res.status(500).send('Error retrieving QR code');
        }
        if (results.length === 0) {
            return res.status(404).send('QR code not found');
        }
        res.status(200).json(results[0]);
    });
});

// Create a new QR code
router.post('/qrcodes', verifyToken, (req, res) => {
    const productId = req.body.productId;
    pool.query('INSERT INTO QRCode (product_id) VALUES (?)', [productId], (err, result) => {
        if (err) {
            return res.status(500).send('Error creating QR code');
        }
        res.status(201).send(`QR code created with ID: ${result.insertId}`);
    });
});

// Delete a QR code
router.delete('/qrcodes/:id', verifyToken, (req, res) => {
    const qrId = req.params.id;
    pool.query('DELETE FROM QRCode WHERE qr_id = ?', [qrId], (err, result) => {
        if (err) {
            return res.status(500).send('Error deleting QR code');
        }
        res.status(200).send('QR code deleted successfully');
    });
});

router.post('/create-employee', authMiddleware, roleCheckMiddleware('admin'), upload.single('image'), async (req, res) => {
    const { username, password, fname, lname, mname, suffix, age, address, email } = req.body;
    const image = req.file ? req.file.path : null;

    try {
        // Ensure required fields are defined
        if (!username || !password || !fname || !lname || !email) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Check if the employee already exists
        const [existingEmployee] = await pool.query('SELECT * FROM Accounts WHERE username = ?', [username]);

        if (existingEmployee.length > 0) {
            return res.status(409).json({ error: 'Employee with this username already exists' });
        }

        // Hash the password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert the new employee into the Accounts table with role 'employee'
        const [result] = await pool.query(
            `INSERT INTO Accounts (username, password, fname, lname, mname, suffix, age, address, email, images, role) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [username, hashedPassword, fname, lname, mname, suffix, age, address, email, image, 'employee']
        );

        if (result.affectedRows > 0) {
            return res.status(201).json({ message: 'Employee registered successfully' });
        } else {
            throw new Error('Failed to register employee');
        }
    } catch (error) {
        console.error('Error during employee registration:', error);
        return res.status(500).json({ error: 'Server error' });
    }
});

router.get('/employee', async (req, res) => {
    try {
      // Query to get all accounts with role 'employee', including the account_id
      const [rows] = await pool.query('SELECT account_id, username, fname, lname, email, age, address FROM accounts WHERE role = ?', ['employee']);
      
      if (rows.length > 0) {
        const employeeCount = rows.length;
        res.status(200).json({
          count: employeeCount,
          employees: rows
        });
      } else {
        res.status(404).json({ message: 'No employees found', count: 0 });
      }
    } catch (err) {
      console.error('Error fetching employees:', err);
      res.status(500).json({ error: 'Error fetching employees' });
    }
  });

  router.put('/employee/:id', authMiddleware, roleCheckMiddleware('admin'), upload.single('image'), async (req, res) => {
    const { id } = req.params;
    const { fname, lname, mname, suffix, age, address, email } = req.body;
    const image = req.file ? req.file.path : null;

    try {
        // Check if the employee exists
        const [existingEmployee] = await pool.query('SELECT * FROM Accounts WHERE account_id = ?', [id]);

        if (existingEmployee.length === 0) {
            return res.status(404).json({ error: 'Employee not found' });
        }

        // Update employee information in the database (excluding username and password)
        const [result] = await pool.query(
            `UPDATE Accounts 
             SET fname = ?, lname = ?, mname = ?, suffix = ?, age = ?, address = ?, email = ?, images = COALESCE(?, images)
             WHERE account_id = ?`,
            [fname, lname, mname, suffix, age, address, email, image, id]
        );

        if (result.affectedRows > 0) {
            return res.status(200).json({ message: 'Employee updated successfully' });
        } else {
            throw new Error('Failed to update employee');
        }
    } catch (error) {
        console.error('Error updating employee:', error);
        return res.status(500).json({ error: 'Server error' });
    }
});

router.delete('/employee/:account_id', authMiddleware, roleCheckMiddleware('admin'), async (req, res) => {
    const { account_id } = req.params;  // Using account_id here instead of id

    try {
        // Check if the employee exists
        const [existingEmployee] = await pool.query('SELECT * FROM Accounts WHERE account_id = ?', [account_id]);

        if (existingEmployee.length === 0) {
            return res.status(404).json({ error: 'Employee not found' });
        }

        // Delete the employee from the database
        const [result] = await pool.query('DELETE FROM Accounts WHERE account_id = ?', [account_id]);

        if (result.affectedRows > 0) {
            return res.status(200).json({ message: 'Employee deleted successfully' });
        } else {
            throw new Error('Failed to delete employee');
        }
    } catch (error) {
        console.error('Error deleting employee:', error);
        return res.status(500).json({ error: 'Server error' });
    }
});
module.exports = router;

