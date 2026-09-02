const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
  type: { type: String, enum: ['private', 'group'], default: 'private' },
  name: { type: String, default: '' },
  avatar: { type: String, default: '' },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lastMessage: { type: String, default: '' },
  lastMessageDate: Date,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Chat', chatSchema);