const jwt = require('jsonwebtoken');
const pool = require('./connection');

const authMiddleware = async (req, res, next) => {
    try {
        const token = req.headers['authorization']?.split(' ')[1];
        if (!token) {
            console.log('No token provided');
            return res.status(401).json({ error: 'Unauthorized. Please log in.' });
        }

        // Verify the token
        jwt.verify(token, process.env.JWT_SECRET_KEY, async (err, decoded) => {
            if (err) {
                console.log('Invalid token:', err.message);
                return res.status(401).json({ error: 'Unauthorized. Invalid or expired token.' });
            }

            console.log('Token decoded successfully:', decoded);

            const accountId = decoded.accountId;
            console.log('Decoded account ID:', accountId);

            // Fetch the user from the database using account ID
            const [user] = await pool.query('SELECT * FROM Accounts WHERE account_id = ?', [accountId]);

            if (user.length === 0) {
                console.log('No user found for account ID:', accountId);
                return res.status(401).json({ error: 'Unauthorized. Invalid session.' });
            }

            // Attach the user information to req
            req.user = user[0];
            console.log('User attached to req:', req.user);

            next(); // Move to next middleware or route handler
        });
    } catch (error) {
        console.error('Error during authentication:', error);
        res.status(500).json({ error: 'Server error during authentication' });
    }
};

const roleCheckMiddleware = (roles) => {
    return (req, res, next) => {
        const { role } = req.user || {}; // Fallback if req.user is undefined
        console.log('Checking role in roleCheckMiddleware:', role);

        if (!roles.includes(role)) {
            return res.status(403).json({ error: 'Access denied. Only admins and employees can access this resource.' });
        }

        next();
    };
};

module.exports = { authMiddleware, roleCheckMiddleware };
