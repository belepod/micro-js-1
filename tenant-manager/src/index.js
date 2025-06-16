const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const axios = require('axios');
const db = require('./db');
const kafka = require('./kafka');
const path = require('path'); // <-- Import path module
const multer = require('multer'); // <-- Import multer
const app = express();

app.use(cors({
    origin: ['http://localhost', 'http://localhost:80'], 
    credentials: true
}));
app.use(cookieParser());
app.use(express.json());

const ADMIN_SESSION_COOKIE = 'admin-session';


// --- NEW: Multer Configuration for Logo Uploads ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // We will store uploads in a folder named 'uploads'
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        // Create a unique filename: tenantId-originalName.ext
        // We get tenantId from the form body that's sent along with the file
        const tenantId = req.body.tenantId; 
        const uniqueSuffix = tenantId + '-' + file.originalname.replace(/\s+/g, '-').toLowerCase();
        cb(null, uniqueSuffix);
    }
});

const upload = multer({ storage: storage });


// --- NEW: Serve Static Files from the 'uploads' directory ---
// This makes logos accessible via a URL like http://localhost:3003/uploads/acme-logo.png
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

const isAuthenticated = (req, res, next) => {
    if (req.cookies[ADMIN_SESSION_COOKIE]) {
        return next();
    }
    res.status(401).send({ error: 'Unauthorized. Please log in.' });
};

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASSWORD) {
        res.cookie(ADMIN_SESSION_COOKIE, 'authenticated', {
            httpOnly: true, // Prevents client-side script access
            secure: process.env.NODE_ENV === 'production', // Use secure cookies in production
            maxAge: 24 * 60 * 60 * 1000 // 1 day
        });
        res.status(200).send({ message: 'Login successful' });
    } else {
        res.status(401).send({ error: 'Invalid credentials' });
    }
});

app.post('/tenants', isAuthenticated, upload.single('logo'), async (req, res) => {
    const {
        tenantId,
        organizationName,
        subdomain,
        address,
        timezone,
        currency,
        username,
        password
    } = req.body;

    let logoUrlToStore;
    if (req.file) {
        // A file was uploaded by multer. Store the path to it.
        logoUrlToStore = `/uploads/${req.file.filename}`;
    } else {
        // No file was uploaded. Use the URL provided in the text field (if any).
        logoUrlToStore = req.body.logoUrl || null; // Use null if the field is empty
    }

    // --- Validation (add more as needed) ---
    if (!tenantId || !organizationName || !username || !password) {
        return res.status(400).send({ error: 'Missing required fields.' });
    }

    const client = await db.pool.connect(); // Use a transaction
    try {
        await client.query('BEGIN');

        // Step 1: Insert the rich tenant data into our own DB
        const insertQuery = `
            INSERT INTO tenants (tenant_id, organization_name, logo_url, subdomain, address, timezone, currency)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `;
        await client.query(insertQuery, [tenantId, organizationName, logoUrlToStore, subdomain, address, timezone, currency]);

        await kafka.sendTenantCreatedEvent(tenantId, username, password);

        await client.query('COMMIT');
        res.status(202).send({ message: `Tenant '${tenantId}' creation process initiated.` });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error creating tenant:', err.response ? err.response.data : err.message);
        // Provide a specific error message if the tenant ID or user already exists
        if (err.code === '23505' || (err.response && err.response.status === 409)) {
             return res.status(409).send({ error: 'Tenant ID or initial username already exists.' });
        }
        res.status(500).send({ error: 'Failed to create tenant.' });
    } finally {
        client.release();
    }
});

app.delete('/tenants/:tenantId',isAuthenticated, async (req, res) => {
    const { tenantId } = req.params;

    try {
        const result = await db.query('DELETE FROM tenants WHERE tenant_id = $1', [tenantId]);

        if (result.rowCount === 0) {
            return res.status(404).send({ error: `Tenant '${tenantId}' not found.` });
        }

        await kafka.sendTenantDeletedEvent(tenantId);

        res.status(202).send({ message: `Tenant '${tenantId}' deletion accepted.` });
    } catch (err) {
        console.error(`Error deleting tenant '${tenantId}':`, err);
        res.status(500).send('Failed to accept tenant deletion request.');
    }
});

app.put('/tenants/:tenantId',isAuthenticated, async (req, res) => {
    const { tenantId: oldTenantId } = req.params;
    const { newTenantId } = req.body;

    if (!newTenantId || !/^[a-z0-9_]+$/.test(newTenantId)) {
        return res.status(400).send('Invalid newTenantId provided.');
    }
    if (oldTenantId === newTenantId) {
        return res.status(400).send('New tenant ID cannot be the same as the old one.');
    }

    try {
        const result = await db.query('UPDATE tenants SET tenant_id = $1 WHERE tenant_id = $2', [newTenantId, oldTenantId]);

        if (result.rowCount === 0) {
            return res.status(404).send({ error: `Tenant '${oldTenantId}' not found.` });
        }

        // Step 2: Publish the event.
        await kafka.sendTenantRenamedEvent(oldTenantId, newTenantId);

        res.status(202).send({ message: `Tenant rename from '${oldTenantId}' to '${newTenantId}' accepted.` });
    } catch (err) {
        // Handle potential unique constraint violation if the new name already exists
        if (err.code === '23505') { // unique_violation
            return res.status(409).send({ error: `Tenant ID '${newTenantId}' already exists.` });
        }
        console.error(`Error renaming tenant '${oldTenantId}':`, err);
        res.status(500).send('Failed to accept tenant rename request.');
    }
});

app.get('/tenants', isAuthenticated, async (req, res) => {
    try {
        const { rows } = await db.query('SELECT * FROM tenants ORDER BY created_at DESC');
        res.status(200).json(rows);
    } catch (err) {
        console.error('Error fetching tenants:', err);
        res.status(500).send({ error: 'Failed to fetch tenants list.' });
    }
});

app.get('/tenants/:tenantId', isAuthenticated, async (req, res) => {
    const { tenantId } = req.params;
    try {
        const { rows } = await db.query('SELECT * FROM tenants WHERE tenant_id = $1', [tenantId]);
        if (rows.length === 0) {
            return res.status(404).send({ error: 'Tenant not found.' });
        }
        res.status(200).json(rows[0]);
    } catch (err) {
        console.error('Error fetching tenant details:', err);
        res.status(500).send({ error: 'Failed to fetch tenant details.' });
    }
});

const PORT = 3000;
const startServer = async () => {
    await kafka.connect();
    app.listen(PORT, () => {
      console.log(`Tenant Manager service listening on port ${PORT}`);
    });

    process.on('SIGINT', async () => {
        await kafka.disconnect();
        process.exit(0);
    });
};

startServer();
