const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const initSqlJs = require('sql.js');
const fs = require('fs');

const JWT_SECRET = process.env.JWT_SECRET || 'yooma_secret_key_2026';
const PORT = process.env.PORT || 3000;

let db;
const DB_PATH = path.join(__dirname, 'yooma.db');

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    avatar TEXT DEFAULT '',
    banner TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    status TEXT DEFAULT 'offline',
    createdAt TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT DEFAULT 'private',
    name TEXT DEFAULT '',
    avatar TEXT DEFAULT '',
    lastMessage TEXT DEFAULT '',
    lastMessageDate TEXT,
    createdAt TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS chat_members (
    chatId INTEGER,
    userId INTEGER,
    FOREIGN KEY(chatId) REFERENCES chats(id),
    FOREIGN KEY(userId) REFERENCES users(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chatId INTEGER,
    senderId INTEGER,
    text TEXT DEFAULT '',
    file TEXT DEFAULT '',
    fileName TEXT DEFAULT '',
    createdAt TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(chatId) REFERENCES chats(id),
    FOREIGN KEY(senderId) REFERENCES users(id)
  )`);
  saveDb();
}

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function q(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  return stmt;
}

function get(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  if (stmt.step()) {
    return stmt.getAsObject();
  }
  stmt.free();
  return null;
}

function all(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function run(sql, params) {
  db.run(sql, params);
  saveDb();
}

// Express setup
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

function auth(req, res, next) {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Нет доступа' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (e) { res.status(401).json({ error: 'Токен недействителен' }); }
}

// Auth
app.post('/api/auth/register', async (req, res) => {
  try {
    const { login, email, password } = req.body;
    if (!login || !email || !password) return res.status(400).json({ error: 'Заполните все поля' });
    const exists = get('SELECT id FROM users WHERE login=? OR email=?', [login, email]);
    if (exists) return res.status(400).json({ error: 'Логин или email уже заняты' });
    const hash = await bcrypt.hash(password, 12);
    run('INSERT INTO users (login,email,password) VALUES (?,?,?)', [login, email, hash]);
    const user = get('SELECT * FROM users WHERE login=?', [login]);
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, login, email, avatar: '' } });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    const user = get('SELECT * FROM users WHERE login=? OR email=?', [login, login]);
    if (!user) return res.status(400).json({ error: 'Пользователь не найден' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Неверный пароль' });
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, login: user.login, email: user.email, avatar: user.avatar || '' } });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// Chats
app.get('/api/chats', auth, (req, res) => {
  const chats = all(`SELECT c.* FROM chats c
    JOIN chat_members cm ON c.id = cm.chatId
    WHERE cm.userId = ? ORDER BY c.lastMessageDate DESC`, [req.userId]);
  const result = chats.map(c => {
    const members = all('SELECT u.id,u.login,u.avatar FROM users u JOIN chat_members cm ON u.id=cm.userId WHERE cm.chatId=?', [c.id]);
    return { ...c, _id: c.id, members };
  });
  res.json(result);
});

app.post('/api/chats/private', auth, (req, res) => {
  const { userId } = req.body;
  const existing = get(`SELECT c.id FROM chats c
    JOIN chat_members cm1 ON c.id=cm1.chatId AND cm1.userId=?
    JOIN chat_members cm2 ON c.id=cm2.chatId AND cm2.userId=?
    WHERE c.type='private'`, [req.userId, userId]);
  if (existing) {
    const chat = get('SELECT * FROM chats WHERE id=?', [existing.id]);
    const members = all('SELECT u.id,u.login,u.avatar FROM users u JOIN chat_members cm ON u.id=cm.userId WHERE cm.chatId=?', [existing.id]);
    return res.json({ ...chat, _id: chat.id, members });
  }
  run('INSERT INTO chats (type) VALUES (?)', ['private']);
  const chat = get('SELECT * FROM chats ORDER BY id DESC LIMIT 1');
  run('INSERT INTO chat_members (chatId,userId) VALUES (?,?)', [chat.id, req.userId]);
  run('INSERT INTO chat_members (chatId,userId) VALUES (?,?)', [chat.id, userId]);
  const members = all('SELECT u.id,u.login,u.avatar FROM users u JOIN chat_members cm ON u.id=cm.userId WHERE cm.chatId=?', [chat.id]);
  res.json({ ...chat, _id: chat.id, members });
});

// Messages
app.get('/api/messages/:chatId', auth, (req, res) => {
  const msgs = all('SELECT m.*, u.login as senderLogin, u.avatar as senderAvatar FROM messages m JOIN users u ON m.senderId=u.id WHERE m.chatId=? ORDER BY m.createdAt ASC LIMIT 100', [req.params.chatId]);
  res.json(msgs.map(m => ({ _id: m.id, chat: m.chatId, chatId: m.chatId, text: m.text, file: m.file, fileName: m.fileName, createdAt: m.createdAt, sender: { _id: m.senderId, login: m.senderLogin, avatar: m.senderAvatar } })));
});

app.post('/api/messages', auth, (req, res) => {
  const { chatId, text, file, fileName } = req.body;
  run('INSERT INTO messages (chatId,senderId,text,file,fileName) VALUES (?,?,?,?,?)', [chatId, req.userId, text||'', file||'', fileName||'']);
  run('UPDATE chats SET lastMessage=?, lastMessageDate=datetime(?) WHERE id=?', [text||fileName||'Файл', new Date().toISOString(), chatId]);
  const msg = get('SELECT m.*, u.login as senderLogin, u.avatar as senderAvatar FROM messages m JOIN users u ON m.senderId=u.id WHERE m.id IN (SELECT MAX(id) FROM messages)');
  res.json({ _id: msg.id, chatId: msg.chatId, text: msg.text, file: msg.file, fileName: msg.fileName, createdAt: msg.createdAt, sender: { _id: msg.senderId, login: msg.senderLogin, avatar: msg.senderAvatar } });
});

// Users
app.get('/api/users/search', auth, (req, res) => {
  const q = req.query.q || '';
  const users = all('SELECT id,login,avatar,status FROM users WHERE login LIKE ? AND id != ? LIMIT 20', ['%' + q + '%', req.userId]);
  res.json(users);
});

app.get('/api/users/:id', auth, (req, res) => {
  const user = get('SELECT id,login,avatar,banner,bio,status FROM users WHERE id=?', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  res.json(user);
});

app.put('/api/users/me', auth, (req, res) => {
  const { avatar, banner, bio } = req.body;
  if (avatar !== undefined) run('UPDATE users SET avatar=? WHERE id=?', [avatar, req.userId]);
  if (banner !== undefined) run('UPDATE users SET banner=? WHERE id=?', [banner, req.userId]);
  if (bio !== undefined) run('UPDATE users SET bio=? WHERE id=?', [bio, req.userId]);
  const user = get('SELECT id,login,avatar,banner,bio,status FROM users WHERE id=?', [req.userId]);
  res.json(user);
});

// Upload
app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname });
});

// SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket
const onlineUsers = new Map();
io.on('connection', (socket) => {
  socket.on('login', (userId) => {
    onlineUsers.set(userId, socket.id);
    io.emit('user-online', userId);
    run('UPDATE users SET status=? WHERE id=?', ['online', userId]);
  });
  socket.on('join-chat', (chatId) => socket.join(chatId));
  socket.on('leave-chat', (chatId) => socket.leave(chatId));
  socket.on('new-message', (data) => socket.to(data.chatId).emit('message', data));
  socket.on('typing', (data) => socket.to(data.chatId).emit('user-typing', data));
  socket.on('disconnect', () => {
    for (let [userId, sid] of onlineUsers.entries()) {
      if (sid === socket.id) {
        onlineUsers.delete(userId);
        io.emit('user-offline', userId);
        run('UPDATE users SET status=? WHERE id=?', ['offline', userId]);
        break;
      }
    }
  });
});

initDb().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Yooma running on port ' + PORT);
  });
}).catch(err => {
  console.error('Failed to init DB:', err);
});