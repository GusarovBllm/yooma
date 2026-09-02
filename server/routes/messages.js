const express = require('express');
const Message = require('../models/Message');
const Chat = require('../models/Chat');
const auth = require('../middleware/auth');
const router = express.Router();

// Get messages for a chat
router.get('/:chatId', auth, async (req, res) => {
  try {
    const messages = await Message.find({ chat: req.params.chatId }).populate('sender', 'login avatar').sort({ createdAt: -1 }).limit(100);
    res.json(messages.reverse());
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// Send message
router.post('/', auth, async (req, res) => {
  try {
    const { chatId, text, file, fileName } = req.body;
    if (!chatId || (!text && !file)) return res.status(400).json({ error: 'Нет данных' });
    const msg = new Message({ chat: chatId, sender: req.userId, text: text || '', file: file || '', fileName: fileName || '' });
    await msg.save();
    await Chat.findByIdAndUpdate(chatId, { lastMessage: text || fileName || 'Файл', lastMessageDate: new Date() });
    const populated = await Message.findById(msg._id).populate('sender', 'login avatar');
    res.json(populated);
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

module.exports = router;