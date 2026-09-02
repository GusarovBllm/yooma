const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'yooma_secret_key_change_in_prod';

router.post('/register', async (req, res) => {
  try {
    const { login, email, password } = req.body;
    if (!login || !email || !password) return res.status(400).json({ error: 'Заполните все поля' });
    const exists = await User.findOne({ $or: [{ login }, { email }] });
    if (exists) return res.status(400).json({ error: 'Логин или email уже заняты' });
    const user = new User({ login, email, password });
    await user.save();
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, login: user.login, email: user.email, avatar: user.avatar } });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

router.post('/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполните поля' });
    const user = await User.findOne({ $or: [{ login }, { email: login }] });
    if (!user) return res.status(400).json({ error: 'Пользователь не найден' });
    const match = await user.comparePassword(password);
    if (!match) return res.status(400).json({ error: 'Неверный пароль' });
    const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, login: user.login, email: user.email, avatar: user.avatar } });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

module.exports = router;