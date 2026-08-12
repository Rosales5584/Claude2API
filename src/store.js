const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
require('./load-env')();

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const STORE_FILE = process.env.STORE_FILE
  ? path.resolve(process.env.STORE_FILE)
  : path.join(DATA_DIR, 'store.json');
let storeQueue = Promise.resolve();

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

async function readStore() {
  ensureStore();
  const content = await fs.promises.readFile(STORE_FILE, 'utf8');
  return JSON.parse(content);
}

async function writeStore(data) {
  await fs.promises.writeFile(STORE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function withStoreLock(handler) {
  const run = async () => {
    const store = await readStore();
    const result = await handler(store);
    await writeStore(store);
    return result;
  };
  const op = storeQueue.then(run, run);
  storeQueue = op.catch(() => {});
  return op;
}

module.exports = {
  readStore,
  writeStore,
  withStoreLock
};
