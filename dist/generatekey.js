"use strict";
const crypto = require('crypto');
// Generate a secure random key
const secretKey = crypto.randomBytes(64).toString('hex');
// Output the key to the console
console.log('Generated Secret Key:', secretKey);
