import { CONFIG } from './config.js';
import { TRANSLATIONS } from './translations.js';
import { Icons } from './icons.js';

// State Store
const state = {
  lang: localStorage.getItem('aura_lang') || localStorage.getItem('pmm_lang') || 'en',
  isLangOpen: false,
  tab: 'status', // 'status' | 'features' | 'manage'
  manageSubView: 'list', // 'list' | 'notes' | 'guide'
  auth: {
    loggedIn: false,
    key: '',
    me: {
      status: 'active',
      bound_hwid: null,
      device_model: null,
      device_os: null,
      expires_at: null,
      features: JSON.parse(JSON.stringify(CONFIG.DEFAULT_FEATURES))
    }
  },
  keyInput: '',
  loading: false,
  error: null,
  maintenance: {
    enabled: false,
    blocked: false,
    title: 'maintenance',
    message: "we're doing maintenance. everything is paused until we're back."
  },
  happLoading: false,
  happError: null,
  timerInterval: null
};

// Check local storage session
const savedSession = localStorage.getItem('aura_session') || localStorage.getItem('pmm_session');
if (savedSession) {
  try {
    const parsed = JSON.parse(savedSession);
    if (parsed.key) {
      state.auth.loggedIn = true;
      state.auth.key = parsed.key;
      if (parsed.me) state.auth.me = { ...state.auth.me, ...parsed.me };
      if (parsed.features) state.auth.me.features = { ...state.auth.me.features, ...parsed.features };
    }
  } catch (e) {}
}

// Translation helper
function t(key) {
  const dict = TRANSLATIONS[state.lang] || TRANSLATIONS.en;
  return dict[key] || TRANSLATIONS.en[key] || key;
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Strip GPU/driver junk from stored device names (old DB records)
function cleanDeviceName(model) {
  let s = String(model == null ? '' : model).trim();
  if (!s) return '';
  if (/Direct3D|D3D1[12]|Basic Render Driver|ANGLE|OpenGL|Vulkan|\(0x[0-9A-Fa-f]{8}/i.test(s)) {
    s = s.split('(')[0].trim();
  }
  return s;
}

// Real Hardware Fingerprinting & Actual Device Identification
async function getRealClientDevice() {
  const ua = navigator.userAgent || '';
  let os = 'Unknown OS';
  let deviceName = 'Unknown Device';

  // 1. Detect Real OS
  if (/Windows NT 10.0/i.test(ua)) os = 'Windows 10/11';
  else if (/Windows NT 6.3/i.test(ua)) os = 'Windows 8.1';
  else if (/Windows NT 6.1/i.test(ua)) os = 'Windows 7';
  else if (/iPhone/i.test(ua)) {
    const m = ua.match(/OS (\d+[_\.]\d+)/);
    os = m ? `iOS ${m[1].replace('_', '.')}` : 'iOS';
  } else if (/iPad/i.test(ua)) {
    const m = ua.match(/OS (\d+[_\.]\d+)/);
    os = m ? `iPadOS ${m[1].replace('_', '.')}` : 'iPadOS';
  } else if (/Macintosh|Mac OS X/i.test(ua)) {
    const m = ua.match(/Mac OS X (\d+[_\.]\d+)/);
    os = m ? `macOS ${m[1].replace('_', '.')}` : 'macOS';
  } else if (/Android/i.test(ua)) {
    const m = ua.match(/Android (\d+(\.\d+)?)/);
    os = m ? `Android ${m[1]}` : 'Android';
  } else if (/Linux/i.test(ua)) os = 'Linux';

  // 2. Detect Real Hardware GPU via WebGL
  let gpuRenderer = '';
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        const raw = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '';
        const match = raw.match(/(NVIDIA\s+[^,)]+|AMD\s+[^,)]+|Intel\s+[^,)]+|Apple\s+[^,)]+|Mali-[^,)]+|Adreno\s+[^,)]+)/i);
        gpuRenderer = match ? match[1].trim() : raw.replace(/ANGLE \(|, Direct3D.*|\)/g, '').trim();
      }
    }
  } catch (e) {}

  // 3. Format Real Device Model Name (clean display; GPU stays in HWID metrics only)
  if (/iPhone/i.test(ua)) {
    const w = screen.width * (window.devicePixelRatio || 1);
    const h = screen.height * (window.devicePixelRatio || 1);
    if ((w === 1290 && h === 2796) || (w === 2796 && h === 1290)) deviceName = 'iPhone 15/16 Pro Max';
    else if ((w === 1179 && h === 2556) || (w === 2556 && h === 1179)) deviceName = 'iPhone 15/16 Pro';
    else if ((w === 1284 && h === 2778) || (w === 2778 && h === 1284)) deviceName = 'iPhone 13/14 Pro Max';
    else if ((w === 1170 && h === 2532) || (w === 2532 && h === 1170)) deviceName = 'iPhone 12/13/14';
    else deviceName = 'iPhone';
  } else if (/iPad/i.test(ua)) {
    deviceName = 'iPad';
  } else if (/Android/i.test(ua)) {
    const modelMatch = ua.match(/;\s*([A-Za-z0-9\-\s\_]+)\s+Build\//);
    deviceName = modelMatch ? modelMatch[1].trim() : 'Android Device';
  } else if (/Macintosh/i.test(ua)) {
    deviceName = 'Mac';
  } else if (/Windows/i.test(ua)) {
    deviceName = 'Windows PC';
  } else {
    deviceName = `${os} Desktop`;
  }

  // 4. Generate Stable Hardware ID (HWID)
  let hwid = localStorage.getItem('aura_hwid') || localStorage.getItem('pmm_hwid');
  if (!hwid) {
    const metrics = [
      navigator.platform || '',
      navigator.hardwareConcurrency || 4,
      navigator.deviceMemory || 8,
      `${screen.width}x${screen.height}x${screen.colorDepth}`,
      new Date().getTimezoneOffset(),
      gpuRenderer
    ];

    try {
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = 40;
      const ctx = c.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = "14px 'Arial'";
      ctx.fillStyle = '#ff2a44';
      ctx.fillRect(100, 1, 50, 18);
      ctx.fillStyle = '#ffffff';
      ctx.fillText('CYBER-HWID', 2, 12);
      metrics.push(c.toDataURL());
    } catch (e) {}

    const seed = metrics.join('###');
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = ((h << 5) - h) + seed.charCodeAt(i);
      h |= 0;
    }
    const chunk1 = Math.abs(h).toString(16).padStart(8, '0').slice(0, 4).toUpperCase();
    const chunk2 = Math.abs(h ^ 0x5a5a5a5a).toString(16).padStart(8, '0').slice(0, 4).toUpperCase();
    const chunk3 = Math.abs(h ^ 0xa5a5a5a5).toString(16).padStart(8, '0').slice(0, 4).toUpperCase();
    hwid = `CYBER-${chunk1}-${chunk2}-${chunk3}`;
    localStorage.setItem('aura_hwid', hwid);
  }

  return { hwid, device_model: deviceName, device_os: os };
}

// Smart access key formatter supporting CYBER, DEFINE, PMM, etc.
function formatKey(val) {
  const upper = String(val || '').trim().toUpperCase();
  // No special/test login shortcuts: only generated license-key formats are accepted.
  const raw = upper.replace(/[^A-Z0-9]/g, '');
  if (!raw) return '';
  let pfxLen = 4;
  if (raw.startsWith('DEFINE')) pfxLen = 6;
  else if (raw.startsWith('PMM')) pfxLen = 3;
  else if (raw.startsWith('CYBER')) pfxLen = 5;
  else if (raw.length <= 3) return raw;

  if (raw.length <= pfxLen) return raw;
  const prefix = raw.slice(0, pfxLen);
  const rest = raw.slice(pfxLen, pfxLen + 12);
  const chunks = [prefix];
  for (let i = 0; i < rest.length; i += 4) {
    chunks.push(rest.slice(i, i + 4));
  }
  return chunks.join('-');
}

// Countdown formatter
function formatCountdown(targetIso) {
  if (!targetIso) return '—';
  const diff = new Date(targetIso).getTime() - Date.now();
  if (diff <= 0) return '<span class="font-semibold text-accent-bad">expired</span>';
  const sec = Math.floor(diff / 1000);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const secs = sec % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m ${secs}s`;
}

// Fetch live maintenance status from server
async function checkMaintenance() {
  try {
    const res = await fetch('/api/maintenance');
    if (res.ok) {
      const data = await res.json();
      state.maintenance = data;
      render();
    }
  } catch (e) {}
}

// Listen to real-time events via SSE
function initSSE() {
  try {
    const es = new EventSource('/api/events');
    es.addEventListener('maintenance', (e) => {
      try {
        state.maintenance = JSON.parse(e.data);
        render();
      } catch (err) {}
    });
    es.addEventListener('logout', (e) => {
      try {
        const d = JSON.parse(e.data);
        if (!d.key || d.key === state.auth.key) {
          logout();
        }
      } catch (err) {}
    });
  } catch (e) {}
}

// Main Render Function
function render() {
  const root = document.getElementById('app');
  if (!root) return;

  const isRtl = state.lang === 'ar';
  document.documentElement.setAttribute('lang', state.lang);
  document.documentElement.setAttribute('dir', isRtl ? 'rtl' : 'ltr');
  document.title = 'DEFINE CYBER';

  let html = '';

  // Background ambient drift glow (Red Aura Theme)
  html += `
    <div aria-hidden="true" class="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-background">
      <div class="animate-drift-a absolute left-1/2 top-[-14%] h-[560px] w-[560px] -translate-x-1/2 rounded-full bg-[#ff2a44]/[0.09] blur-[130px]"></div>
      <div class="animate-drift-b absolute bottom-[-18%] right-[-12%] h-[480px] w-[480px] rounded-full bg-[#ff2a44]/[0.06] blur-[120px]"></div>
    </div>
  `;

  // Top Maintenance Banner (Only displays when maintenance is active on the backend)
  if (state.maintenance && state.maintenance.enabled) {
    html += `
      <div class="fixed inset-x-0 top-0 z-50 flex items-start justify-center gap-2 bg-[#fbbf24]/15 px-4 py-2.5 text-center text-[11px] text-[#fbbf24] backdrop-blur">
        ${Icons.wrench(13, 'mt-px shrink-0')}
        <span>
          <span class="font-bold uppercase tracking-[0.15em]">${t('maintenance_title')}</span> · 
          ${state.maintenance.message || t('maintenance_body')} 
          ${t('maintenance_login_hint')}
        </span>
      </div>
    `;
  }

  // Render KeyGate or Dashboard
  if (!state.auth.loggedIn) {
    html += renderKeyGate();
  } else {
    html += renderDashboard();
  }

  root.innerHTML = html;
  attachEvents();
}

// Pure & Authentic KeyGate View (1:1 with client.nulldash.store)
function renderKeyGate() {
  return `
    <main class="relative flex min-h-dvh flex-col items-center justify-center px-6">
      <div class="pointer-events-none absolute h-72 w-72 rounded-full bg-[#ff2a44]/[0.15] blur-3xl"></div>
      
      <div class="glass key-card flex w-full flex-col items-center gap-4 p-5 animate-rise">
        <img src="/logo.png" alt="${CONFIG.BRAND_WORDMARK}" class="key-logo" />
        <p class="label -mt-4">access key</p>
        
        <form id="key-form" class="flex w-full flex-col gap-3">
          <input 
            id="key-input"
            type="text"
            placeholder="${CONFIG.KEY_PLACEHOLDER}" 
            spellcheck="false" 
            autocomplete="off" 
            autofocus 
            class="input text-center tracking-[0.1em] ${state.error ? 'border-accent-bad' : ''}" 
            value="${state.keyInput}"
          />
          
          ${state.error ? `<p class="text-center text-xs text-accent-bad animate-rise">${state.error}</p>` : ''}
          
          <button type="submit" class="btn w-full uppercase tracking-[0.15em]" ${state.loading ? 'disabled' : ''}>
            ${state.loading ? `${Icons.loader2(16)} authenticating...` : 'unlock'}
          </button>
        </form>
      </div>
      
      <p class="mt-6 text-center text-[11px] text-line-2">no key? contact your seller.</p>
    </main>
  `;
}

// Pure & Authentic Dashboard View
function renderDashboard() {
  const me = state.auth.me;

  return `
    <main class="relative mx-auto flex min-h-dvh max-w-md flex-col px-5 pb-32 pt-6">
      
      <!-- Header with Status and Language Dropdown -->
      <div class="flex items-center justify-between gap-3 px-1 py-4">
        <div class="flex min-w-0 items-center gap-2 text-sm font-bold uppercase tracking-[0.2em] text-foreground">
          ${state.tab === 'manage'
            ? escHtml(t('manage_title'))
            : state.tab === 'features'
              ? escHtml(t('features_title'))
              : `<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-ok"></span> ${me.status}`}
        </div>
        
        <div class="relative shrink-0">
          <button id="lang-btn" aria-label="language" class="glass flex h-9 w-9 items-center justify-center rounded-full transition-colors ${state.isLangOpen ? 'text-foreground' : 'text-dim'}">
            ${state.tab === 'manage' ? Icons.user(18) : Icons.languages(16)}
          </button>
          
          ${state.isLangOpen ? renderLangDropdown() : ''}
        </div>
      </div>

      <!-- Tab Content Area -->
      <div class="flex flex-1 flex-col animate-rise">
        ${state.tab === 'status' ? renderStatusTab(me) : ''}
        ${state.tab === 'features' ? renderFeaturesTab(me) : ''}
        ${state.tab === 'manage' ? renderManageTab() : ''}
      </div>

    </main>

    <!-- Floating Bottom Glass Navigation -->
    ${renderBottomNav()}
  `;
}

// Language Dropdown
function renderLangDropdown() {
  const languages = [
    { code: 'ar', name: 'العربية' },
    { code: 'en', name: 'English' },
    { code: 'th', name: 'ไทย' }
  ];

  return `
    <div id="lang-overlay" class="fixed inset-0 z-40 cursor-default"></div>
    <div class="absolute right-0 top-11 z-50 flex min-w-[156px] flex-col overflow-hidden rounded-[14px] border border-line-2 bg-[#101013] p-1 shadow-[0_16px_44px_rgba(0,0,0,0.75)] animate-rise">
      ${languages.map(l => {
        const isSel = l.code === state.lang;
        return `
          <button 
            data-lang="${l.code}" 
            class="lang-select-btn flex items-center justify-between gap-3 rounded-[10px] px-3 py-2.5 text-left text-sm font-semibold transition-colors ${isSel ? 'bg-white/[0.07] text-foreground' : 'text-dim hover:bg-white/[0.04]'}"
          >
            <span>${l.name}</span>
            ${isSel ? Icons.check(14, 'text-[var(--color-accent)]') : ''}
          </button>
        `;
      }).join('')}
    </div>
  `;
}

// Status Tab View
function renderStatusTab(me) {
  const expiresCountdown = formatCountdown(me.expires_at);

  return `
    <div class="flex flex-1 flex-col items-center justify-between gap-8 py-4">
      <div class="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <div class="relative py-4 hero-glow">
          <img src="/logo.png" alt="${CONFIG.BRAND_WORDMARK}" class="hero-logo animate-rise" />
        </div>

        <div class="mt-2 flex flex-col gap-3">
          <p class="break-all text-xs uppercase tracking-[0.15em] text-dim">
            ${t('status_hwid')} <span class="font-bold text-foreground">${escHtml(me.bound_hwid) || t('status_hwid_unbound')}</span>
          </p>
          <p class="text-xs uppercase tracking-[0.15em] text-dim">
            ${t('status_device')} <span class="font-bold text-foreground">${escHtml(cleanDeviceName(me.device_model)) || t('status_device_unbound')}</span>
          </p>
          <p class="text-xs uppercase tracking-[0.15em] text-dim">
            ${t('status_expires')} <span id="countdown-display" class="font-bold text-foreground font-mono">${expiresCountdown}</span>
          </p>
        </div>
      </div>

      <div class="w-full">
        <button id="happ-btn" class="btn w-full uppercase tracking-[0.15em]" ${state.happLoading ? 'disabled' : ''}>
          ${state.happLoading ? `${Icons.loader2(16)} Connecting...` : `${Icons.arrowUpRight(15)} ${t('add_to_happ')}`}
        </button>
        ${state.happError ? `<p class="mt-2 text-center text-[11px] text-accent-bad">${state.happError}</p>` : ''}
      </div>
    </div>
  `;
}

// Features Tab View
function renderFeaturesTab(me) {
  const f = me.features;
  const marker = f.marker || { enabled: true, type: 'Define Aura' };
  const aimpoint = f.aimpoint || { enabled: false };
  const aimLag = f.aimLag || { enabled: false, onFire: false, onScope: false };
  const gloo = f.gloo || { enabled: false, yawDeg: 180 };
  const fastRevive = f.fastRevive || { enabled: false };

  const glooPct = ((gloo.yawDeg - -180) / 360) * 100;
  const sliderBg = `linear-gradient(90deg, var(--color-accent) ${glooPct}%, var(--color-line-2) ${glooPct}%)`;
  const selType = CONFIG.MARKER_TYPES.includes(marker.type) ? marker.type : CONFIG.MARKER_TYPES[0];

  return `
    <div class="flex flex-col gap-4">

      <!-- Marker Card -->
      <div class="card p-5">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-dim">
            ${Icons.mapPin(14)} marker type
          </div>
          <button type="button" role="switch" data-toggle="marker" class="toggle-switch relative h-6 w-11 shrink-0 rounded-full transition-all ${marker.enabled ? 'toggle-on' : 'toggle-off'}">
            <span class="absolute top-0.5 h-5 w-5 rounded-full transition-all ${marker.enabled ? 'toggle-knob-on' : 'toggle-knob-off'}"></span>
          </button>
        </div>
        <p class="feat-desc">${t('d_marker')}</p>
        
        <div class="mt-4 flex flex-wrap gap-2 transition-opacity ${marker.enabled ? 'opacity-100' : 'opacity-35 pointer-events-none'}">
          ${CONFIG.MARKER_TYPES.map(type => {
            const isSel = selType === type;
            return `
              <button 
                data-marker-type="${type}"
                class="marker-chip-btn relative rounded-xl px-3 py-2 text-xs transition-colors ${isSel ? 'marker-chip-on' : 'marker-chip-off'}"
              >
                ${type}
              </button>
            `;
          }).join('')}
        </div>
      </div>

      <!-- Aimpoint Card -->
      <div class="card p-5">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-dim">
            ${Icons.crosshair(14)} aimpoint
          </div>
          <button type="button" role="switch" data-toggle="aimpoint" class="toggle-switch relative h-6 w-11 shrink-0 rounded-full transition-all ${aimpoint.enabled ? 'toggle-on' : 'toggle-off'}">
            <span class="absolute top-0.5 h-5 w-5 rounded-full transition-all ${aimpoint.enabled ? 'toggle-knob-on' : 'toggle-knob-off'}"></span>
          </button>
        </div>
        <p class="feat-desc">${t('d_aimpoint')}</p>
      </div>

      <!-- Aim Lag Card -->
      <div class="card p-5">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-dim">
            ${Icons.pause(14)} aim lag
          </div>
          <button type="button" role="switch" data-toggle="aimLag" class="toggle-switch relative h-6 w-11 shrink-0 rounded-full transition-all ${aimLag.enabled ? 'toggle-on' : 'toggle-off'}">
            <span class="absolute top-0.5 h-5 w-5 rounded-full transition-all ${aimLag.enabled ? 'toggle-knob-on' : 'toggle-knob-off'}"></span>
          </button>
        </div>
        <p class="feat-desc">${t('d_aimlag')}</p>
        
        <div class="mt-4 flex flex-col gap-2">
          <div class="flex items-center justify-between rounded-2xl border border-line-2 px-4 py-2.5">
            <span class="text-xs ${aimLag.enabled ? 'text-dim' : 'text-mut'}">when firing</span>
            <button type="button" role="switch" data-toggle="aimLag.onFire" ${!aimLag.enabled ? 'disabled' : ''} class="toggle-switch relative h-6 w-11 shrink-0 rounded-full transition-all disabled:opacity-40 ${aimLag.onFire && aimLag.enabled ? 'toggle-on' : 'toggle-off'}">
              <span class="absolute top-0.5 h-5 w-5 rounded-full transition-all ${aimLag.onFire && aimLag.enabled ? 'toggle-knob-on' : 'toggle-knob-off'}"></span>
            </button>
          </div>
          <div class="flex items-center justify-between rounded-2xl border border-line-2 px-4 py-2.5">
            <span class="text-xs ${aimLag.enabled ? 'text-dim' : 'text-mut'}">when scoping</span>
            <button type="button" role="switch" data-toggle="aimLag.onScope" ${!aimLag.enabled ? 'disabled' : ''} class="toggle-switch relative h-6 w-11 shrink-0 rounded-full transition-all disabled:opacity-40 ${aimLag.onScope && aimLag.enabled ? 'toggle-on' : 'toggle-off'}">
              <span class="absolute top-0.5 h-5 w-5 rounded-full transition-all ${aimLag.onScope && aimLag.enabled ? 'toggle-knob-on' : 'toggle-knob-off'}"></span>
            </button>
          </div>
        </div>
      </div>

      <!-- Gloo Rotation Card -->
      <div class="card p-5">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-dim">
            ${Icons.rotateCw(14)} gloo rotation
          </div>
          <button type="button" role="switch" data-toggle="gloo" class="toggle-switch relative h-6 w-11 shrink-0 rounded-full transition-all ${gloo.enabled ? 'toggle-on' : 'toggle-off'}">
            <span class="absolute top-0.5 h-5 w-5 rounded-full transition-all ${gloo.enabled ? 'toggle-knob-on' : 'toggle-knob-off'}"></span>
          </button>
        </div>
        <p class="feat-desc">${t('d_gloo')}</p>
        
        <div class="mt-4 ${gloo.enabled ? 'opacity-100' : 'opacity-35 pointer-events-none'}">
          <div class="flex items-baseline justify-between gap-3">
            <span class="label">rotation</span>
            <span id="gloo-deg-val" class="text-sm font-semibold tabular-nums text-foreground font-mono">
              ${gloo.yawDeg > 0 ? `+${gloo.yawDeg}°` : `${gloo.yawDeg}°`}
            </span>
          </div>
          <input 
            id="gloo-slider"
            type="range" 
            min="-180" 
            max="180" 
            step="5" 
            value="${gloo.yawDeg}" 
            ${!gloo.enabled ? 'disabled' : ''}
            class="slider mt-3"
            style="background: ${sliderBg}"
          />
        </div>
      </div>

      <!-- Fast Revive Card -->
      <div class="card p-5">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-dim">
            ${Icons.heartPulse(14)} fast revive
          </div>
          <button type="button" role="switch" data-toggle="fastRevive" class="toggle-switch relative h-6 w-11 shrink-0 rounded-full transition-all ${fastRevive.enabled ? 'toggle-on' : 'toggle-off'}">
            <span class="absolute top-0.5 h-5 w-5 rounded-full transition-all ${fastRevive.enabled ? 'toggle-knob-on' : 'toggle-knob-off'}"></span>
          </button>
        </div>
        <p class="feat-desc">${t('d_revive')}</p>
      </div>

    </div>
  `;
}

// Manage Tab View
function renderManageTab() {
  if (state.manageSubView === 'notes') {
    return renderUpdateNotes();
  }
  if (state.manageSubView === 'guide') {
    return renderSetupGuide();
  }

  const latestNote = CONFIG.UPDATE_NOTES[0];

  return `
    <div class="flex flex-1 flex-col gap-3">

      <!-- Update notes preview -->
      <button id="view-notes-btn" class="w-full text-left">
        <div class="card relative p-4 pr-10 transition-colors hover:border-foreground/30">
          <div class="text-sm font-bold text-foreground">${t('update_notes')}</div>
          <p class="mt-1.5 line-clamp-3 text-xs leading-relaxed text-dim">
            <span class="text-foreground">${latestNote.version}</span> — ${latestNote.title} — ${latestNote.body}
          </p>
          <span class="absolute right-4 top-1/2 -translate-y-1/2 text-line-2">
            ${Icons.chevronRight(16)}
          </span>
        </div>
      </button>

      <!-- Setup guide card -->
      <button id="view-guide-btn" class="w-full text-left">
        <div class="card flex items-center justify-between p-4 transition-colors hover:border-foreground/30">
          <div class="flex items-center gap-3">
            <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-dim">
              ${Icons.bookOpen(16)}
            </div>
            <span class="text-sm text-foreground">${t('setup_guide')}</span>
          </div>
          ${Icons.chevronRight(16, 'shrink-0 text-line-2')}
        </div>
      </button>

      <!-- WhatsApp community -->
      <a href="${CONFIG.SOCIAL_WHATSAPP_URL}" target="_blank" rel="noopener noreferrer" class="w-full text-left">
        <div class="card flex items-center justify-between p-4 transition-colors hover:border-foreground/30">
          <div class="flex items-center gap-3">
            <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-dim">
              ${Icons.whatsapp(16)}
            </div>
            <span class="text-sm text-foreground">${t('whatsapp')}</span>
          </div>
          ${Icons.chevronRight(16, 'shrink-0 text-line-2')}
        </div>
      </a>

      <!-- Log out -->
      <div class="mt-auto pt-6">
        <button id="logout-btn" class="w-full text-left">
          <div class="card flex items-center justify-between p-4 transition-colors border-accent-bad/25 hover:border-accent-bad/50">
            <div class="flex items-center gap-3">
              <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-bad/10 text-accent-bad">
                ${Icons.logOut(16)}
              </div>
              <span class="text-sm text-foreground">${t('log_out')}</span>
            </div>
            ${Icons.chevronRight(16, 'shrink-0 text-line-2')}
          </div>
        </button>
      </div>
    </div>
  `;
}

// Update Notes View
function renderUpdateNotes() {
  return `
    <div class="flex flex-col gap-4">
      <button id="back-to-manage-btn" class="flex items-center gap-1 self-start px-1 text-sm font-bold uppercase tracking-[0.2em] text-foreground">
        ${Icons.chevronLeft(16)} ${t('manage_title')}
      </button>

      <div class="px-1 text-sm font-bold uppercase tracking-[0.2em] text-foreground">
        ${t('update_notes')}
      </div>

      <div class="flex flex-col gap-3">
        ${CONFIG.UPDATE_NOTES.map(note => `
          <div class="card p-4">
            <div class="text-xs font-semibold uppercase tracking-[0.1em] text-foreground">
              ${note.version} — ${note.title}
            </div>
            <p class="mt-2 text-sm leading-relaxed text-dim">${note.body}</p>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// Setup Guide View
function renderSetupGuide() {
  return `
    <div class="flex flex-col gap-4">
      <button id="back-to-manage-btn" class="flex items-center gap-1 self-start px-1 text-sm font-bold uppercase tracking-[0.2em] text-foreground">
        ${Icons.chevronLeft(16)} ${t('manage_title')}
      </button>

      <div class="px-1 text-sm font-bold uppercase tracking-[0.2em] text-foreground">
        ${t('setup_guide')}
      </div>

      <div class="flex flex-col gap-3">
        <a href="${CONFIG.HAPP_IOS_URL}" target="_blank" rel="noopener noreferrer" class="w-full text-left">
          <div class="card flex items-center justify-between p-4 transition-colors hover:border-foreground/30">
            <div class="flex items-center gap-3">
              <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-dim">
                ${Icons.apple(16)}
              </div>
              <span class="text-sm text-foreground">${t('ios_app')}</span>
            </div>
            ${Icons.chevronRight(16, 'shrink-0 text-line-2')}
          </div>
        </a>

        <a href="${CONFIG.HAPP_ANDROID_URL}" target="_blank" rel="noopener noreferrer" class="w-full text-left">
          <div class="card flex items-center justify-between p-4 transition-colors hover:border-foreground/30">
            <div class="flex items-center gap-3">
              <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-dim">
                ${Icons.android(16)}
              </div>
              <span class="text-sm text-foreground">${t('android_app')}</span>
            </div>
            ${Icons.chevronRight(16, 'shrink-0 text-line-2')}
          </div>
        </a>

        <div class="card overflow-hidden p-0">
          <div class="flex aspect-video items-center justify-center bg-white/[0.02]">
            <div class="flex h-12 w-12 items-center justify-center rounded-full bg-white/[0.06] text-dim">
              ${Icons.play(18, 'translate-x-0.5')}
            </div>
          </div>
          <div class="p-4">
            <div class="text-sm font-semibold uppercase tracking-[0.05em] text-foreground">${t('getting_started')}</div>
            <p class="mt-1 text-xs text-dim">${t('walkthrough_soon')}</p>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Floating Bottom Navigation Bar
function renderBottomNav() {
  const tabs = [
    { id: 'status', label: t('nav_home'), icon: Icons.skull(18) },
    { id: 'features', label: t('nav_features'), icon: Icons.slidersHorizontal(18) },
    { id: 'manage', label: t('nav_manage'), icon: Icons.settings(18) }
  ];

  return `
    <nav class="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-3">
      <div class="glass pointer-events-auto relative flex items-stretch gap-0.5 rounded-[20px] p-1.5 shadow-2xl">
        ${tabs.map(item => {
          const isAct = state.tab === item.id;
          return `
            <button 
              data-nav-tab="${item.id}"
              class="relative z-10 flex w-[68px] flex-col items-center justify-center gap-1 rounded-[14px] py-2 transition-all duration-200 ${isAct ? 'text-foreground bg-white/10 font-bold' : 'text-mut hover:text-dim'}"
            >
              ${item.icon}
              <span class="max-w-full truncate px-0.5 text-[9.5px] uppercase tracking-[0.08em]">${item.label}</span>
            </button>
          `;
        }).join('')}
      </div>
    </nav>
  `;
}

// Clipboard copy with legacy fallback (http origins have no navigator.clipboard)
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch (e) {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
}

// Attach Event Listeners
function attachEvents() {
  const keyInput = document.getElementById('key-input');
  if (keyInput) {
    keyInput.addEventListener('input', (e) => {
      const formatted = formatKey(e.target.value);
      state.keyInput = formatted;
      keyInput.value = formatted;
      state.error = null;
    });
  }

  const keyForm = document.getElementById('key-form');
  if (keyForm) {
    keyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const val = state.keyInput.trim();

      if (!val) {
        state.error = 'enter your full key';
        render();
        return;
      }

      state.loading = true;
      state.error = null;
      render();

      try {
        const devInfo = await getRealClientDevice();
        const res = await fetch('/api/redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key: val,
            hwid: devInfo.hwid,
            device_model: devInfo.device_model,
            device_os: devInfo.device_os
          })
        });
        const data = await res.json().catch(() => ({}));
        
        if (res.ok) {
          state.auth.loggedIn = true;
          state.auth.key = val;
          if (data.me) {
            state.auth.me = { ...state.auth.me, ...data.me };
          }
          localStorage.setItem('aura_session', JSON.stringify({
            key: val,
            me: state.auth.me,
            features: state.auth.me.features
          }));
        } else {
          state.error = data.error || 'invalid key';
        }
      } catch (err) {
        state.error = 'network error';
      } finally {
        state.loading = false;
        render();
      }
    });
  }

  const langBtn = document.getElementById('lang-btn');
  if (langBtn) {
    langBtn.addEventListener('click', () => {
      state.isLangOpen = !state.isLangOpen;
      render();
    });
  }

  const langOverlay = document.getElementById('lang-overlay');
  if (langOverlay) {
    langOverlay.addEventListener('click', () => {
      state.isLangOpen = false;
      render();
    });
  }

  document.querySelectorAll('.lang-select-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const code = btn.getAttribute('data-lang');
      if (code) {
        state.lang = code;
        localStorage.setItem('aura_lang', code);
      }
      state.isLangOpen = false;
      render();
    });
  });

  document.querySelectorAll('[data-nav-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-nav-tab');
      if (tabId && tabId !== state.tab) {
        state.tab = tabId;
        state.manageSubView = 'list';
        render();
        window.scrollTo(0, 0);
      }
    });
  });

  // Feature Toggles
  document.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const field = btn.getAttribute('data-toggle');
      const f = state.auth.me.features;

      if (field === 'marker') f.marker.enabled = !f.marker.enabled;
      else if (field === 'aimpoint') f.aimpoint.enabled = !f.aimpoint.enabled;
      else if (field === 'aimLag') f.aimLag.enabled = !f.aimLag.enabled;
      else if (field === 'aimLag.onFire') f.aimLag.onFire = !f.aimLag.onFire;
      else if (field === 'aimLag.onScope') f.aimLag.onScope = !f.aimLag.onScope;
      else if (field === 'gloo') f.gloo.enabled = !f.gloo.enabled;
      else if (field === 'fastRevive') f.fastRevive.enabled = !f.fastRevive.enabled;

      render();
      saveFeatures(f);
    });
  });

  // Marker Type Pills
  document.querySelectorAll('[data-marker-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.getAttribute('data-marker-type');
      if (type) {
        state.auth.me.features.marker.type = type;
        render();
        saveFeatures(state.auth.me.features);
      }
    });
  });

  // Gloo Slider
  const glooSlider = document.getElementById('gloo-slider');
  if (glooSlider) {
    glooSlider.addEventListener('input', (e) => {
      const deg = parseInt(e.target.value, 10);
      state.auth.me.features.gloo.yawDeg = deg;
      const degDisplay = document.getElementById('gloo-deg-val');
      if (degDisplay) degDisplay.innerText = deg > 0 ? `+${deg}°` : `${deg}°`;
      
      const glooPct = ((deg - -180) / 360) * 100;
      glooSlider.style.background = `linear-gradient(90deg, var(--color-accent) ${glooPct}%, var(--color-line-2) ${glooPct}%)`;
    });

    glooSlider.addEventListener('change', () => {
      saveFeatures(state.auth.me.features);
    });
  }

  // Happ Button
  const happBtn = document.getElementById('happ-btn');
  if (happBtn) {
    happBtn.addEventListener('click', async () => {
      state.happLoading = true;
      state.happError = null;
      render();

      const subUrl = `${window.location.origin}/api/happ/sub?key=${encodeURIComponent(state.auth.key)}`;
      try { await copyText(subUrl); } catch (e) {}

      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '');
      const ctrl = new AbortController();
      const abortTimer = setTimeout(() => ctrl.abort(), 8000);

      try {
        const res = await fetch('/api/happ', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: state.auth.key, origin: window.location.origin }),
          signal: ctrl.signal
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.deepLink) {
          window.location.href = data.deepLink;
          if (!isMobile && data.href) {
            const fallbackTimer = setTimeout(() => {
              if (!document.hidden) window.location.href = data.href;
            }, 2000);
            document.addEventListener('visibilitychange', () => {
              if (document.hidden) clearTimeout(fallbackTimer);
            }, { once: true });
          }
        } else {
          state.happError = 'subscription link copied — open Happ and tap Clipboard';
        }
      } catch (e) {
        state.happError = 'subscription link copied — open Happ and tap Clipboard';
      } finally {
        clearTimeout(abortTimer);
        state.happLoading = false;
        render();
      }
    });
  }

  // Manage navigation
  const viewNotesBtn = document.getElementById('view-notes-btn');
  if (viewNotesBtn) {
    viewNotesBtn.addEventListener('click', () => {
      state.manageSubView = 'notes';
      render();
      window.scrollTo(0, 0);
    });
  }

  const viewGuideBtn = document.getElementById('view-guide-btn');
  if (viewGuideBtn) {
    viewGuideBtn.addEventListener('click', () => {
      state.manageSubView = 'guide';
      render();
      window.scrollTo(0, 0);
    });
  }

  const backToManageBtn = document.getElementById('back-to-manage-btn');
  if (backToManageBtn) {
    backToManageBtn.addEventListener('click', () => {
      state.manageSubView = 'list';
      render();
      window.scrollTo(0, 0);
    });
  }

  // Logout
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', logout);
  }
}

// Save features to server and localStorage
async function saveFeatures(f) {
  localStorage.setItem('aura_session', JSON.stringify({
    key: state.auth.key,
    me: state.auth.me,
    features: f
  }));

  try {
    await fetch('/api/features', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ features: f, key: state.auth.key })
    });
  } catch (e) {}
}

function logout() {
  try {
    fetch('/api/logout', { method: 'POST' });
  } catch (e) {}
  localStorage.removeItem('aura_session');
  localStorage.removeItem('pmm_session');
  state.auth.loggedIn = false;
  state.auth.key = '';
  state.tab = 'status';
  state.manageSubView = 'list';
  render();
}

// Timer ticker for countdown
if (!state.timerInterval) {
  state.timerInterval = setInterval(() => {
    const el = document.getElementById('countdown-display');
    if (el && state.auth.loggedIn && state.auth.me.expires_at) {
      el.innerHTML = formatCountdown(state.auth.me.expires_at);
    }
  }, 1000);
}

// Sync device info with server if already logged in
async function syncDeviceSession() {
  if (!state.auth.loggedIn || !state.auth.key) return;
  try {
    const devInfo = await getRealClientDevice();
    const res = await fetch('/api/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: state.auth.key,
        hwid: devInfo.hwid,
        device_model: devInfo.device_model,
        device_os: devInfo.device_os
      })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.me) {
        state.auth.me = { ...state.auth.me, ...data.me };
        localStorage.setItem('aura_session', JSON.stringify({
          key: state.auth.key,
          me: state.auth.me,
          features: state.auth.me.features
        }));
        render();
      }
    }
  } catch (e) {}
}

// Initial Boot
checkMaintenance();
initSSE();
render();
syncDeviceSession();
