/* Admin table */
CREATE TABLE Admin (
    admin_id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(255) NOT NULL,
    password VARCHAR(255) NOT NULL,
    fname VARCHAR(255),
    lname VARCHAR(255),
    mname VARCHAR(255),
    suffix VARCHAR(50),
    age INT,
    address VARCHAR(255),
    images VARCHAR(255)
);

/* Product table */
CREATE TABLE Product (
    product_id INT AUTO_INCREMENT PRIMARY KEY,
    Pname VARCHAR(255),
    price DECIMAL(10, 2),
    images VARCHAR(255),
    category text,
    description text,
);

/* ProductVariant table */
CREATE TABLE ProductVariant (
    variant_id INT PRIMARY KEY AUTO_INCREMENT,
    product_id INT,
    gender ENUM('Male', 'Female', 'Unisex') NOT NULL,
    size VARCHAR(50) NOT NULL,
    quantity INT NOT NULL DEFAULT 0,
    FOREIGN KEY (product_id) REFERENCES Product(product_id)
);

/* QRCode table */
CREATE TABLE QRCode (
    qr_id INT PRIMARY KEY AUTO_INCREMENT,
    product_id INT,
    FOREIGN KEY (product_id) REFERENCES Product(product_id)
);
