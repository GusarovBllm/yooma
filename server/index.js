const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');

const JWT_SECRET = process.env.JWT_SECRET || 'yooma_secret_key_2026';
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data.json');

// ─── JSON Database ───
let data = { users: [], chats: [], messages: [], chatMembers: [], nextId: 1 };

function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) {
      data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    }
  } catch (e) { console.error('DB load error:', e.message); }
}

function saveDb() {
  fs.writeFileSync(DB_PATH, JSON.stringify(data));
}

function nextId() { return data.nextId++; }

function findUser(query) {
  return data.users.find(u => u.login === query || u.email === query);
}

function getUser(id) {
  return data.users.find(u => u.id === id);
}

loadDb();

// ─── Express ───
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
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
    req.userId = jwt.verify(token, JWT_SECRET).userId;
    next();
  } catch (e) { res.status(401).json({ error: 'Токен недействителен' }); }
}

// ─── Auth ───
app.post('/api/auth/register', async (req, res) => {
  try {
    const { login, email, password } = req.body;
    if (!login || !email || !password) return res.status(400).json({ error: 'Заполните все поля' });
    if (data.users.find(u => u.login === login || u.email === email)) return res.status(400).json({ error: 'Логин или email уже заняты' });
    const hash = await bcrypt.hash(password, 12);
    const user = { id: nextId(), login, email, password: hash, avatar: '', banner: '', bio: '', status: 'offline', createdAt: new Date().toISOString() };
    data.users.push(user);
    saveDb();
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, login, email, avatar: '' } });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    const user = findUser(login);
    if (!user) return res.status(400).json({ error: 'Пользователь не найден' });
    if (!await bcrypt.compare(password, user.password)) return res.status(400).json({ error: 'Неверный пароль' });
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, login: user.login, email: user.email, avatar: user.avatar || '' } });
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ─── Chats ───
app.get('/api/chats', auth, (req, res) => {
  const chatIds = data.chatMembers.filter(cm => cm.userId === req.userId).map(cm => cm.chatId);
  const chats = data.chats.filter(c => chatIds.includes(c.id)).sort((a, b) => (b.lastMessageDate || '') > (a.lastMessageDate || '') ? 1 : -1);
  const result = chats.map(c => ({
    ...c, _id: c.id,
    members: data.chatMembers.filter(cm => cm.chatId === c.id).map(cm => {
      const u = getUser(cm.userId);
      return u ? { id: u.id, _id: u.id, login: u.login, avatar: u.avatar } : { id: cm.userId };
    })
  }));
  res.json(result);
});

app.post('/api/chats/private', auth, (req, res) => {
  const { userId } = req.body;
  const existing = data.chats.find(c => c.type === 'private' && data.chatMembers.filter(cm => cm.chatId === c.id).every(cm => cm.userId === req.userId || cm.userId === userId) && data.chatMembers.filter(cm => cm.chatId === c.id).length === 2);
  if (existing) {
    const members = data.chatMembers.filter(cm => cm.chatId === existing.id).map(cm => { const u = getUser(cm.userId); return u ? { id: u.id, _id: u.id, login: u.login, avatar: u.avatar } : { id: cm.userId }; });
    return res.json({ ...existing, _id: existing.id, members });
  }
  const chat = { id: nextId(), type: 'private', name: '', avatar: '', lastMessage: '', lastMessageDate: null, createdAt: new Date().toISOString() };
  data.chats.push(chat);
  data.chatMembers.push({ chatId: chat.id, userId: req.userId });
  data.chatMembers.push({ chatId: chat.id, userId });
  saveDb();
  const members = data.chatMembers.filter(cm => cm.chatId === chat.id).map(cm => { const u = getUser(cm.userId); return u ? { id: u.id, _id: u.id, login: u.login, avatar: u.avatar } : { id: cm.userId }; });
  res.json({ ...chat, _id: chat.id, members });
});

// ─── Messages ───
app.get('/api/messages/:chatId', auth, (req, res) => {
  const msgs = data.messages.filter(m => m.chatId === req.params.chatId).sort((a, b) => a.createdAt > b.createdAt ? 1 : -1).slice(-100);
  res.json(msgs.map(m => ({ ...m, _id: m.id, chatId: m.chatId, sender: { _id: m.senderId, login: m.senderLogin, avatar: '' } })));
});

app.post('/api/messages', auth, (req, res) => {
  const { chatId, text, file, fileName } = req.body;
  const user = getUser(req.userId);
  const msg = { id: nextId(), chatId: Number(chatId), senderId: req.userId, senderLogin: user ? user.login : 'deleted', text: text || '', file: file || '', fileName: fileName || '', createdAt: new Date().toISOString() };
  data.messages.push(msg);
  const chat = data.chats.find(c => c.id === Number(chatId));
  if (chat) { chat.lastMessage = text || fileName || 'Файл'; chat.lastMessageDate = msg.createdAt; }
  saveDb();
  res.json({ ...msg, _id: msg.id, chatId: msg.chatId, sender: { _id: msg.senderId, login: msg.senderLogin } });
});

// ─── Users ───
app.get('/api/users/search', auth, (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  res.json(data.users.filter(u => u.login.toLowerCase().includes(q) && u.id !== req.userId).slice(0, 20).map(u => ({ id: u.id, login: u.login, avatar: u.avatar, status: u.status })));
});

app.get('/api/users/:id', auth, (req, res) => {
  const u = getUser(Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Не найден' });
  res.json({ id: u.id, login: u.login, avatar: u.avatar, banner: u.banner, bio: u.bio, status: u.status });
});

app.put('/api/users/me', auth, (req, res) => {
  const user = getUser(req.userId);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  if (req.body.avatar !== undefined) user.avatar = req.body.avatar;
  if (req.body.banner !== undefined) user.banner = req.body.banner;
  if (req.body.bio !== undefined) user.bio = req.body.bio;
  saveDb();
  res.json({ id: user.id, login: user.login, avatar: user.avatar, banner: user.banner, bio: user.bio, status: user.status });
});

// ─── Upload ───
app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname });
});

// ─── SPA ───
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── WebSocket ───
const onlineUsers = new Map();
io.on('connection', (socket) => {
  socket.on('login', (userId) => {
    onlineUsers.set(userId, socket.id);
    io.emit('user-online', userId);
    const u = getUser(userId); if (u) u.status = 'online';
  });
  socket.on('join-chat', (chatId) => socket.join(String(chatId)));
  socket.on('leave-chat', (chatId) => socket.leave(String(chatId)));
  socket.on('new-message', (data) => socket.to(String(data.chatId)).emit('message', data));
  socket.on('typing', (data) => socket.to(String(data.chatId)).emit('user-typing', data));
  socket.on('disconnect', () => {
    for (let [userId, sid] of onlineUsers.entries()) {
      if (sid === socket.id) { onlineUsers.delete(userId); io.emit('user-offline', userId); const u = getUser(userId); if (u) u.status = 'offline'; break; }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log('Yooma: ' + PORT));