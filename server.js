// server.js
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { Low, JSONFile } from 'lowdb';
import { nanoid } from 'nanoid';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import fetch from 'node-fetch';
import pino from 'pino';
import morgan from 'morgan';

dotenv.config();
const log = pino({ level: process.env.LOG_LEVEL || 'info' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(morgan('combined'));

// Rate limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
});
app.use('/api/', apiLimiter);

// Static public folder
app.use(express.static(path.join(__dirname, 'public')));

// DB: try MongoDB (mongoose) if URI provided, else lowdb fallback
let DB = null;
let useMongo = false;
if (process.env.MONGODB_URI) {
  try {
    import('mongoose').then(async (mongoose) => {
      await mongoose.connect(process.env.MONGODB_URI, {
        autoIndex: true
      });
      log.info('Connected to MongoDB');
      // define models
      const UserSchema = new mongoose.Schema({
        email: { type: String, unique: true },
        password: String,
        name: String,
        plan: { type: String, default: 'free' },
        createdAt: { type: Date, default: Date.now }
      }, { minimize: false });

      const TaskSchema = new mongoose.Schema({
        userId: String,
        title: String,
        schedule: String,
        enabled: Boolean,
        createdAt: { type: Date, default: Date.now }
      }, { minimize: false });

      const WebhookSchema = new mongoose.Schema({
        userId: String,
        url: String,
        event: String,
        createdAt: { type: Date, default: Date.now }
      }, { minimize: false });

      DB = {
        mongoose,
        User: mongoose.model('User', UserSchema),
        Task: mongoose.model('Task', TaskSchema),
        Webhook: mongoose.model('Webhook', WebhookSchema)
      };
      useMongo = true;
    }).catch(err => {
      log.warn('Mongoose import failed, fallback to lowdb', err);
    });
  } catch (e) {
    log.warn('Mongo init error, fallback to lowdb', e);
  }
}

// lowdb fallback (file JSON)
const dbFile = path.join(__dirname, 'data', 'db.json');
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const adapter = new JSONFile(dbFile);
const lowdb = new Low(adapter);
await lowdb.read();
lowdb.data ||= { users: [], tasks: [], webhooks: [] };

// utils
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';
const signToken = (user) => jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

async function findUserByEmail(email) {
  if (useMongo && DB && DB.User) return DB.User.findOne({ email }).lean();
  await lowdb.read();
  return lowdb.data.users.find(u => u.email === email);
}

async function createUser({ email, password, name }) {
  if (useMongo && DB && DB.User) {
    const hashed = await bcrypt.hash(password, 10);
    const u = await DB.User.create({ email, password: hashed, name });
    return { id: u._id.toString(), email: u.email, name: u.name, plan: u.plan };
  }
  const hashed = await bcrypt.hash(password, 10);
  const id = nanoid();
  const user = { id, email, password: hashed, name, plan: 'free', createdAt: Date.now() };
  await lowdb.read();
  lowdb.data.users.push(user);
  await lowdb.write();
  return { id: user.id, email: user.email, name: user.name, plan: user.plan };
}

// auth middleware
const auth = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// ---------- routes ----------

// health + info
app.get('/api/health', (req, res) => res.json({ ok: true, env: process.env.NODE_ENV || 'dev' }));

// register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email & password required' });
    const existing = await findUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email in use' });
    const user = await createUser({ email, password, name: name || email.split('@')[0] });
    const token = signToken(user);
    res.json({ token, user });
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email & password required' });
    const found = await findUserByEmail(email);
    if (!found) return res.status(401).json({ error: 'Invalid credentials' });

    const same = await bcrypt.compare(password, found.password);
    if (!same) return res.status(401).json({ error: 'Invalid credentials' });

    const user = { id: found.id || found._id?.toString(), email: found.email, name: found.name || found.email.split('@')[0], plan: found.plan || 'free' };
    const token = signToken(user);
    res.json({ token, user });
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// tasks endpoints
app.get('/api/tasks', auth, async (req, res) => {
  await lowdb.read();
  if (useMongo && DB && DB.Task) {
    const list = await DB.Task.find({ userId: req.user.id }).lean();
    return res.json(list.map(t => ({ id: t._id.toString(), ...t })));
  }
  const list = (lowdb.data.tasks || []).filter(t => t.userId === req.user.id);
  res.json(list);
});

app.post('/api/tasks', auth, async (req, res) => {
  const { title, schedule, enabled } = req.body || {};
  if (useMongo && DB && DB.Task) {
    const doc = await DB.Task.create({ userId: req.user.id, title, schedule, enabled: !!enabled });
    return res.json({ id: doc._id.toString(), title: doc.title, schedule: doc.schedule, enabled: doc.enabled });
  }
  await lowdb.read();
  const obj = { id: nanoid(), userId: req.user.id, title: title || 'New Task', schedule: schedule || 'manual', enabled: !!enabled, createdAt: Date.now() };
  lowdb.data.tasks.push(obj);
  await lowdb.write();
  res.json(obj);
});

app.patch('/api/tasks/:id', auth, async (req, res) => {
  const id = req.params.id;
  if (useMongo && DB && DB.Task) {
    const t = await DB.Task.findOne({ _id: id, userId: req.user.id });
    if (!t) return res.status(404).json({ error: 'Not found' });
    Object.assign(t, req.body || {});
    await t.save();
    return res.json({ id: t._id.toString(), ...t.toObject() });
  }
  await lowdb.read();
  const i = lowdb.data.tasks.findIndex(x => x.id === id && x.userId === req.user.id);
  if (i === -1) return res.status(404).json({ error: 'Not found' });
  Object.assign(lowdb.data.tasks[i], req.body || {});
  await lowdb.write();
  res.json(lowdb.data.tasks[i]);
});

app.delete('/api/tasks/:id', auth, async (req, res) => {
  const id = req.params.id;
  if (useMongo && DB && DB.Task) {
    const d = await DB.Task.deleteOne({ _id: id, userId: req.user.id });
    return res.json({ ok: true });
  }
  await lowdb.read();
  const i = lowdb.data.tasks.findIndex(x => x.id === id && x.userId === req.user.id);
  if (i === -1) return res.status(404).json({ error: 'Not found' });
  lowdb.data.tasks.splice(i, 1);
  await lowdb.write();
  res.json({ ok: true });
});

// webhooks
app.post('/api/webhooks/register', auth, async (req, res) => {
  const { url, event } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  if (useMongo && DB && DB.Webhook) {
    const w = await DB.Webhook.create({ userId: req.user.id, url, event: event || 'task.fired' });
    return res.json({ id: w._id.toString(), url: w.url, event: w.event });
  }
  await lowdb.read();
  const w = { id: nanoid(), userId: req.user.id, url, event: event || 'task.fired', createdAt: Date.now() };
  lowdb.data.webhooks.push(w);
  await lowdb.write();
  res.json(w);
});

app.get('/api/webhooks', auth, async (req, res) => {
  await lowdb.read();
  if (useMongo && DB && DB.Webhook) {
    const list = await DB.Webhook.find({ userId: req.user.id }).lean();
    return res.json(list.map(x => ({ id: x._id.toString(), url: x.url, event: x.event })));
  }
  const list = (lowdb.data.webhooks || []).filter(w => w.userId === req.user.id);
  res.json(list);
});

// test webhook (simulate delivery)
app.post('/api/webhooks/test/:id', auth, async (req, res) => {
  try {
    await lowdb.read();
    let hook;
    if (useMongo && DB && DB.Webhook) hook = await DB.Webhook.findOne({ _id: req.params.id, userId: req.user.id }).lean();
    else hook = (lowdb.data.webhooks || []).find(w => w.id === req.params.id && w.userId === req.user.id);
    if (!hook) return res.status(404).json({ error: 'Not found' });

    const payload = { event: hook.event, sample: { hello: 'world', at: new Date().toISOString() } };

    // You can optionally POST to the real URL — commented out for safety
    // const r = await fetch(hook.url, { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } });

    return res.json({ delivered: true, to: hook.url, payload });
  } catch (err) {
    log.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// fallback SPA routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

// start
app.listen(PORT, () => log.info(`Server running on http://localhost:${PORT}`));

// graceful shutdown
process.on('SIGINT', () => {
  log.info('SIGINT received, shutting down');
  process.exit(0);
});