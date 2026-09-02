const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'yooma_secret_key_change_in_prod';

module.exports = function(req, res, next) {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Нет доступа' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Токен недействителен' });
  }
};