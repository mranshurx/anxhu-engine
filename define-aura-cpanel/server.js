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

// ---------------------------------------------------------------------------
// CLIENT KEYS: no hardcoded key anymore. Only keys created from the admin
// panel (stored in data/database.json) can log in. Unbound keys work on any
// device; only a key with an explicit bound_hwid is device-locked.
// ---------------------------------------------------------------------------
// Legacy key that used to be injected on every boot — remove it from existing DBs.
const LEGACY_HARDCODED_KEY = 'CYBER-ANXHU-COLLAB-AMIT';
if (db.findKey(LEGACY_HARDCODED_KEY)) {
  db.deleteKey(LEGACY_HARDCODED_KEY);
  console.log(`[keys] Removed legacy hardcoded client key (${LEGACY_HARDCODED_KEY})`);
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

function normalizeKeyStr(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// ADMIN AUTH: password is no longer hardcoded. It is fetched ONLINE from
// adminkey.txt in the GitHub repo and compared on each login. The result is
// cached briefly to avoid hammering GitHub; if GitHub is unreachable the last
// good value is reused, and an optional ADMIN_PASSWORD env var still works as
// an override.
// ---------------------------------------------------------------------------
const ADMIN_KEY_URL = 'https://raw.githubusercontent.com/mranshurx/anxhu-engine/refs/heads/main/adminkey.txt';
const ADMIN_KEY_TTL = 60 * 1000; // cache remote admin key for 60s
let adminKeyCache = { value: null, fetchedAt: 0 };

function fetchRemoteAdminKey() {
  return new Promise((resolve) => {
    const req = https.get(ADMIN_KEY_URL, {
      timeout: 6000,
      headers: { 'User-Agent': 'cyber-x-silent', 'Cache-Control': 'no-cache' }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data.trim()));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function getAdminKey() {
  const now = Date.now();
  if (adminKeyCache.value && (now - adminKeyCache.fetchedAt) < ADMIN_KEY_TTL) {
    return adminKeyCache.value;
  }
  const remote = await fetchRemoteAdminKey();
  if (remote) {
    adminKeyCache = { value: remote, fetchedAt: now };
    return remote;
  }
  // GitHub unreachable — fall back to the last known good value (may be null).
  return adminKeyCache.value;
}

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

// ---------------------------------------------------------------------------
// Full XRAY profile imported into HAPP on "Add to HAPP".
// Key-bound:  auth = the user's license key (proxy node validates it)
// Expiry-bound: expire is written into the subscription-userinfo header so
// HAPP itself stops the profile the moment the key expires.
// ---------------------------------------------------------------------------
const HAPP_ROUTING_RULES = [
  {
    type: 'field',
    domain: [
      'full:clientbp.ggpolarbear.com','full:loginbp.ggpolarbear.com',
      'full:core-bs.ggpolarbear.com','full:core-bs.freefiremobile.com',
      'full:core-tata.freefireind.in','full:core-gmc.freefiremobile.com',
      'full:client.ind.freefiremobile.com','full:client.us.freefiremobile.com',
      'full:sgnetwork.ggblueshark.com','full:menetwork.ggblueshark.com',
      'full:bdnetwork.ggpolarbear.com','full:100067.connect.garena.com',
      'full:100067.msdk.garena.com','full:clientbp.ppmainecoonghj.com',
      'full:loginbp.ppmainecoonghj.com','full:ffmconnect.ppmainecoonghj.com',
      'full:ffmmsdk.ppmainecoonghj.com',
      'regexp:^(clientbp|loginbp|core-[a-z0-9]+|[a-z]+network|ffmconnect|ffmmsdk)\\.'
    ],
    outboundTag: 'proxy'
  },
  {
    type: 'field',
    ip: [
      '0.0.0.0/24','101.32.114.0/23','101.33.44.0/22','102.204.191.0/24',
      '102.217.238.0/24','103.103.244.0/24','103.108.100.0/22','103.117.4.0/22',
      '103.123.54.0/23','103.127.228.0/22','103.16.32.0/22','103.215.127.0/24',
      '103.219.200.0/22','103.237.102.0/23','103.247.204.0/22','103.248.57.0/24',
      '103.248.58.0/23','103.52.145.0/24','103.60.16.0/22','103.62.54.0/24',
      '103.69.179.0/24','104.166.132.0/23','104.166.144.0/22','104.166.148.0/22',
      '104.166.175.0/24','104.166.185.0/24','104.166.191.0/24','107.151.141.0/24',
      '107.151.192.0/24','107.151.193.0/24','107.151.240.0/24','107.151.241.0/24',
      '107.151.242.0/24','124.108.136.0/22','124.108.140.0/23','124.108.149.0/24',
      '124.108.150.0/23','124.108.152.0/21','124.108.160.0/21','124.108.172.0/22',
      '124.108.191.0/24','124.156.200.0/22','124.156.204.0/22','124.158.133.0/24',
      '124.158.134.0/23','124.158.142.0/23','128.1.113.0/24','128.1.173.0/24',
      '128.1.189.0/24','128.1.200.0/24','128.1.63.0/24','128.14.102.0/23',
      '128.14.136.0/23','128.14.206.0/24','128.14.38.0/24','128.14.63.0/24',
      '128.14.89.0/24','129.226.144.0/24','129.226.200.0/22','129.226.220.0/22',
      '134.168.232.0/24','134.168.233.0/24','134.168.234.0/24','139.180.158.0/24',
      '143.92.112.0/23','143.92.116.0/23','143.92.118.0/24','143.92.120.0/21',
      '148.153.101.0/24','148.153.11.0/24','148.153.112.0/23','148.153.116.0/23',
      '148.153.143.0/24','148.153.168.0/22','148.153.206.0/23','148.153.222.0/24',
      '148.153.246.0/24','148.153.248.0/23','148.153.67.0/24','148.153.84.0/23',
      '148.153.92.0/23','148.222.64.0/20','148.222.80.0/22','148.222.84.0/23',
      '148.222.88.0/21','149.28.55.0/24','15.235.220.0/24','15.235.231.0/24',
      '15.235.233.0/24','150.109.24.0/22','150.129.42.0/24','152.233.63.0/24',
      '154.203.154.0/23','154.206.73.0/24','154.223.134.0/23','154.93.32.0/24',
      '154.93.46.0/24','154.93.86.0/24','154.95.68.0/24','154.95.81.0/24',
      '156.227.242.0/24','156.59.144.0/23','156.59.154.0/24','156.59.194.0/23',
      '156.59.242.0/23','156.59.251.0/24','156.59.64.0/22','156.59.70.0/23',
      '162.128.241.0/24','162.128.242.0/24','162.128.249.0/24','162.128.32.0/24',
      '162.128.54.0/24','162.128.61.0/24','162.128.80.0/24','162.128.82.0/24',
      '163.227.196.0/24','163.53.247.0/24','169.197.96.0/22','185.23.183.0/24',
      '192.169.117.0/24','192.169.124.0/23','193.118.34.0/23','194.26.72.0/24',
      '198.44.169.0/24','199.182.238.0/24','202.181.64.0/23','202.181.67.0/24',
      '202.181.68.0/24','202.181.70.0/23','202.181.72.0/21','202.181.80.0/21',
      '202.73.16.0/21','202.81.100.0/23','202.81.104.0/21','202.81.112.0/20',
      '202.81.96.0/22','204.3.212.0/24','207.148.69.0/24','210.17.80.0/24',
      '23.236.112.0/23','23.251.37.0/24','23.251.41.0/24','23.251.51.0/24',
      '23.251.61.0/24','23.90.133.0/24','23.90.134.0/24','23.90.141.0/24',
      '34.126.122.0/24','34.126.175.0/24','34.126.239.0/24','34.126.81.0/24',
      '34.87.109.0/24','34.87.170.0/24','34.87.24.0/24','35.185.188.0/24',
      '35.187.246.0/24','35.198.211.0/24','35.198.221.0/24','38.54.120.0/24',
      '38.54.21.0/24','38.54.44.0/23','38.54.70.0/24','38.54.78.0/23',
      '43.128.121.0/24','43.129.35.0/24','43.129.43.0/24','43.133.146.0/24',
      '43.133.150.0/24','43.133.153.0/24','43.133.154.0/24','43.133.40.0/24',
      '43.133.41.0/24','43.134.101.0/24','43.134.103.0/24','43.134.118.0/24',
      '43.134.168.0/24','43.134.170.0/24','43.134.182.0/24','43.134.232.0/24',
      '43.134.233.0/24','43.134.241.0/24','43.134.28.0/24','43.134.45.0/24',
      '43.134.64.0/24','43.134.90.0/24','43.134.94.0/24','43.152.104.0/24',
      '43.152.105.0/24','43.153.208.0/24','43.153.209.0/24','43.153.215.0/24',
      '43.156.134.0/24','43.156.14.0/24','43.156.141.0/24','43.156.151.0/24',
      '43.156.167.0/24','43.156.177.0/24','43.156.199.0/24','43.156.200.0/24',
      '43.156.203.0/24','43.156.205.0/24','43.156.209.0/24','43.156.26.0/24',
      '43.156.31.0/24','43.156.40.0/24','43.156.7.0/24','43.157.195.0/24',
      '43.157.197.0/24','43.157.200.0/24','43.157.204.0/24','43.157.206.0/24',
      '43.157.208.0/24','43.157.209.0/24','43.157.210.0/24','43.157.211.0/24',
      '43.157.224.0/24','43.157.227.0/24','43.157.228.0/24','43.157.230.0/24',
      '43.157.242.0/24','43.157.250.0/24','43.157.251.0/24','43.163.105.0/24',
      '43.163.108.0/24','43.163.119.0/24','43.163.126.0/24','43.163.88.0/24',
      '43.163.96.0/24','43.173.0.0/23','43.173.170.0/24','43.173.171.0/24',
      '43.173.2.0/23','43.173.29.0/24','43.252.184.0/22','43.252.210.0/24',
      '45.119.216.0/22','45.119.240.0/22','45.121.212.0/24','45.251.28.0/22',
      '59.153.158.0/24','60.199.50.0/24','66.253.15.0/24','78.105.206.0/24',
      '82.200.131.0/24','98.96.251.0/24','98.98.12.0/22','98.98.140.0/23',
      '98.98.162.0/24','98.98.189.0/24','98.98.220.0/23','98.98.29.0/24',
      '98.98.32.0/24','98.98.33.0/24','98.98.34.0/24'
    ],
    outboundTag: 'proxy'
  },
  { type: 'field', network: 'tcp', port: '39000-39999', outboundTag: 'proxy' },
  { type: 'field', network: 'udp', port: '10000-10999', outboundTag: 'proxy' },
  {
    type: 'field',
    domain: [
      'full:event-vodka.freefireind.in','full:indevent.ggblueshark.com',
      'full:sgevent.ggblueshark.com','full:meevent.ggblueshark.com',
      'full:thevent.ggblueshark.com','full:sacevent.ggblueshark.com',
      'full:idevent.ggblueshark.com','full:bdevent.ggpolarbear.com',
      'regexp:event\\.gg(blueshark|polarbear)\\.com$',
      'full:gin.freefireind.in','full:gin.freefiremobile.com',
      'full:vodka.freefireind.in','full:dl.castle.freefiremobile.com',
      'full:dl.cdn.freefiremobile.com','full:dl-core.cdn.freefiremobile.com',
      'full:dl.gmc.freefiremobile.com','full:dl.aw.freefiremobile.com',
      'full:dl.dir.freefiremobile.com','full:dl.bs.freefiremobile.com',
      'full:dl.ak.freefiremobile.com','full:dl-sg-production.freefiremobile.com',
      'full:dl-tata.freefireind.in','full:dl-bs.ggpolarbear.com',
      'domain:freefiremobile-a.akamaihd.net',
      'full:client.nulldash.store','full:client.aimhack.shop',
      'full:client.xreg.site','full:client.trollmodz.store',
      'full:client.silentx.store','full:client.zentnityx.store',
      'full:client.ruizenteam.store'
    ],
    outboundTag: 'direct'
  },
  { type: 'field', network: 'tcp,udp', outboundTag: 'direct' }
];

function buildFullHappConfig(key) {
  const dbState = db.get();
  const keyRecord = db.findKey(key);
  const nodes = [...(dbState.nodes || [])].sort((a, b) => (a.ping || 999) - (b.ping || 999));
  const primary = nodes[0] || { host: 'sg1.nulldash.store', port: 443 };
  const chunk = String(key || '').replace(/[^A-Z0-9]/g, '').slice(-4) || '0000';

  return [{
    remarks: `CYBER-${chunk}`,
    inbounds: [
      {
        tag: 'socks', listen: '127.0.0.1', port: 10808, protocol: 'socks',
        settings: { auth: 'noauth', udp: true },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false }
      },
      {
        tag: 'http', listen: '127.0.0.1', port: 10809, protocol: 'http',
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false }
      }
    ],
    outbounds: [
      {
        tag: 'proxy',
        protocol: 'hysteria',
        settings: { address: primary.host, port: primary.port, version: 2 },
        streamSettings: {
          network: 'hysteria',
          security: 'tls',
          tlsSettings: { serverName: primary.host, alpn: ['h3'] },
          hysteriaSettings: { version: 2, auth: key }
        }
      },
      { tag: 'direct', protocol: 'freedom' }
    ],
    routing: { domainStrategy: 'AsIs', rules: HAPP_ROUTING_RULES },
    meta: {
      client: 'CYBER X SILENT',
      key,
      expires: (keyRecord && keyRecord.expires_at) || null,
      active_features: dbState.global_features
    }
  }];
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
      const cleanKey = normalizeKeyStr(key);
      const isAllowed = maintenance.allowed_logins.some(
        item => normalizeKeyStr(item) === cleanKey
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

    // Check Key in Database (admin-generated keys only)
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

  // HAPP subscription feed — serves the full XRAY profile + expire header
  if (pathname === '/api/happ/sub' && req.method === 'GET') {
    const key = (parsedUrl.searchParams.get('key') || '').trim();
    const keyRecord = key ? db.findKey(key) : null;

    if (keyRecord && keyRecord.status === 'revoked') {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(buildFullHappConfig(key)));
      return;
    }

    const expiresAt = (keyRecord && keyRecord.expires_at)
      ? new Date(keyRecord.expires_at)
      : new Date(Date.now() + 7 * 86400000);
    const expireUnix = Math.floor(expiresAt.getTime() / 1000);
    const totalBytes = 69 * 1024 * 1024 * 1024;

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'profile-title': 'CYBER X SILENT',
      'profile-update-interval': '1',
      'subscription-userinfo': `upload=0; download=0; total=${totalBytes}; expire=${expireUnix}`
    });
    res.end(JSON.stringify(buildFullHappConfig(key)));
    return;
  }

  // Happ one-tap: wrap our key-scoped subscription URL into a happ://crypt5 link
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

    const keyRecord = db.findKey(key);
    return sendJson(res, 200, {
      ok: true,
      href: 'https://apps.apple.com/us/app/happ-proxy-utility/id6504287215',
      subUrl: subUrl,
      deepLink: deepLink,
      cryptoError: cryptoError,
      expires_at: (keyRecord && keyRecord.expires_at) || null,
      config: buildFullHappConfig(key)
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
    const configData = buildFullHappConfig(key);
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

      // Primary source of truth: adminkey.txt pulled live from GitHub.
      // Optional ADMIN_PASSWORD env var still works as an override.
      let isMatch = false;
      let remoteOk = false;
      try {
        const expected = await getAdminKey();
        if (expected) {
          remoteOk = true;
          isMatch = givenPassword === expected;
        }
      } catch (e) { /* ignore, handled below */ }

      if (!isMatch && process.env.ADMIN_PASSWORD && givenPassword === process.env.ADMIN_PASSWORD) {
        isMatch = true;
      }

      if (!isMatch) {
        rec.fails += 1;
        adminLoginAttempts.set(ip, rec);
        return sendJson(res, 401, {
          error: remoteOk
            ? 'wrong admin password'
            : 'wrong admin password (could not load adminkey.txt)'
        });
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
  console.log(`\n==============================================`);
  console.log(`🚀 DEFINE CYBER Core System running!`);
  console.log(`🔑 Admin password = contents of adminkey.txt on GitHub`);
  if (process.env.ADMIN_PASSWORD) console.log(`   (ADMIN_PASSWORD env override is set)`);
  if (!isNaN(PORT)) {
    console.log(`👉 Client Portal: http://localhost:${PORT}/`);
    console.log(`👉 Admin Panel:   http://localhost:${PORT}/vip`);
  } else {
    console.log(`👉 Running via Passenger Socket: ${PORT}`);
    console.log(`👉 Admin Panel: /vip`);
  }
  console.log(`==============================================\n`);
};

if (isNaN(PORT)) {
  server.listen(PORT, onListen);
} else {
  server.listen(Number(PORT), '0.0.0.0', onListen);
}
