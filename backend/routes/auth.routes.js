const express = require('express');
const router = express.Router();
const db = require('../db');

// User login
router.post('/login', (req, res) => {
  const { username, password, role } = req.body;

  db.get(
    `SELECT * FROM users WHERE username = ? AND password = ? AND role = ?`,
    [username, password, role],
    (err, row) => {
      if (!row)
        return res
          .status(401)
          .json({ ok: false, error: 'invallid_credentials' });
      const { name, username, subjectName } = row;

      return res.json({ ok: true, name, username, subjectName });
    },
  );
});

module.exports = router;
