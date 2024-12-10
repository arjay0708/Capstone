// index.js
const express = require('express');
const app = express();
const cors = require('cors');
const bodyParser = require('body-parser');
const adminRouter = require('./adminController.js');
const productRouter = require('./productController.js');
const qrcodeRouter = require('./qrcodeController.js');
const countsRouter = require('./viewcounter.js');
const customerRouter = require ('./customerController.js');
const cartRouter = require ('./cart.js');
const path = require('path');

app.use(cors({
    origin: 'https://gaposource.com', // Adjust to match your Angular frontend URL
  }));

  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const port = 8080;
app.use(bodyParser.json());

    // Enable CORS for all routes
 

app.use('/admins', adminRouter);
app.use('/products', productRouter);
app.use('/qrcodes', qrcodeRouter);
app.use('/counts', countsRouter);
app.use ('/customer', customerRouter);
app.use('/cart', cartRouter)


// Serve static files from the uploads directory
app.get('/', (req, res) => {
    res.send('Static file serving setup is working');
});
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);

});