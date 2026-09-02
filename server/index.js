const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const Database = require('better-sqlite3');

const JWT_SECRET = process.env.JWT_SECRET || 'yooma_secret_key_2026';
const PORT = process.env.PORT || 3000;

// Init DB
const db = new Database(path.join(__dirname, 'yooma.db'));
db.pragma('journal_mode=WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    avatar TEXT DEFAULT '',
    banner TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    status TEXT DEFAULT 'offline',
    createdAt TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT DEFAULT 'private',
    name TEXT DEFAULT '',
    avatar TEXT DEFAULT '',
    lastMessage TEXT DEFAULT '',
    lastMessageDate TEXT,
    createdAt TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS chat_members (
    chatId INTEGER,
    userId INTEGER,
    FOREIGN KEY(chatId) REFERENCES chats(id),
    FOREIGN KEY(userId) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chatId INTEGER,
    senderId INTEGER,
    text TEXT DEFAULT '',
    file TEXT DEFAULT '',
    fileName TEXT DEFAULT '',
    createdAt TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(chatId) REFERENCES chats(id),
    FOREIGN KEY(senderId) REFERENCES users(id)
  );
`);

// Express setup
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// File upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// Auth middleware
function auth(req, res, next) {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Нет доступа' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (e) { res.status(401).json({ error: 'Токен недействителен' }); }
}

// ─── Auth API ───
app.post('/api/auth/register', async (req, res) => {
  try {
    const { login, email, password } = req.body;
    if (!login || !email || !password) return res.status(400).json({ error: 'Заполните все поля' });
    const exists = db.prepare('SELECT id FROM users WHERE login=? OR email=?').get(login, email);
    if (exists) return res.status(400).json({ error: 'Логин или email уже заняты' });
    const hash = await bcrypt.hash(password, 12);
    const r = db.prepare('INSERT INTO users (login,email,password) VALUES (?,?,?)').run(login, email, hash);
    const token = jwt.sign({ userId: r.lastInsertRowid }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: r.lastInsertRowid, login, email, avatar: '' } });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE login=? OR email=?').get(login, login);
    if (!user) return res.status(400).json({ error: 'Пользователь не найден' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Неверный пароль' });
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, login: user.login, email: user.email, avatar: user.avatar || '' } });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ─── Chats API ───
app.get('/api/chats', auth, (req, res) => {
  const chats = db.prepare(`
    SELECT c.* FROM chats c
    JOIN chat_members cm ON c.id = cm.chatId
    WHERE cm.userId = ?
    ORDER BY c.lastMessageDate DESC
  `).all(req.userId);
  const result = chats.map(c => {
    const members = db.prepare('SELECT u.id,u.login,u.avatar FROM users u JOIN chat_members cm ON u.id=cm.userId WHERE cm.chatId=?').all(c.id);
    return { ...c, _id: c.id, members };
  });
  res.json(result);
});

app.post('/api/chats/private', auth, (req, res) => {
  const { userId } = req.body;
  const existing = db.prepare(`
    SELECT c.id FROM chats c
    JOIN chat_members cm1 ON c.id=cm1.chatId AND cm1.userId=?
    JOIN chat_members cm2 ON c.id=cm2.chatId AND cm2.userId=?
    WHERE c.type='private'
  `).get(req.userId, userId);
  if (existing) {
    const chat = db.prepare('SELECT * FROM chats WHERE id=?').get(existing.id);
    const members = db.prepare('SELECT u.id,u.login,u.avatar FROM users u JOIN chat_members cm ON u.id=cm.userId WHERE cm.chatId=?').all(existing.id);
    return res.json({ ...chat, _id: chat.id, members });
  }
  const r = db.prepare('INSERT INTO chats (type) VALUES (?)').run('private');
  db.prepare('INSERT INTO chat_members (chatId,userId) VALUES (?,?)').run(r.lastInsertRowid, req.userId);
  db.prepare('INSERT INTO chat_members (chatId,userId) VALUES (?,?)').run(r.lastInsertRowid, userId);
  const chat = db.prepare('SELECT * FROM chats WHERE id=?').get(r.lastInsertRowid);
  const members = db.prepare('SELECT u.id,u.login,u.avatar FROM users u JOIN chat_members cm ON u.id=cm.userId WHERE cm.chatId=?').all(r.lastInsertRowid);
  res.json({ ...chat, _id: chat.id, members });
});

// ─── Messages API ───
app.get('/api/messages/:chatId', auth, (req, res) => {
  const msgs = db.prepare('SELECT m.*, u.login as senderLogin, u.avatar as senderAvatar FROM messages m JOIN users u ON m.senderId=u.id WHERE m.chatId=? ORDER BY m.createdAt ASC LIMIT 100').all(req.params.chatId);
  res.json(msgs.map(m => ({ _id: m.id, chat: m.chatId, chatId: m.chatId, text: m.text, file: m.file, fileName: m.fileName, createdAt: m.createdAt, sender: { _id: m.senderId, login: m.senderLogin, avatar: m.senderAvatar } })));
});

app.post('/api/messages', auth, (req, res) => {
  const { chatId, text, file, fileName } = req.body;
  const r = db.prepare('INSERT INTO messages (chatId,senderId,text,file,fileName) VALUES (?,?,?,?,?)').run(chatId, req.userId, text||'', file||'', fileName||'');
  db.prepare('UPDATE chats SET lastMessage=?, lastMessageDate=datetime(?) WHERE id=?').run(text||fileName||'Файл', new Date().toISOString(), chatId);
  const msg = db.prepare('SELECT m.*, u.login as senderLogin, u.avatar as senderAvatar FROM messages m JOIN users u ON m.senderId=u.id WHERE m.id=?').get(r.lastInsertRowid);
  res.json({ _id: msg.id, chatId: msg.chatId, text: msg.text, file: msg.file, fileName: msg.fileName, createdAt: msg.createdAt, sender: { _id: msg.senderId, login: msg.senderLogin, avatar: msg.senderAvatar } });
});

// ─── Users API ───
app.get('/api/users/search', auth, (req, res) => {
  const q = req.query.q || '';
  const users = db.prepare("SELECT id,login,avatar,status FROM users WHERE login LIKE ? AND id != ? LIMIT 20").get('%' + q + '%', req.userId);
  res.json(users ? [users] : []);
});

app.get('/api/users/:id', auth, (req, res) => {
  const user = db.prepare('SELECT id,login,avatar,banner,bio,status FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  res.json(user);
});

app.put('/api/users/me', auth, (req, res) => {
  const { avatar, banner, bio } = req.body;
  if (avatar !== undefined) db.prepare('UPDATE users SET avatar=? WHERE id=?').run(avatar, req.userId);
  if (banner !== undefined) db.prepare('UPDATE users SET banner=? WHERE id=?').run(banner, req.userId);
  if (bio !== undefined) db.prepare('UPDATE users SET bio=? WHERE id=?').run(bio, req.userId);
  const user = db.prepare('SELECT id,login,avatar,banner,bio,status FROM users WHERE id=?').get(req.userId);
  res.json(user);
});

// Upload
app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket
const onlineUsers = new Map();
io.on('connection', (socket) => {
  socket.on('login', (userId) => {
    onlineUsers.set(userId, socket.id);
    io.emit('user-online', userId);
    db.prepare('UPDATE users SET status=? WHERE id=?').run('online', userId);
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
        db.prepare('UPDATE users SET status=? WHERE id=?').run('offline', userId);
        break;
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Yooma running on port ' + PORT);
  console.log('Open http://0.0.0.0:' + PORT);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled:', err);
});