const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const crypto = require('crypto');

const JWT_SECRET = 'yooma_simple_key';
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data.json');

let data = { users: [], chats: [], messages: [], chatMembers: [], nextId: 1 };

function loadDb() {
  try { if (fs.existsSync(DB_PATH)) data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch (e) {}
}
function saveDb() { fs.writeFileSync(DB_PATH, JSON.stringify(data)); }
function nextId() { return data.nextId++; }
function getUser(id) { return data.users.find(u => u.id === id); }
function hashPwd(p) { return crypto.createHash('sha256').update(p).digest('hex'); }

loadDb();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: path.join(__dirname, 'uploads'), limits: { fileSize: 10 * 1024 * 1024 } });

function auth(req, res, next) {
  try { req.userId = jwt.verify(req.header('Authorization')?.replace('Bearer ',''), JWT_SECRET).userId; next(); }
  catch(e) { res.status(401).json({ error: 'Нет доступа' }); }
}

app.post('/api/auth/register', (req, res) => {
  const { login, email, password } = req.body;
  if (!login || !email || !password) return res.status(400).json({ error: 'Заполните поля' });
  if (data.users.find(u => u.login === login || u.email === email)) return res.status(400).json({ error: 'Занято' });
  const user = { id: nextId(), login, email, password: hashPwd(password), avatar: '', bio: '', status: 'offline', createdAt: new Date().toISOString() };
  data.users.push(user); saveDb();
  res.json({ token: jwt.sign({ userId: user.id }, JWT_SECRET), user: { id: user.id, login, email, avatar: '' } });
});

app.post('/api/auth/login', (req, res) => {
  const { login, password } = req.body;
  const user = data.users.find(u => u.login === login || u.email === login);
  if (!user || user.password !== hashPwd(password)) return res.status(400).json({ error: 'Неверные данные' });
  res.json({ token: jwt.sign({ userId: user.id }, JWT_SECRET), user: { id: user.id, login: user.login, email: user.email, avatar: user.avatar } });
});

app.get('/api/chats', auth, (req, res) => {
  const chatIds = data.chatMembers.filter(cm => cm.userId === req.userId).map(cm => cm.chatId);
  const chats = data.chats.filter(c => chatIds.includes(c.id)).sort((a,b) => (b.lastMessageDate||'') > (a.lastMessageDate||'') ? 1 : -1);
  res.json(chats.map(c => ({ ...c, _id: c.id, members: data.chatMembers.filter(cm => cm.chatId === c.id).map(cm => { const u = getUser(cm.userId); return u ? { id: u.id, _id: u.id, login: u.login, avatar: u.avatar } : { id: cm.userId } }) })));
});

app.post('/api/chats/private', auth, (req, res) => {
  const { userId } = req.body;
  let chat = data.chats.find(c => c.type === 'private' && data.chatMembers.filter(cm => cm.chatId === c.id).every(cm => cm.userId === req.userId || cm.userId === userId) && data.chatMembers.filter(cm => cm.chatId === c.id).length === 2);
  if (!chat) {
    chat = { id: nextId(), type: 'private', name: '', lastMessage: '', lastMessageDate: null, createdAt: new Date().toISOString() };
    data.chats.push(chat);
    data.chatMembers.push({ chatId: chat.id, userId: req.userId }, { chatId: chat.id, userId }); saveDb();
  }
  res.json({ ...chat, _id: chat.id, members: data.chatMembers.filter(cm => cm.chatId === chat.id).map(cm => { const u = getUser(cm.userId); return u ? { id: u.id, _id: u.id, login: u.login, avatar: u.avatar } : { id: cm.userId } }) });
});

app.get('/api/messages/:chatId', auth, (req, res) => {
  res.json(data.messages.filter(m => m.chatId === Number(req.params.chatId)).slice(-100).map(m => ({ ...m, _id: m.id, sender: { _id: m.senderId, login: m.senderLogin } })));
});

app.post('/api/messages', auth, (req, res) => {
  const { chatId, text, file, fileName } = req.body;
  const user = getUser(req.userId);
  const msg = { id: nextId(), chatId: Number(chatId), senderId: req.userId, senderLogin: user?.login||'?', text: text||'', file: file||'', fileName: fileName||'', createdAt: new Date().toISOString() };
  data.messages.push(msg);
  const chat = data.chats.find(c => c.id === Number(chatId));
  if (chat) { chat.lastMessage = text || fileName || 'Файл'; chat.lastMessageDate = msg.createdAt; }
  saveDb();
  io.to(String(chatId)).emit('message', { ...msg, chatId: String(chatId) });
  res.json({ ...msg, _id: msg.id, sender: { _id: msg.senderId, login: msg.senderLogin } });
});

app.get('/api/users/search', auth, (req, res) => {
  const q = (req.query.q||'').toLowerCase();
  res.json(data.users.filter(u => u.login.toLowerCase().includes(q) && u.id !== req.userId).slice(0,20).map(u => ({ id: u.id, login: u.login, avatar: u.avatar, status: u.status })));
});

app.put('/api/users/me', auth, (req, res) => {
  const user = getUser(req.userId);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  if (req.body.avatar !== undefined) user.avatar = req.body.avatar;
  if (req.body.bio !== undefined) user.bio = req.body.bio;
  saveDb();
  res.json({ id: user.id, login: user.login, avatar: user.avatar, bio: user.bio, status: user.status });
});

app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const onlineUsers = new Map();
io.on('connection', (socket) => {
  socket.on('login', (userId) => { onlineUsers.set(userId, socket.id); io.emit('user-online', userId); });
  socket.on('join-chat', (id) => socket.join(String(id)));
  socket.on('leave-chat', (id) => socket.leave(String(id)));
  socket.on('new-message', (d) => socket.to(String(d.chatId)).emit('message', d));
  socket.on('typing', (d) => socket.to(String(d.chatId)).emit('user-typing', d));
  socket.on('disconnect', () => { for (let [uid, sid] of onlineUsers.entries()) { if (sid === socket.id) { onlineUsers.delete(uid); io.emit('user-offline', uid); break; } } });
});

server.listen(PORT, '0.0.0.0', () => console.log('Yooma UP'));