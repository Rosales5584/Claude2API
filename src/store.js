const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(STORE_FILE)) {
    const adminUser = process.env.ADMIN_USER || 'admin';
    const adminPass = process.env.ADMIN_PASS || 'change_me_please';
    const sessionKeys = (process.env.CLAUDE_SESSION_KEYS || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

    const accounts = sessionKeys.map((key, i) => ({
      id: `acc-${i + 1}`,
      email: `account${i + 1}@local`,
      sessionKey: key,
      dailyLimit: Number(process.env.CLAUDE_DAILY_LIMIT || 0),
      status: 'active'
    }));

    const initial = {
      adminUser,
      adminPassHash: bcrypt.hashSync(adminPass, 10),
      accounts,
      usageEvents: []
    };

    fs.writeFileSync(STORE_FILE, JSON.stringify(initial, null, 2), 'utf8');
  }
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
}

function writeStore(data) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

module.exports = {
  readStore,
  writeStore
};
