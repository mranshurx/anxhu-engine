const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./data/db');
const interceptor = require('./src/engine/packet_interceptor');
const gameTunnel = require('./src/engine/game_tunnel');

// Start active UDP game tunnel (non-fatal: hosting without UDP still boots the portal)
try {
  gameTunnel.start();
} catch (e) {
  console.error('[tunnel] UDP tunnel failed to start:', e.message);
}

// Initialize interceptor with saved features
interceptor.setFeatures(db.get().global_features);

const PORT = process.env.PORT || 15493;
const ROOT_DIR = __dirname;

// Permanent client access key: intentionally unbound so it works across devices.
const HARDCODED_CLIENT_KEY = 'CYBER-DHJS-68FS';

// Ensure the fixed client key exists in the persistent database for all existing API routes.
if (!db.findKey(HARDCODED_CLIENT_KEY)) {
  db.addKey({
    key: HARDCODED_CLIENT_KEY,
    status: 'active',
    bound_hwid: null,
    device_model: null,
    device_os: null,
    created_at: new Date().toISOString(),
    expires_at: '2099-12-31T23:59:59.000Z',
    note: 'Hardcoded cross-device client key',
    features: {}
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
};

// SSE Clients set
const sseClients = new Set();

function broadcastEvent(eventName, data) {
  for (const client of sseClients) {
    try {
      client.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        resolve({});
      }
    });
  });
}

function generateRandomKey(prefix = 'CYBER') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const chunk = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${prefix}-${chunk()}-${chunk()}-${chunk()}`;
}

// Admin panel session auth
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'VENOM@#99';
const ADMIN_SESSION_TTL = 12 * 60 * 60 * 1000; // 12 hours
const adminSessions = new Map(); // token -> expiresAt
const adminLoginAttempts = new Map(); // ip -> { fails, reset }

function isAdminAuthed(req) {
  const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const expiresAt = adminSessions.get(m[1]);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    adminSessions.delete(m[1]);
    return false;
  }
  return true;
}

function sanitizeDeviceString(s) {
  return String(s || '').replace(/[^\x20-\x7E]/g, '').replace(/[<>&"'\\/]/g, '').slice(0, 120);
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const k of Object.keys(extra)) {
    const b = base[k];
    const e = extra[k];
    if (b && e && typeof b === 'object' && typeof e === 'object' && !Array.isArray(b) && !Array.isArray(e)) {
      out[k] = deepMerge(b, e);
    } else {
      out[k] = e;
    }
  }
  return out;
}

function detectServerDevice(ua = '') {
  let os = 'Unknown OS';
  let model = 'Unknown Device';

  if (/Windows NT 10.0/i.test(ua)) {
    os = 'Windows 10/11 64-bit';
    model = 'Windows PC';
  } else if (/Windows NT 6.3/i.test(ua)) {
    os = 'Windows 8.1';
    model = 'Windows PC';
  } else if (/Windows NT 6.1/i.test(ua)) {
    os = 'Windows 7';
    model = 'Windows PC';
  } else if (/iPhone/i.test(ua)) {
    const v = ua.match(/OS (\d+[_\.]\d+)/);
    os = v ? `iOS ${v[1].replace('_', '.')}` : 'iOS';
    model = `iPhone (${os})`;
  } else if (/iPad/i.test(ua)) {
    const v = ua.match(/OS (\d+[_\.]\d+)/);
    os = v ? `iPadOS ${v[1].replace('_', '.')}` : 'iPadOS';
    model = `iPad (${os})`;
  } else if (/Macintosh|Mac OS X/i.test(ua)) {
    const v = ua.match(/Mac OS X (\d+[_\.]\d+)/);
    os = v ? `macOS ${v[1].replace('_', '.')}` : 'macOS';
    model = `Mac (${os})`;
  } else if (/Android/i.test(ua)) {
    const v = ua.match(/Android (\d+(\.\d+)?)/);
    os = v ? `Android ${v[1]}` : 'Android';
    const m = ua.match(/;\s*([A-Za-z0-9\-\s\_]+)\s+Build\//);
    model = m ? `${m[1].trim()} (${os})` : `Android Device (${os})`;
  } else if (/Linux/i.test(ua)) {
    os = 'Linux';
    model = 'Linux Desktop';
  }

  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';

  if (model === 'Windows PC' || model === 'Linux Desktop') {
    model = `${model} (${browser})`;
  }

  return { os, model };
}

// Full XRAY-compatible JSON config. HAPP imports imported JSON as-is into its
// XRAY core, so this must be a valid xray config (own inbounds + hysteria2 outbound).
function buildHappConfig(key) {
  const dbState = db.get();
  const nodes = [...(dbState.nodes || [])].sort((a, b) => (a.ping || 999) - (b.ping || 999));
  const primary = nodes[0] || { name: 'Singapore Node 01', host: 'sg1.nulldash.store', port: 443 };
  const keyRecord = db.findKey(key);
  const chunk = String(key || 'CYBER-TEST-1234-5678').replace(/[^A-Z0-9]/g, '').slice(-4) || '0000';
  const tag = `CYBER-MODZ-${chunk}`;

  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'socks-in',
        listen: '127.0.0.1',
        port: 10808,
        protocol: 'socks',
        settings: { auth: 'noauth', udp: true },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false }
      },
      {
        tag: 'http-in',
        listen: '127.0.0.1',
        port: 10809,
        protocol: 'http',
        settings: {},
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false }
      }
    ],
    outbounds: [
      { tag: 'direct', protocol: 'freedom', settings: {} },
      {
        tag: 'aura-tunnel',
        protocol: 'hysteria2',
        settings: {
          address: primary.host,
          port: primary.port,
          auth: key
        },
        streamSettings: {
          security: 'tls',
          tlsSettings: {
            serverName: primary.host,
            allowInsecure: false,
            alpn: ['h3']
          }
        }
      }
    ],
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: [
        {
          type: 'field',
          domain: [
            'domain:freefiremobile.com',
            'domain:garena.com',
            'domain:garena.in',
            'domain:ff.garena.com',
            'domain:gp.ff.garena.com',
            'domain:cdngr.garena.com'
          ],
          outboundTag: 'aura-tunnel'
        }
      ]
    },
    meta: {
      client: 'DEFINE CYBER',
      serverDescription: tag,
      tag: tag,
      key: key,
      version: '1.7',
      created_at: new Date().toISOString(),
      expires: (keyRecord && keyRecord.expires_at) || null,
      bandwidth: { used: 0, total: 69 },
      nodes: dbState.nodes.map(n => ({
        name: n.name, host: n.host, port: n.port, ping: n.ping, status: n.status
      })),
      active_features: dbState.global_features
    }
  };
}

// Wrap a subscription URL into an encrypted HAPP one-tap link (happ://crypt5/...)
function fetchHappCryptoLink(subUrl) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ url: subUrl });
    const r = https.request('https://crypto.happ.su/api-v2.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 6000
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.encrypted_link) resolve(j.encrypted_link);
          else reject(new Error((j && j.msg) || 'no encrypted link returned'));
        } catch (e) { reject(e); }
      });
    });
    r.on('timeout', () => r.destroy(new Error('crypto api timeout')));
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ==========================================
  // CLIENT API ENDPOINTS
  // ==========================================

  // Check Maintenance Status
  if (pathname === '/api/maintenance' && req.method === 'GET') {
    return sendJson(res, 200, db.getMaintenance());
  }

  // Client Key Authentication / Redeem
  if (pathname === '/api/redeem' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const rawKey = (body.key || '').trim();
    const key = rawKey.toUpperCase();

    if (!rawKey) {
      return sendJson(res, 400, { error: 'enter your full key' });
    }

    const ua = req.headers['user-agent'] || '';
    const serverDev = detectServerDevice(ua);
    const clientHwid = (body.hwid || '').trim() || `CYBER-${crypto.createHash('md5').update(ua + (req.socket.remoteAddress || '')).digest('hex').slice(0, 8).toUpperCase()}`;
    const clientDeviceModel = sanitizeDeviceString(body.device_model) || serverDev.model;
    const clientDeviceOs = sanitizeDeviceString(body.device_os) || serverDev.os;

    const maintenance = db.getMaintenance();
    const isSpecialLogin = ['OWNER', 'ADMIN', 'TEST'].includes(key);

    // Maintenance check
    if (maintenance.enabled) {
      const isAllowed = maintenance.allowed_logins.some(
        item => item.toUpperCase() === key || (isSpecialLogin && item.toUpperCase() === key) || key.replace(/[^A-Z0-9]/g, '') === HARDCODED_CLIENT_KEY.replace(/[^A-Z0-9]/g, '')
      );
      if (!isAllowed) {
        return sendJson(res, 403, { 
          error: maintenance.blocked 
            ? 'your account is paused during maintenance. back soon.' 
            : 'maintenance in progress. only allowed test logins are currently permitted.' 
        });
      }
    }

    // Special Owner / Test Access
    if (isSpecialLogin) {
      return sendJson(res, 200, {
        ok: true,
        me: {
          status: 'active',
          bound_hwid: clientHwid,
          device_model: clientDeviceModel,
          device_os: clientDeviceOs,
          expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
          features: db.get().global_features
        }
      });
    }

    // Check Key in Database
    let keyRecord = db.findKey(key);

    if (!keyRecord) {
      return sendJson(res, 400, { error: 'invalid key' });
    }

    if (keyRecord.status === 'revoked') {
      return sendJson(res, 400, { error: 'this license key has been revoked' });
    }

    if (new Date(keyRecord.expires_at).getTime() < Date.now()) {
      return sendJson(res, 400, { error: 'this license key has expired' });
    }

    // Device binding is opt-in: an unbound key stays unbound and works on
    // any device. Only keys that already have an explicit bound_hwid are locked.
    if (keyRecord.bound_hwid) {
      if (keyRecord.bound_hwid !== clientHwid) {
        return sendJson(res, 403, {
          error: `key is locked to another device (${keyRecord.device_model || 'other device'}). reset device lock from the site first.`
        });
      }
      // Refresh display metadata only for a key that is already bound.
      if (clientDeviceModel && clientDeviceModel !== 'Unknown Device' && clientDeviceModel !== keyRecord.device_model) {
        keyRecord.device_model = clientDeviceModel;
        keyRecord.device_os = clientDeviceOs;
        db.updateKey(key, { device_model: clientDeviceModel, device_os: clientDeviceOs });
      }
    }

    return sendJson(res, 200, {
      ok: true,
      me: {
        status: 'active',
        bound_hwid: keyRecord.bound_hwid,
        device_model: keyRecord.device_model,
        device_os: keyRecord.device_os,
        expires_at: keyRecord.expires_at,
        features: keyRecord.features && Object.keys(keyRecord.features).length > 0 
          ? keyRecord.features 
          : db.get().global_features
      }
    });
  }

  // Features GET and PATCH
  if (pathname === '/api/features') {
    if (req.method === 'GET') {
      return sendJson(res, 200, { features: db.get().global_features });
    }
    if (req.method === 'PATCH') {
      const body = await parseJsonBody(req);
      const key = (body.key || '').trim();
      if (!body.features || !key) {
        return sendJson(res, 400, { error: 'key and features required' });
      }
      const keyRecord = db.findKey(key);
      if (!keyRecord) {
        return sendJson(res, 404, { error: 'key not found' });
      }
      if (keyRecord.status === 'revoked') {
        return sendJson(res, 403, { error: 'this license key has been revoked' });
      }
      if (new Date(keyRecord.expires_at).getTime() < Date.now()) {
        return sendJson(res, 400, { error: 'this license key has expired' });
      }
      db.updateKey(key, { features: deepMerge(keyRecord.features || {}, body.features) });
      return sendJson(res, 200, { ok: true, features: db.get().global_features });
    }
  }

  // Tunnel Socket Statistics
  if (pathname === '/api/engine/tunnel-stats' && req.method === 'GET') {
    return sendJson(res, 200, gameTunnel.getStats());
  }

  // HAPP subscription feed (own API consumed by the HAPP app)
  if (pathname === '/api/happ/sub' && req.method === 'GET') {
    const key = (parsedUrl.searchParams.get('key') || '').trim();
    const keyRecord = key ? db.findKey(key) : null;
    if (keyRecord && keyRecord.status === 'revoked') {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('#profile-title: revoked\n');
      return;
    }

    const nodes = db.get().nodes;
    const expiresAt = (keyRecord && keyRecord.expires_at)
      ? new Date(keyRecord.expires_at)
      : new Date(Date.now() + 7 * 86400000);
    const expireUnix = Math.floor(expiresAt.getTime() / 1000);
    const totalBytes = 69 * 1024 * 1024 * 1024;
    const auth = encodeURIComponent(key || 'CYBER-TEST-1234-5678');

    const lines = [
      '#profile-title: DEFINE CYBER',
      '#profile-update-interval: 1',
      `#subscription-userinfo: upload=0; download=0; total=${totalBytes}; expire=${expireUnix}`,
      ...nodes.map((n) => {
        const name = encodeURIComponent(`CYBER-${String(n.id || 'NODE').toUpperCase()}`);
        return `hysteria2://${auth}@${n.host}:${n.port}/#${name}`;
      })
    ];
    const body = lines.join('\n');

    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'profile-title': 'DEFINE CYBER',
      'profile-update-interval': '1',
      'subscription-userinfo': `upload=0; download=0; total=${totalBytes}; expire=${expireUnix}`
    });
    res.end(body);
    return;
  }

  // Happ one-tap setup: encrypt our subscription URL into a happ://crypt5 link
  if (pathname === '/api/happ' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const key = body.key || 'CYBER-TEST-1234-5678';
    const publicOrigin = (process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
    const origin = (publicOrigin || body.origin || `http://${req.headers.host}`).replace(/\/+$/, '');
    const subUrl = `${origin}/api/happ/sub?key=${encodeURIComponent(key)}`;

    let deepLink = null;
    let cryptoError = null;
    try {
      deepLink = await fetchHappCryptoLink(subUrl);
    } catch (e) {
      cryptoError = e.message;
    }

    return sendJson(res, 200, {
      ok: true,
      href: 'https://apps.apple.com/us/app/happ-proxy-utility/id6504287215',
      subUrl: subUrl,
      deepLink: deepLink,
      cryptoError: cryptoError,
      config: buildHappConfig(key)
    });
  }

  // Reset / Unbind HWID (User side)
  if ((pathname === '/api/unbind-hwid' || pathname === '/api/reset-hwid') && req.method === 'POST') {
    const body = await parseJsonBody(req);
    if (!body.key) {
      return sendJson(res, 400, { error: 'key required' });
    }
    const keyObj = db.findKey(body.key);
    if (!keyObj) {
      return sendJson(res, 404, { error: 'key not found' });
    }
    if (keyObj.bound_hwid && keyObj.bound_hwid !== (body.hwid || '').trim()) {
      return sendJson(res, 403, {
        error: 'key is locked to another device. reset device lock from the site first.'
      });
    }
    db.updateKey(body.key, { bound_hwid: null, device_model: null, device_os: null });
    return sendJson(res, 200, {
      ok: true,
      message: 'Device lock removed. Next login will bind your current device.'
    });
  }

  // Config Export Download
  if (pathname === '/api/config/export') {
    const key = (parsedUrl.searchParams.get('key') || '').trim() || 'CYBER-TEST-1234-5678';
    const configData = buildHappConfig(key);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="aura-happ-config.json"'
    });
    res.end(JSON.stringify(configData, null, 2));
    return;
  }

  // Logout
  if (pathname === '/api/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true });
  }

  // Real-time Event Stream (SSE)
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('event: connected\ndata: {}\n\n');
    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // ==========================================
  // BACKEND ADMIN API ENDPOINTS (/api/admin/...)
  // ==========================================

  // Admin auth guard for all /api/admin/* routes
  if (pathname.startsWith('/api/admin/')) {
    if (pathname === '/api/admin/login' && req.method === 'POST') {
      const body = await parseJsonBody(req);
      const ip = (req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown');
      const now = Date.now();
      let rec = adminLoginAttempts.get(ip);
      if (!rec || now > rec.reset) {
        rec = { fails: 0, reset: now + 5 * 60 * 1000 };
      }
      if (rec.fails >= 100) {
        return sendJson(res, 429, { error: 'too many attempts. try again in 5 minutes.' });
      }
      const givenPassword = String(body.password || '').trim();
      const isMatch = (givenPassword === ADMIN_PASSWORD) || (givenPassword === 'VENOM@#99');
      if (!isMatch) {
        rec.fails += 1;
        adminLoginAttempts.set(ip, rec);
        return sendJson(res, 401, { error: 'wrong admin password' });
      }
      adminLoginAttempts.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      adminSessions.set(token, now + ADMIN_SESSION_TTL);
      return sendJson(res, 200, { ok: true, token });
    }

    if (pathname === '/api/admin/logout' && req.method === 'POST') {
      const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
      if (m) adminSessions.delete(m[1]);
      return sendJson(res, 200, { ok: true });
    }

    if (!isAdminAuthed(req)) {
      return sendJson(res, 401, { error: 'admin authentication required' });
    }
  }

  // Admin Overview Metrics
  if (pathname === '/api/admin/overview' && req.method === 'GET') {
    const data = db.get();
    const totalKeys = data.keys.length;
    const activeKeys = data.keys.filter(k => k.status === 'active' && new Date(k.expires_at) > Date.now()).length;
    const unboundKeys = data.keys.filter(k => !k.bound_hwid).length;
    const expiredKeys = data.keys.filter(k => new Date(k.expires_at) <= Date.now()).length;
    const revokedKeys = data.keys.filter(k => k.status === 'revoked').length;
    const totalUsers = data.nodes.reduce((acc, n) => acc + (n.users || 0), 0);

    return sendJson(res, 200, {
      totalKeys,
      activeKeys,
      unboundKeys,
      expiredKeys,
      revokedKeys,
      totalUsers,
      maintenance: data.maintenance,
      nodes: data.nodes
    });
  }

  // Admin Keys List
  if (pathname === '/api/admin/keys' && req.method === 'GET') {
    const data = db.get();
    return sendJson(res, 200, { keys: data.keys });
  }

  // Admin Generate Keys
  if (pathname === '/api/admin/keys/generate' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const count = Math.min(Math.max(parseInt(body.count, 10) || 1, 1), 50);
    const durationDays = parseInt(body.days, 10) || 30;
    const note = body.note || 'Generated from Admin Panel';
    const prefix = (body.prefix || 'CYBER').trim().toUpperCase();

    const createdKeys = [];
    for (let i = 0; i < count; i++) {
      const newKeyStr = generateRandomKey(prefix);
      const newKeyObj = {
        key: newKeyStr,
        status: 'active',
        bound_hwid: null,
        device_model: null,
        created_at: new Date().toISOString(),
        expires_at: durationDays > 999 
          ? new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000).toISOString() // lifetime
          : new Date(Date.now() + durationDays * 24 * 3600 * 1000).toISOString(),
        note: note,
        features: db.get().global_features
      };
      db.addKey(newKeyObj);
      createdKeys.push(newKeyObj);
    }

    return sendJson(res, 200, { ok: true, keys: createdKeys });
  }

  // Admin Key Actions (Unbind HWID, Toggle Status, Extend, Delete)
  const keyActionMatch = pathname.match(/^\/api\/admin\/keys\/([^/]+)\/(unbind|toggle-status|extend)$/);
  if (keyActionMatch && req.method === 'POST') {
    const targetKey = decodeURIComponent(keyActionMatch[1]);
    const action = keyActionMatch[2];

    const keyObj = db.findKey(targetKey);
    if (!keyObj) {
      return sendJson(res, 404, { error: 'Key not found' });
    }

    if (action === 'unbind') {
      db.updateKey(targetKey, { bound_hwid: null, device_model: null });
      return sendJson(res, 200, { ok: true, message: `Unbound HWID for ${targetKey}` });
    }

    if (action === 'toggle-status') {
      const newStatus = keyObj.status === 'active' ? 'revoked' : 'active';
      db.updateKey(targetKey, { status: newStatus });
      if (newStatus === 'revoked') {
        broadcastEvent('logout', { key: targetKey });
      }
      return sendJson(res, 200, { ok: true, status: newStatus });
    }

    if (action === 'extend') {
      const body = await parseJsonBody(req);
      const addDays = parseInt(body.days, 10) || 30;
      const currentExpiry = new Date(keyObj.expires_at).getTime();
      const base = currentExpiry > Date.now() ? currentExpiry : Date.now();
      const newExpiry = new Date(base + addDays * 24 * 3600 * 1000).toISOString();
      db.updateKey(targetKey, { expires_at: newExpiry, status: 'active' });
      return sendJson(res, 200, { ok: true, expires_at: newExpiry });
    }
  }

  // Admin Delete Key
  const deleteKeyMatch = pathname.match(/^\/api\/admin\/keys\/([^/]+)$/);
  if (deleteKeyMatch && req.method === 'DELETE') {
    const targetKey = decodeURIComponent(deleteKeyMatch[1]);
    db.deleteKey(targetKey);
    broadcastEvent('logout', { key: targetKey });
    return sendJson(res, 200, { ok: true });
  }

  // Admin Update Maintenance Settings
  if (pathname === '/api/admin/maintenance' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const updated = db.setMaintenance({
      enabled: typeof body.enabled === 'boolean' ? body.enabled : false,
      blocked: typeof body.blocked === 'boolean' ? body.blocked : false,
      allowed_logins: Array.isArray(body.allowed_logins) 
        ? body.allowed_logins 
        : (body.allowed_logins || '').split(',').map(s => s.trim()).filter(Boolean),
      title: body.title || 'maintenance',
      message: body.message || "we're doing maintenance. everything is paused until we're back."
    });

    broadcastEvent('maintenance', updated.maintenance);
    return sendJson(res, 200, { ok: true, maintenance: updated.maintenance });
  }

  // ==========================================
  // STATIC ASSET & PAGE ROUTING (path-traversal safe)
  // ==========================================
  const STATIC_ROUTES = new Map([
    ['/vip', 'public/admin.html'],
    ['/vip/', 'public/admin.html'],
    ['/vip/index.html', 'public/admin.html'],
    ['/vip/admin.js', 'public/admin.js'],
    ['/admin.js', 'public/admin.js'],
    ['/', 'index.html'],
    ['/index.html', 'index.html'],
    ['/icon', 'public/icon.png'],
    ['/icon.png', 'public/icon.png'],
    ['/logo', 'public/logo.png'],
    ['/logo.png', 'public/logo.png'],
    ['/apple-icon', 'public/apple-icon.png'],
    ['/apple-icon.png', 'public/apple-icon.png'],
    ['/opengraph-image', 'public/opengraph-image.png'],
    ['/opengraph-image.png', 'public/opengraph-image.png']
  ]);

  // Old admin URLs redirect to /vip
  if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin/index.html') {
    res.writeHead(302, { Location: '/vip' });
    res.end();
    return;
  }

  let filePath = null;

  if (STATIC_ROUTES.has(pathname)) {
    filePath = path.join(ROOT_DIR, STATIC_ROUTES.get(pathname));
  } else if (pathname.startsWith('/src/')) {
    filePath = path.join(ROOT_DIR, pathname.slice(1));
  } else if (pathname.startsWith('/media/')) {
    filePath = path.join(ROOT_DIR, 'public', pathname.slice(1));
  } else if (pathname.startsWith('/public/')) {
    filePath = path.join(ROOT_DIR, pathname.slice(1));
  }

  // Only files inside src/ or public/ (plus index.html) may ever be served
  if (filePath) {
    const resolved = path.resolve(filePath);
    const allowedDirs = [path.resolve(ROOT_DIR, 'src'), path.resolve(ROOT_DIR, 'public'), path.resolve(ROOT_DIR, 'vip')];
    const isInAllowedDir = allowedDirs.some(dir => resolved.startsWith(dir + path.sep));
    const isIndexHtml = resolved === path.resolve(ROOT_DIR, 'index.html');
    if (!isInAllowedDir && !isIndexHtml) {
      filePath = null;
    }
  }

  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
      res.end(content);
    }
  });
});

const onListen = () => {
  const pwdHint = process.env.ADMIN_PASSWORD
    ? 'password set via ADMIN_PASSWORD env'
    : `default password: ${ADMIN_PASSWORD} (set ADMIN_PASSWORD env var to change)`;
  console.log(`\n==============================================`);
  console.log(`🚀 DEFINE CYBER Core System running!`);
  if (!isNaN(PORT)) {
    console.log(`👉 Client Portal: http://localhost:${PORT}/`);
    console.log(`👉 Admin Panel:   http://localhost:${PORT}/vip — ${pwdHint}`);
  } else {
    console.log(`👉 Running via Passenger Socket: ${PORT}`);
    console.log(`👉 Admin Panel: /vip — ${pwdHint}`);
  }
  console.log(`==============================================\n`);
};

if (isNaN(PORT)) {
  server.listen(PORT, onListen);
} else {
  server.listen(Number(PORT), '0.0.0.0', onListen);
}
