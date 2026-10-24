const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'database.json');

// Default initial state
const DEFAULT_DATA = {
  maintenance: {
    enabled: false,
    allowed_logins: [],
    blocked: false,
    title: 'maintenance',
    message: "we're doing maintenance. everything is paused until we're back."
  },
  global_features: {
    marker: { enabled: true, type: 'Define Aura' },
    aimLag: { enabled: false, onFire: false, onScope: false },
    fastLanding: { enabled: false, spot: 'Peak' },
    fastRevive: { enabled: false },
    gloo: { enabled: false, yawDeg: 180 },
    aimpoint: { enabled: false }
  },
  nodes: [
    { id: 'sg1', name: 'Singapore Node 01', flag: '🇸🇬', host: 'sg1.nulldash.store', port: 443, ping: 24, status: 'online', users: 48 },
    { id: 'del1', name: 'Delhi Node 02', flag: '🇮🇳', host: 'del1.nulldash.store', port: 443, ping: 38, status: 'online', users: 29 },
    { id: 'fr1', name: 'France Node 03', flag: '🇫🇷', host: 'fr1.nulldash.store', port: 443, ping: 110, status: 'online', users: 12 }
  ],
  keys: [




  ]
};

// Load database from file
function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      saveDb(DEFAULT_DATA);
      return DEFAULT_DATA;
    }
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return DEFAULT_DATA;
  }
}

// Save database to file
function saveDb(data) {
  try {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save database:', e);
  }
}

// Canonical key comparison avoids false "invalid key" errors caused by hyphens, spaces, or casing.
function normalizeKey(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// DB Helpers
const db = {
  get() {
    return loadDb();
  },

  update(fn) {
    const data = loadDb();
    fn(data);
    saveDb(data);
    return data;
  },

  findKey(keyStr) {
    const data = loadDb();
    const clean = normalizeKey(keyStr);
    if (!clean) return undefined;
    return data.keys.find(k => normalizeKey(k.key) === clean);
  },

  addKey(keyObj) {
    return this.update(data => {
      data.keys.unshift(keyObj);
    });
  },

  updateKey(keyStr, updates) {
    return this.update(data => {
      const target = normalizeKey(keyStr);
      const idx = data.keys.findIndex(k => normalizeKey(k.key) === target);
      if (idx !== -1) {
        data.keys[idx] = { ...data.keys[idx], ...updates };
      }
    });
  },

  deleteKey(keyStr) {
    return this.update(data => {
      const target = normalizeKey(keyStr);
      data.keys = data.keys.filter(k => normalizeKey(k.key) !== target);
    });
  },

  getMaintenance() {
    const data = loadDb();
    return data.maintenance;
  },

  setMaintenance(updates) {
    return this.update(data => {
      data.maintenance = { ...data.maintenance, ...updates };
    });
  }
};

module.exports = db;
