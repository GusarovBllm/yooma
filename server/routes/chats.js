const express = require('express');
const Chat = require('../models/Chat');
const User = require('../models/User');
const auth = require('../middleware/auth');
const router = express.Router();

// Get all user chats
router.get('/', auth, async (req, res) => {
  try {
    const chats = await Chat.find({ members: req.userId }).populate('members', 'login avatar status').sort({ lastMessageDate: -1 });
    res.json(chats);
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// Create or get private chat
router.post('/private', auth, async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Нет userId' });
    const existing = await Chat.findOne({ type: 'private', members: { $all: [req.userId, userId] } }).populate('members', 'login avatar status');
    if (existing) return res.json(existing);
    const chat = new Chat({ type: 'private', members: [req.userId, userId] });
    await chat.save();
    const populated = await Chat.findById(chat._id).populate('members', 'login avatar status');
    res.json(populated);
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// Create group chat
router.post('/group', auth, async (req, res) => {
  try {
    const { name, members } = req.body;
    if (!name || !members || !members.length) return res.status(400).json({ error: 'Название и участники обязательны' });
    const allMembers = [...new Set([...members, req.userId.toString()])];
    const chat = new Chat({ type: 'group', name, members: allMembers, admin: req.userId });
    await chat.save();
    const populated = await Chat.findById(chat._id).populate('members', 'login avatar status');
    res.json(populated);
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

module.exports = router;