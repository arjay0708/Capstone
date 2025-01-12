/* Accounts table (formerly Admin) */
CREATE TABLE Accounts (
    account_id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(255) NOT NULL,
    password VARCHAR(255) NOT NULL,
    fname VARCHAR(255),
    lname VARCHAR(255),
    mname VARCHAR(255),
    suffix VARCHAR(50),
    age INT,
    address VARCHAR(255),
    email VARCHAR(255) NOT NULL UNIQUE,
    phone VARCHAR(50),
    images VARCHAR(255),
    role ENUM('admin', 'employee', 'customer') DEFAULT 'customer', -- Added 'customer' role
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    verification_token VARCHAR(255) NULL,
    is_verified BOOLEAN DEFAULT FALSE

);

/* Product table */
CREATE TABLE Product (
    product_id INT AUTO_INCREMENT PRIMARY KEY,
    Pname VARCHAR(255),
    price DECIMAL(10, 2),
    images VARCHAR(255),
    category TEXT,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

/* ProductVariant table */
CREATE TABLE ProductVariant (
    variant_id INT PRIMARY KEY AUTO_INCREMENT,
    product_id INT,
    gender ENUM('Male', 'Female', 'Unisex') NOT NULL,
    size VARCHAR(50) NOT NULL,
    quantity INT NOT NULL DEFAULT 0,
    FOREIGN KEY (product_id) REFERENCES Product(product_id) ON DELETE CASCADE
);

/* QRCode table */
CREATE TABLE QRCode (
    qr_id INT PRIMARY KEY AUTO_INCREMENT,
    product_id INT,
    FOREIGN KEY (product_id) REFERENCES Product(product_id) ON DELETE CASCADE
);

/* ShopViews table */
CREATE TABLE Shopviews (
    id INT PRIMARY KEY AUTO_INCREMENT,
    view_count INT DEFAULT 0,
    view_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

/* Cart table */
CREATE TABLE Cart (
    cart_id INT PRIMARY KEY AUTO_INCREMENT,
    account_id INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES Accounts(account_id) ON DELETE CASCADE
);

/* CartItem table */
CREATE TABLE CartItem (
    cart_item_id INT PRIMARY KEY AUTO_INCREMENT,
    cart_id INT,
    product_variant_id INT,
    quantity INT NOT NULL DEFAULT 1,
    FOREIGN KEY (cart_id) REFERENCES Cart(cart_id) ON DELETE CASCADE,
    FOREIGN KEY (product_variant_id) REFERENCES ProductVariant(variant_id) ON DELETE CASCADE
);

/* Orders table */
CREATE TABLE Orders (
    order_id INT PRIMARY KEY AUTO_INCREMENT,
    account_id INT,
    total_amount DECIMAL(10, 2),
    order_status ENUM('Pending', 'Preparing', 'Shipped', 'Delivered', 'Cancelled') DEFAULT 'Pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    delivered_at DATETIME NULL,
    shipped_at DATETIME NULL,
    date_received DATETIME NULL,
    payment_method VARCHAR(50) NOT NULL DEFAULT 'COD', 
    payment_status VARCHAR(50) DEFAULT 'pending',
    tracking_number VARCHAR(50),
    carrier VARCHAR(50),
    cancel_reason VARCHAR(255) DEFAULT NULL,
    prepared_by INT DEFAULT NULL,  -- Store the account_id (admin/employee)
    prepared_at DATETIME DEFAULT NULL,
    FOREIGN KEY (account_id) REFERENCES Accounts(account_id) ON DELETE CASCADE,  -- Foreign key constraint for customer
    FOREIGN KEY (prepared_by) REFERENCES Accounts(account_id) ON DELETE SET NULL  -- Foreign key constraint for admin/employee
);


CREATE TABLE Payments (
    payment_id INT PRIMARY KEY AUTO_INCREMENT,
    order_id INT,
    payment_method VARCHAR(50) NOT NULL,
    payment_status VARCHAR(50) DEFAULT 'pending',
    payment_amount DECIMAL(10, 2) NOT NULL, 
    payment_reference VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES Orders(order_id) ON DELETE CASCADE
);


/* OrderItem table */
CREATE TABLE OrderItem (
    order_item_id INT PRIMARY KEY AUTO_INCREMENT,
    order_id INT,
    product_variant_id INT,
    quantity INT NOT NULL,
    price_at_purchase DECIMAL(10, 2),
    FOREIGN KEY (order_id) REFERENCES Orders(order_id) ON DELETE CASCADE,
    FOREIGN KEY (product_variant_id) REFERENCES ProductVariant(variant_id) ON DELETE CASCADE
);
