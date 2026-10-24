// Cyber x silent — admin panel
// Admin key is verified ONLINE against adminkey.txt. Nothing is hardcoded.
(function () {
  const TOKEN_KEY = 'cyber_admin_token';
  let token = localStorage.getItem(TOKEN_KEY) || '';
  let keys = [];
  let polling = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function toast(msg, kind) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast ' + (kind || '');
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = 'toast hidden'; }, 3200);
  }

  function showLogin(message) {
    $('dash-view').classList.add('hidden');
    $('login-view').classList.remove('hidden');
    if (message) {
      const e = $('login-error');
      e.textContent = message;
      e.classList.remove('hidden');
    }
    if (polling) { clearInterval(polling); polling = null; }
  }

  function showDash() {
    $('login-view').classList.add('hidden');
    $('dash-view').classList.remove('hidden');
    if (!polling) polling = setInterval(loadAll, 30000);
  }

  async function api(path, opts) {
    const o = opts || {};
    o.headers = Object.assign(
      { 'Content-Type': 'application/json' },
      o.headers || {},
      token ? { Authorization: 'Bearer ' + token } : {}
    );
    const res = await fetch(path, o);

    // Any 401 => the online admin key changed / session died => force logout
    if (res.status === 401) {
      token = '';
      localStorage.removeItem(TOKEN_KEY);
      showLogin('admin key changed online — signed out.');
      throw new Error('unauthorized');
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('http ' + res.status));
    return data;
  }

  // ---------- login ----------
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('login-btn');
    const pw = $('login-input').value.trim();
    $('login-error').classList.add('hidden');
    if (!pw) return;

    btn.disabled = true;
    btn.textContent = 'verifying…';
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const el = $('login-error');
        el.textContent = data.error || 'wrong admin key';
        el.classList.remove('hidden');
        return;
      }
      token = data.token;
      localStorage.setItem(TOKEN_KEY, token);
      $('login-input').value = '';
      showDash();
      loadAll();
    } catch (err) {
      const el = $('login-error');
      el.textContent = 'network error';
      el.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = 'unlock';
    }
  });

  $('logout-btn').addEventListener('click', async () => {
    try { await api('/api/admin/logout', { method: 'POST' }); } catch (e) {}
    token = '';
    localStorage.removeItem(TOKEN_KEY);
    showLogin();
  });

  $('refresh-btn').addEventListener('click', () => { loadAll(); toast('refreshed', 'ok'); });

  // ---------- load ----------
  async function loadAll() {
    try {
      const [overview, who] = await Promise.all([
        api('/api/admin/overview'),
        api('/api/admin/whoami').catch(() => ({ keySource: '' }))
      ]);
      renderStats(overview);
      renderNodes(overview.nodes || []);
      fillMaintenance(overview.maintenance);
      $('key-source').textContent = 'admin key verified online · ' + (who.keySource || '');
      await loadKeys();
    } catch (e) {
      if (e.message !== 'unauthorized') toast(e.message, 'bad');
    }
  }

  async function loadKeys() {
    const data = await api('/api/admin/keys');
    keys = data.keys || [];
    renderKeys();
  }

  function renderStats(o) {
    const items = [
      ['total', o.totalKeys], ['active', o.activeKeys], ['unbound', o.unboundKeys],
      ['expired', o.expiredKeys], ['revoked', o.revokedKeys], ['users', o.totalUsers]
    ];
    $('stats').innerHTML = items.map(([label, val]) =>
      `<div class="card stat"><b>${Number(val) || 0}</b><span>${esc(label)}</span></div>`
    ).join('');
  }

  function renderNodes(nodes) {
    $('nodes-list').innerHTML = nodes.map(n => `
      <div class="between" style="border:1px solid var(--line);border-radius:12px;padding:10px 12px">
        <div>${esc(n.flag || '')} <b>${esc(n.name)}</b> <span class="muted mono">${esc(n.host)}:${esc(n.port)}</span></div>
        <div class="muted">${esc(n.ping)}ms · ${esc(n.users || 0)} users · ${esc(n.status)}</div>
      </div>
    `).join('') || '<p class="muted">no nodes</p>';
  }

  function fillMaintenance(m) {
    if (!m) return;
    $('mt-enabled').checked = !!m.enabled;
    $('mt-blocked').checked = !!m.blocked;
    $('mt-allowed').value = (m.allowed_logins || []).join(', ');
    $('mt-message').value = m.message || '';
  }

  function statusPill(k) {
    if (k.status === 'revoked') return '<span class="pill revoked">revoked</span>';
    if (new Date(k.expires_at).getTime() <= Date.now()) return '<span class="pill expired">expired</span>';
    return '<span class="pill active">active</span>';
  }

  function renderKeys() {
    const body = $('keys-body');
    $('keys-empty').classList.toggle('hidden', keys.length > 0);
    body.innerHTML = keys.map(k => {
      const expires = new Date(k.expires_at).getTime() <= Date.now()
        ? 'expired'
        : new Date(k.expires_at).toLocaleDateString();
      return `
        <tr>
          <td class="mono" style="font-size:12px">${esc(k.key)}</td>
          <td>${statusPill(k)}</td>
          <td class="muted">${esc(expires)}</td>
          <td>${k.bound_hwid ? `<span class="pill bound">${esc(k.device_model || 'bound')}</span>` : '<span class="pill free">unbound</span>'}</td>
          <td class="muted">${esc(k.note || '')}</td>
          <td class="row" style="justify-content:flex-end">
            <button class="ghost mini" data-act="extend" data-key="${esc(k.key)}">+30d</button>
            <button class="ghost mini" data-act="unbind" data-key="${esc(k.key)}">unbind</button>
            <button class="ghost mini" data-act="toggle" data-key="${esc(k.key)}">${k.status === 'active' ? 'revoke' : 'restore'}</button>
            <button class="danger mini" data-act="delete" data-key="${esc(k.key)}">del</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  // ---------- key actions ----------
  $('keys-body').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const key = btn.getAttribute('data-key');
    const act = btn.getAttribute('data-act');
    try {
      if (act === 'delete') {
        if (!confirm('delete ' + key + '?')) return;
        await api('/api/admin/keys/' + encodeURIComponent(key), { method: 'DELETE' });
        toast('deleted', 'ok');
      } else if (act === 'extend') {
        await api(`/api/admin/keys/${encodeURIComponent(key)}/extend`, { method: 'POST', body: JSON.stringify({ days: 30 }) });
        toast('extended +30d', 'ok');
      } else if (act === 'unbind') {
        await api(`/api/admin/keys/${encodeURIComponent(key)}/unbind`, { method: 'POST' });
        toast('device lock removed', 'ok');
      } else if (act === 'toggle') {
        const r = await api(`/api/admin/keys/${encodeURIComponent(key)}/toggle-status`, { method: 'POST' });
        toast('status: ' + r.status, 'ok');
      }
      await loadAll();
    } catch (err) {
      if (err.message !== 'unauthorized') toast(err.message, 'bad');
    }
  });

  // ---------- generate ----------
  $('gen-btn').addEventListener('click', async () => {
    const btn = $('gen-btn');
    btn.disabled = true;
    try {
      const data = await api('/api/admin/keys/generate', {
        method: 'POST',
        body: JSON.stringify({
          count: parseInt($('gen-count').value, 10) || 1,
          days: parseInt($('gen-days').value, 10) || 30,
          prefix: $('gen-prefix').value.trim() || 'CYBER',
          note: $('gen-note').value.trim() || 'Generated from Admin Panel'
        })
      });
      const out = $('gen-out');
      out.textContent = (data.keys || []).map(k => k.key).join('\n');
      out.classList.remove('hidden');
      toast((data.keys || []).length + ' key(s) generated', 'ok');
      await loadAll();
    } catch (err) {
      if (err.message !== 'unauthorized') toast(err.message, 'bad');
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- maintenance ----------
  $('mt-btn').addEventListener('click', async () => {
    try {
      await api('/api/admin/maintenance', {
        method: 'POST',
        body: JSON.stringify({
          enabled: $('mt-enabled').checked,
          blocked: $('mt-blocked').checked,
          allowed_logins: $('mt-allowed').value,
          message: $('mt-message').value
        })
      });
      toast('maintenance saved', 'ok');
    } catch (err) {
      if (err.message !== 'unauthorized') toast(err.message, 'bad');
    }
  });

  // ---------- instant force-logout when the online admin key changes ----------
  try {
    const es = new EventSource('/api/events');
    es.addEventListener('admin-key-changed', () => {
      token = '';
      localStorage.removeItem(TOKEN_KEY);
      showLogin('admin key was changed online — please sign in again.');
    });
  } catch (e) {}

  // ---------- boot ----------
  (async function boot() {
    if (!token) return showLogin();
    try {
      await loadAll();
      showDash();
    } catch (e) {
      showLogin();
    }
  })();
})();
