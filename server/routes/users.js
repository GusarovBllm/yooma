const express = require('express');
const User = require('../models/User');
const auth = require('../middleware/auth');
const router = express.Router();

// Search users
router.get('/search', auth, async (req, res) => {
  try {
    const q = req.query.q || '';
    const users = await User.find({ login: { $regex: q, $options: 'i' } }).select('login avatar status').limit(20);
    res.json(users);
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// Get user profile
router.get('/:id', auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('login avatar banner bio status');
    if (!user) return res.status(404).json({ error: 'Не найден' });
    res.json(user);
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// Update profile
router.put('/me', auth, async (req, res) => {
  try {
    const { avatar, banner, bio } = req.body;
    const update = {};
    if (avatar !== undefined) update.avatar = avatar;
    if (banner !== undefined) update.banner = banner;
    if (bio !== undefined) update.bio = bio;
    const user = await User.findByIdAndUpdate(req.userId, update, { new: true }).select('login avatar banner bio status');
    res.json(user);
  } catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

module.exports = router;