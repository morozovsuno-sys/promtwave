const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Init DB tables
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      role VARCHAR(50) DEFAULT 'user',
      plan VARCHAR(50) DEFAULT 'free',
      credits INTEGER DEFAULT 10,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      payment_id VARCHAR(255),
      amount DECIMAL(10,2),
      status VARCHAR(50),
      plan VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prompts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      content TEXT,
      style VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('DB initialized');
}

// Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminMiddleware(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  next();
}

// --- AUTH ROUTES ---
app.post('/api/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name, role, plan, credits',
      [email, hash, name || '']
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Email already exists' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (!result.rows.length) return res.status(400).json({ error: 'User not found' });
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Wrong password' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, plan: user.plan, credits: user.credits } });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT id, email, name, role, plan, credits, created_at FROM users WHERE id = $1', [req.user.id]);
  res.json(result.rows[0]);
});

// --- PROMPTS ---
app.post('/api/prompts', authMiddleware, async (req, res) => {
  const { content, style } = req.body;
  const user = await pool.query('SELECT credits FROM users WHERE id = $1', [req.user.id]);
  if (user.rows[0].credits <= 0) return res.status(403).json({ error: 'No credits' });
  await pool.query('UPDATE users SET credits = credits - 1 WHERE id = $1', [req.user.id]);
  const result = await pool.query(
    'INSERT INTO prompts (user_id, content, style) VALUES ($1, $2, $3) RETURNING *',
    [req.user.id, content, style]
  );
  res.json(result.rows[0]);
});

app.get('/api/prompts', authMiddleware, async (req, res) => {
  const result = await pool.query('SELECT * FROM prompts WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json(result.rows);
});

// --- PAYMENTS (YooKassa) ---
app.post('/api/payment/create', authMiddleware, async (req, res) => {
  const { plan } = req.body;
  const prices = { pro: 499, ultra: 999 };
  const credits = { pro: 100, ultra: 500 };
  if (!prices[plan]) return res.status(400).json({ error: 'Invalid plan' });
  try {
    const response = await axios.post('https://api.yookassa.ru/v3/payments', {
      amount: { value: prices[plan].toFixed(2), currency: 'RUB' },
      confirmation: { type: 'embedded' },
      capture: true,
      description: `Plan: ${plan} for user ${req.user.id}`,
      metadata: { user_id: req.user.id, plan, credits: credits[plan] }
    }, {
      auth: { username: process.env.YOOKASSA_SHOP_ID, password: process.env.YOOKASSA_SECRET_KEY },
      headers: { 'Idempotence-Key': `${req.user.id}-${plan}-${Date.now()}` }
    });
    await pool.query(
      'INSERT INTO payments (user_id, payment_id, amount, status, plan) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, response.data.id, prices[plan], 'pending', plan]
    );
    res.json({ confirmation_token: response.data.confirmation.confirmation_token, payment_id: response.data.id });
  } catch (e) {
    res.status(500).json({ error: 'Payment error', detail: e.message });
  }
});

app.post('/api/payment/webhook', async (req, res) => {
  const event = req.body;
  if (event.event === 'payment.succeeded') {
    const meta = event.object.metadata;
    await pool.query('UPDATE payments SET status = $1 WHERE payment_id = $2', ['succeeded', event.object.id]);
    await pool.query(
      'UPDATE users SET plan = $1, credits = credits + $2 WHERE id = $3',
      [meta.plan, parseInt(meta.credits), parseInt(meta.user_id)]
    );
  }
  res.json({ ok: true });
});

// --- ADMIN ROUTES ---
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  const result = await pool.query('SELECT id, email, name, role, plan, credits, created_at FROM users ORDER BY created_at DESC');
  res.json(result.rows);
});

app.patch('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { role, plan, credits } = req.body;
  await pool.query('UPDATE users SET role = COALESCE($1, role), plan = COALESCE($2, plan), credits = COALESCE($3, credits) WHERE id = $4',
    [role, plan, credits, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/admin/stats', authMiddleware, adminMiddleware, async (req, res) => {
  const users = await pool.query('SELECT COUNT(*) FROM users');
  const payments = await pool.query('SELECT COUNT(*), SUM(amount) FROM payments WHERE status = $1', ['succeeded']);
  const prompts = await pool.query('SELECT COUNT(*) FROM prompts');
  res.json({
    total_users: parseInt(users.rows[0].count),
    total_revenue: parseFloat(payments.rows[0].sum) || 0,
    total_payments: parseInt(payments.rows[0].count),
    total_prompts: parseInt(prompts.rows[0].count)
  });
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start
initDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(console.error);
