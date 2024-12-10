"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
const jwt = require('jsonwebtoken');
const pool = require('./connection');
const authMiddleware = (req, res, next) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    try {
        const token = (_a = req.headers['authorization']) === null || _a === void 0 ? void 0 : _a.split(' ')[1];
        if (!token) {
            console.log('No token provided');
            return res.status(401).json({ error: 'Unauthorized. Please log in.' });
        }
        // Verify the token
        jwt.verify(token, process.env.JWT_SECRET_KEY, (err, decoded) => __awaiter(void 0, void 0, void 0, function* () {
            if (err) {
                console.log('Invalid token:', err.message);
                return res.status(401).json({ error: 'Unauthorized. Invalid or expired token.' });
            }
            console.log('Token decoded successfully:', decoded);
            const accountId = decoded.accountId;
            console.log('Decoded account ID:', accountId);
            // Fetch the user from the database using account ID
            const [user] = yield pool.query('SELECT * FROM Accounts WHERE account_id = ?', [accountId]);
            if (user.length === 0) {
                console.log('No user found for account ID:', accountId);
                return res.status(401).json({ error: 'Unauthorized. Invalid session.' });
            }
            // Attach the user information to req
            req.user = user[0];
            console.log('User attached to req:', req.user);
            next(); // Move to next middleware or route handler
        }));
    }
    catch (error) {
        console.error('Error during authentication:', error);
        res.status(500).json({ error: 'Server error during authentication' });
    }
});
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
