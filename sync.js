/* SkyNotes sync: Supabase (Postgres + Auth) over plain REST, no SDK.
   Model: every notebook/page is one row in public.records (data = JSON).
   Push: rows flagged dirty locally. Pull: rows with server_ts newer than last pull.
   Conflicts: last writer wins per record, by client `updated` time (enforced
   server-side by a trigger so a stale device can't overwrite newer data). */
'use strict';

const Sync = (() => {
  const LS_CFG = 'skynotes.syncCfg', LS_SESSION = 'skynotes.session';
  let session = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
  let running = false, again = false, timer = null, lastOk = null, lastErr = null, interval = null;

  const config = () => {
    const local = JSON.parse(localStorage.getItem(LS_CFG) || 'null');
    return local || window.SKYNOTES_CONFIG || {};
  };
  const setConfig = (url, key) => localStorage.setItem(LS_CFG, JSON.stringify({ url: url.replace(/\/+$/, ''), key }));
  const saveSession = s => { session = s; api.session = s; if (s) localStorage.setItem(LS_SESSION, JSON.stringify(s)); else localStorage.removeItem(LS_SESSION); };

  async function authCall(path, body) {
    const { url, key } = config();
    const r = await fetch(`${url}/auth/v1/${path}`, {
      method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.msg || j.message || `Sign-in failed (${r.status})`);
    return j;
  }
  const toSession = j => ({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, user: j.user });

  async function signIn(email, password) {
    const j = await authCall('token?grant_type=password', { email, password });
    saveSession(toSession(j));
  }
  async function signUp(email, password) {
    const j = await authCall('signup', { email, password });
    if (j.access_token) { saveSession(toSession(j)); return; }
    // email confirmation required by project settings: try direct sign-in anyway
    try { await signIn(email, password); } catch (e) { throw new Error('Account created. Check your email to confirm it, then sign in.'); }
  }
  function signOut() { saveSession(null); DB.setMeta('lastPull', null); setStatus(); }

  async function token() {
    if (!session) return null;
    if (Date.now() > session.expires_at - 60000) {
      try {
        const j = await authCall('token?grant_type=refresh_token', { refresh_token: session.refresh_token });
        saveSession(toSession(j));
      } catch (e) {
        if (/invalid|not found|revoked/i.test(e.message)) saveSession(null);
        throw e;
      }
    }
    return session.access_token;
  }

  async function rest(path, opts = {}) {
    const { url, key } = config();
    const t = await token();
    const r = await fetch(`${url}/rest/v1/${path}`, Object.assign({}, opts, {
      headers: Object.assign({ apikey: key, Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, opts.headers || {}),
    }));
    if (!r.ok) throw new Error(`Sync error ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.status === 204 ? null : r.json().catch(() => null);
  }

  const strip = rec => { const d = Object.assign({}, rec); delete d.dirty; return d; };

  async function push() {
    const dirty = (await DB.all()).filter(r => r.dirty);
    for (let i = 0; i < dirty.length; i += 15) {
      const batch = dirty.slice(i, i + 15);
      await rest('records?on_conflict=id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(batch.map(r => ({ id: r.id, kind: r.kind, data: strip(r), updated: r.updated, deleted: !!r.deleted }))),
      });
      // clear dirty only if the record wasn't edited again while uploading
      for (const r of batch) {
        const cur = await DB.get(r.id);
        if (cur && cur.updated === r.updated) { cur.dirty = 0; await DB.put(cur); }
      }
    }
    return dirty.length;
  }

  async function pull() {
    let since = await DB.getMeta('lastPull');
    let changed = [], total = 0;
    for (;;) {
      // 10 s overlap guards against rows committed slightly out of order
      const from = since ? new Date(new Date(since).getTime() - 10000).toISOString() : '1970-01-01T00:00:00Z';
      const rows = await rest(`records?select=id,data,updated,server_ts&server_ts=gt.${encodeURIComponent(from)}&order=server_ts.asc&limit=200`);
      if (!rows || !rows.length) break;
      for (const row of rows) {
        const local = await DB.get(row.id);
        if (!local || (local.updated || 0) < row.updated) {
          const rec = Object.assign({}, row.data, { updated: row.updated, dirty: 0 });
          await DB.put(rec);
          changed.push(rec);
        }
      }
      total += rows.length;
      const last = rows[rows.length - 1].server_ts;
      if (last === since || rows.length < 200) { since = last; break; }
      since = last;
    }
    if (since) await DB.setMeta('lastPull', since);
    return changed;
  }

  async function run(force) {
    if (!session || !config().url) { setStatus(); return; }
    if (running) { again = true; return; }
    if (!navigator.onLine && !force) { setStatus('Offline, changes saved on this iPad'); return; }
    running = true; setStatus('Syncing…');
    try {
      await push();
      const changed = await pull();
      lastOk = new Date(); lastErr = null;
      if (changed.length && window.onRemoteRecords) await window.onRemoteRecords(changed);
    } catch (e) {
      lastErr = e.message; console.warn('sync', e);
    } finally {
      running = false; setStatus();
      if (again) { again = false; schedule(500); }
    }
  }

  function schedule(ms = 2500) { clearTimeout(timer); timer = setTimeout(run, ms); }

  function statusText() {
    if (!config().url) return '';
    if (!session) return 'Not syncing (sign in under ⚙︎)';
    if (lastErr) return 'Sync problem: ' + lastErr;
    if (lastOk) return 'Synced ' + lastOk.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return 'Sync on';
  }
  function setStatus(msg) { const s = document.getElementById('syncStatus'); if (s) s.textContent = msg || statusText(); }

  function init() {
    setStatus();
    run();
    clearInterval(interval);
    interval = setInterval(() => { if (!document.hidden) run(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); else run(); });
    window.addEventListener('online', () => run());
  }

  const api = { init, run, schedule, signIn, signUp, signOut, config, setConfig, statusText, session };
  return api;
})();
window.Sync = Sync;
