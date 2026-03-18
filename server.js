const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const axios = require('axios');
const path = require('path');
const compression = require('compression');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  idleTimeoutMillis: 30000,  connectionTimeoutMillis: 2000,
});

// Middleware
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Init DB tables
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        role VARCHAR(50) DEFAULT 'user',
        plan VARCHAR(50) DEFAULT 'free',
        credits INTEGER DEFAULT 10,
        premium_exp TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        payment_id VARCHAR(255),
        amount DECIMAL(10,2),
        status VARCHAR(50),
        plan VARCHAR(50),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS promos (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        plan VARCHAR(50),
        days INTEGER,
        used_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
              );
      
    `);
    console.log('DB initialized');
  } finally {
    client.release();
  }
}

// Seed admin account
async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL || 'admin@promtwave.ru';
  const password = process.env.ADMIN_PASSWORD || 'Admin2026!';
  const name = 'Administrator';
  try {
    const hash = await bcrypt.hash(password, 10);
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      await pool.query('UPDATE users SET role = $1, password = $2 WHERE email = $3', ['admin', hash, email]);
      return;
    }
    await pool.query(
      'INSERT INTO users (email, password, name, role, plan, credits) VALUES ($1, $2, $3, $4, $5, $6)',
      [email, hash, name, 'admin', 'ultra', 99999]
    );
    console.log('Admin account created: ' + email);
  } catch (e) {
    console.error('seedAdmin error:', e.message);
  }
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

// Routes
app.post('/api/register', async (req, res) => {
  const { email, password, name } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, role, plan, credits',
      [email, hash, name || '']
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET);
    res.json({ token, user });
  } catch (e) {
    res.status(400).json({ error: 'Email exists or error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (user && await bcrypt.compare(password, user.password)) {
      const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET);
      res.json({ token, user: { id: user.id, email: user.email, role: user.role, plan: user.plan, credits: user.credits } });
    } else {
      res.status(400).json({ error: 'Invalid credentials' });
    }
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, name, role, plan, credits, premium_exp, created_at FROM users WHERE id = $1', [req.user.id]);
    res.json(result.rows[0]);
  } catch {
    res.status(500).json({ error: 'Error' });
  }
});

app.post('/api/create-payment', authMiddleware, async (req, res) => {
  const { amount, plan } = req.body;
  try {
    const response = await axios.post('https://api.yookassa.ru/v3/payments', {
      amount: { value: amount, currency: 'RUB' },
      confirmation: { type: 'embedded' },
      capture: true,
      description: `Premium ${plan}`,
      metadata: { user_id: req.user.id, plan }
    }, {
      auth: { username: process.env.YOOKASSA_SHOP_ID, password: process.env.YOOKASSA_SECRET_KEY },
      headers: { 'Idempotence-Key': Date.now().toString() }
    });
    res.json({ confirmation_token: response.data.confirmation.confirmation_token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/activate-promo', authMiddleware, async (req, res) => {
  const { promo } = req.body;
  try {
    const result = await pool.query('SELECT * FROM promos WHERE code = $1 AND used_by IS NULL', [promo]);
    if (result.rows.length) {
      const p = result.rows[0];
      const exp = new Date(Date.now() + (p.days || 30) * 86400000);
      await pool.query('UPDATE users SET plan = $1, premium_exp = $2 WHERE id = $3', [p.plan || 'pro', exp, req.user.id]);
      await pool.query('UPDATE promos SET used_by = $1 WHERE id = $2', [req.user.id, p.id]);
      res.json({ ok: true, plan: p.plan, days: p.days, expiresAt: exp.getTime() });
    } else {
      res.status(400).json({ error: 'Invalid promo' });
    }
  } catch (e) {
    res.status(500).json({ error: 'Error' });
  }
});

app.post('/api/admin/grant-premium', authMiddleware, adminMiddleware, async (req, res) => {
  const { email, days } = req.body;
  try {
    const promo = 'PWS-' + Math.random().toString(36).substring(2, 10).toUpperCase();
    await pool.query('INSERT INTO promos (code, plan, days) VALUES ($1, $2, $3)', [promo, 'pro', days]);
    const uResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (uResult.rows.length) {
      const exp = new Date(Date.now() + days * 86400000);
      await pool.query('UPDATE users SET plan = $1, premium_exp = $2 WHERE id = $3', ['pro', exp, uResult.rows[0].id]);
    }
    res.json({ ok: true, promo });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, name, role, plan, credits, premium_exp, created_at FROM users ORDER BY created_at DESC');
    res.json(result.rows);
  } catch {
    res.status(500).json({ error: 'Error' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- TELEGRAM BOT ---
if (process.env.TELEGRAM_BOT_TOKEN) {
  const TelegramBot = require('node-telegram-bot-api');
  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
  const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID ? parseInt(process.env.TELEGRAM_ADMIN_ID) : null;

  bot.onText(/\/start/, (msg) => {
    const name = msg.from.first_name || 'пользователь';
    bot.sendMessage(msg.chat.id, `👋 Привет, ${name}!

🎵 *PromtWaveSuno* — студия промптов для Suno AI.

Что умеет бот:
` +
      `• /promo [код] — активировать промокод
` +
      `• /status — твой статус подписки
` +
      `• /site — открыть сайт

` +
      `🌐 https://promtwave-production.up.railway.app/`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/site/, (msg) => {
    bot.sendMessage(msg.chat.id, '🌊 Открыть PromtWaveSuno: https://promtwave-production.up.railway.app/', { parse_mode: 'Markdown' });  });

  bot.onText(/\/status/, async (msg) => {
        bot.sendMessage(msg.chat.id, `Твой статус подписки доступен на сайте: https://promtwave-production.up.railway.app/`);
  });
  bot.onText(/\/promo (.+)/, async (msg, match) => {
    const code = match[1].trim().toUpperCase();
    bot.sendMessage(msg.chat.id, `🎟 Активируй промокод *${code}* на сайте:
https://promtwave-production.up.railway.app/

Нажми «Войти» → «Активировать промокод»`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/users/, async (msg) => {
    if (!ADMIN_ID || msg.chat.id !== ADMIN_ID) return;
    try {
      const r = await pool.query('SELECT COUNT(*) as total, COUNT(CASE WHEN plan!=\'free\' THEN 1 END) as premium FROM users');
      const { total, premium } = r.rows[0];
      bot.sendMessage(msg.chat.id, `📊 *Статистика пользователей:*
👥 Всего: ${total}
⭐ Premium: ${premium}`, { parse_mode: 'Markdown' });
    } catch(e) {
      bot.sendMessage(msg.chat.id, 'Ошибка БД');
    }
  });

  bot.onText(/\/grant (.+) (\d+)/, async (msg, match) => {
    if (!ADMIN_ID || msg.chat.id !== ADMIN_ID) return;
    const email = match[1].trim();
    const days = parseInt(match[2]);
    try {
      const exp = new Date(Date.now() + days * 86400000);
      await pool.query('UPDATE users SET plan=$1, premium_exp=$2 WHERE email=$3', ['pro', exp, email]);
      bot.sendMessage(msg.chat.id, `✅ Premium выдан: ${email} на ${days} дней`);
    } catch(e) {
      bot.sendMessage(msg.chat.id, 'Ошибка: ' + e.message);
    }
  });

  console.log('Telegram bot started');
}

initDB().then(() => seedAdmin()).then(() => {
  app.listen(PORT, () => console.log(`Server on ${PORT}`));
});
