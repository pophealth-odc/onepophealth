/* Shared helpers: session, data loading, widget registry and page renderer. */
const PH = (() => {
  const KEYS = {
    session: 'ph_session',
    lastPublished: 'ph_last_published',
    layoutDraft: 'ph_layout_draft',
    usersDraft: 'ph_users_draft',
    github: 'ph_github'
  };

  // ---------- storage ----------
  function readLocal(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function writeLocal(key, value) {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  }

  async function fetchJSON(path) {
    const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to load ${path} (${res.status})`);
    return res.json();
  }

  // Drafts (unpublished edits made in this browser) take precedence over published files.
  async function getUsers() {
    return readLocal(KEYS.usersDraft) || fetchJSON('data/users.json');
  }
  async function getPublishedUsers() { return fetchJSON('data/users.json'); }
  async function getLayout() {
    return readLocal(KEYS.layoutDraft) || fetchJSON('data/layout.json');
  }
  async function getPublishedLayout() { return fetchJSON('data/layout.json'); }

  // Drop local drafts that are identical to what is now published (e.g. after a publish has gone live).
  async function reconcileDrafts() {
    const pairs = [[KEYS.layoutDraft, 'data/layout.json'], [KEYS.usersDraft, 'data/users.json']];
    await Promise.all(pairs.map(async ([key, path]) => {
      const draft = readLocal(key);
      if (!draft) return;
      try {
        if (JSON.stringify(draft) === JSON.stringify(await fetchJSON(path))) writeLocal(key, null);
      } catch { /* keep draft if published file is unreachable */ }
    }));
  }

  // 'none' | 'deploying' (published, waiting for GitHub Pages) | 'unpublished'
  function draftState() {
    const layout = readLocal(KEYS.layoutDraft), users = readLocal(KEYS.usersDraft);
    if (!layout && !users) return 'none';
    const last = readLocal(KEYS.lastPublished) || {};
    const same = (draft, published) => !draft || JSON.stringify(draft) === published;
    return same(layout, last.layout) && same(users, last.users) ? 'deploying' : 'unpublished';
  }

  // ---------- session ----------
  function getSession() { return readLocal(KEYS.session); }
  function setSession(user) { writeLocal(KEYS.session, { username: user.username, role: user.role, domain: user.domain || DEFAULT_DOMAIN }); }
  function clearSession() { writeLocal(KEYS.session, null); }
  function isAdmin(session) { return !!session && String(session.role).toLowerCase() === 'admin'; }

  // ---------- single sign-on to the other modules ----------
  // The Leave Tracker shares this site (pophealth-odc.github.io), so it reads this login directly.
  // The VA Tracker and Knowledge Base live on kailknight.github.io, which can't see this browser storage,
  // so links to them carry "#sso=<token>" (base64url JSON { u: username, t: issued-at }).
  const SSO_MODULES = ['https://kailknight.github.io/VATracker', 'https://kailknight.github.io/knowledgebase',
    'https://pophealth-odc.github.io/leavetracker'];
  const isModuleUrl = (url) => SSO_MODULES.some(m => String(url).toLowerCase().startsWith(m.toLowerCase()));
  function ssoToken(session = getSession()) {
    if (!session) return '';
    return btoa(JSON.stringify({ u: session.username, t: Date.now() })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function ssoUrl(url) {
    const token = ssoToken();
    if (!token || !isModuleUrl(url)) return url;
    const [base, hash = ''] = String(url).split('#');
    return `${base}#${hash ? hash + '&' : ''}sso=${token}`;
  }
  // Add the token to every module link inside `root` (and refresh it when clicked, so it's never stale).
  function decorateSso(root) {
    root.querySelectorAll('a[href]').forEach(a => {
      if (!isModuleUrl(a.href)) return;
      const plain = a.getAttribute('href');
      a.href = ssoUrl(plain);
      a.addEventListener('click', () => { a.href = ssoUrl(plain); });
    });
  }

  // ---------- domains ----------
  // Each user belongs to a domain; dashboard blocks and feature pages can be limited to domains.
  // Users saved before domains existed count as the default domain.
  const DEFAULT_DOMAIN = 'Population Health';
  const userDomain = (session) => (session && session.domain) || DEFAULT_DOMAIN;
  const inDomain = (session, domain) => userDomain(session).toLowerCase() === String(domain).toLowerCase();
  // A block with no domains ticked is visible to every domain.
  function blockVisible(block, session) {
    const d = block.props && block.props.domains;
    return !Array.isArray(d) || !d.length || d.some(x => inDomain(session, x));
  }
  // Placeholders usable in any block text and the site title: {dashboard} → the domain's dashboard name
  // (Admin → Users → Domains, e.g. "OnePopHealth"), {domain} → the domain itself.
  const dashboardName = (layout, domain) => (layout.settings && layout.settings.dashboardNames && layout.settings.dashboardNames[domain]) || domain;
  const tokenVars = (layout, domain) => ({ dashboard: dashboardName(layout, domain), domain });
  // Tell domain-aware blocks (VA summary) which domain they're rendered for.
  const withDomain = (block, domain) => ({ ...block, props: { ...block.props, __domain: domain } });
  function fillTokens(value, vars) {
    if (typeof value === 'string') return value.replace(/\{(dashboard|domain)\}/g, (m, k) => vars[k] ?? m);
    if (Array.isArray(value)) return value.map(v => fillTokens(v, vars));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTokens(v, vars)]));
    return value;
  }
  const domainList = (layout) => (layout.settings && layout.settings.domains && layout.settings.domains.length)
    ? layout.settings.domains : [DEFAULT_DOMAIN];

  // Re-read the signed-in user from users.json so role/domain changes apply without logging out.
  async function refreshSession() {
    const s = getSession();
    if (!s) return null;
    try {
      const user = (await getUsers()).find(u => u.username.toLowerCase() === s.username.toLowerCase());
      if (!user) { clearSession(); location.replace('index.html'); return null; }
      setSession(user);
    } catch { /* offline / not published yet: keep the current session */ }
    return getSession();
  }
  // Which domains may use a feature page group, e.g. 'templates' (Emergency / Pre-Approved Change + Approvals).
  // Set in Admin → Users → Domains (layout.settings.pageDomains); an empty list means every domain.
  function pageDomains(layout, group) {
    const list = layout.settings && layout.settings.pageDomains && layout.settings.pageDomains[group];
    return Array.isArray(list) ? list : [DEFAULT_DOMAIN];
  }
  // Approvals are scoped to the submitter's domain (looked up from users.json, so no extra DB column).
  // Returns a PostgREST filter for requests submitted by users of `domain`.
  async function submittedInDomain(domain) {
    const names = (await getUsers()).filter(u => inDomain(u, domain)).map(u => `"${u.username.replace(/["\\]/g, '')}"`);
    return `&submitted_by=in.(${encodeURIComponent(names.length ? names.join(',') : '"__none__"')})`;
  }
  const allowedIn = (session, domains) => !domains.length || domains.some(d => inDomain(session, d));
  function requireDomain(session, domains, container) {
    domains = [].concat(domains);
    if (allowedIn(session, domains)) return true;
    container.replaceChildren(el('div', { class: 'w-empty', text: `This page is only available to the ${domains.join(' / ')} domain${domains.length > 1 ? 's' : ''} (you are in ${userDomain(session)}).` }));
    return false;
  }

  // Roles: Admin (everything), Approver (VA + approve change requests), User (VA + submit), View (read-only).
  const ROLES = ['User', 'Approver', 'View', 'Admin'];
  const PERMS = {
    vaClick: ['admin', 'approver', 'user'],
    submit: ['admin', 'approver', 'user'],
    approve: ['admin', 'approver']
  };
  function can(session, perm) {
    return !!session && (PERMS[perm] || []).includes(String(session.role).toLowerCase());
  }

  function requireLogin() {
    const s = getSession();
    if (!s) { location.replace('index.html'); return null; }
    return s;
  }
  function requireAdmin() {
    const s = requireLogin();
    if (s && !isAdmin(s)) { location.replace('main.html'); return null; }
    return s;
  }

  // ---------- approvals storage (Supabase REST) ----------
  // Settings live in layout.json → settings.approvals { url, anonKey } (Admin Dashboard → Users).
  // Only the public anon key may be used here; a service_role key would give every visitor full DB access.
  function jwtRole(key) {
    try { return JSON.parse(atob(String(key).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role || ''; } catch { return ''; }
  }
  async function approvalsDb() {
    const layout = await getLayout();
    const cfg = layout.settings?.approvals || {};
    const url = String(cfg.url || '').trim().replace(/\/+$/, ''), key = String(cfg.anonKey || '').trim();
    if (!/^https:\/\//i.test(url) || !key) throw new Error('Approvals are not set up yet — an admin needs to add the Supabase settings (Admin Dashboard → Users).');
    if (jwtRole(key) === 'service_role') throw new Error('The approvals key is a service_role key — an admin must replace it with the anon key.');
    const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    const call = async (method, path, body, prefer) => {
      const res = await fetch(`${url}/rest/v1/${path}`, {
        method, headers: prefer ? { ...headers, Prefer: prefer } : headers, body: body && JSON.stringify(body), cache: 'no-store'
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok) throw new Error(json?.message || `HTTP ${res.status}`);
      return json;
    };
    return {
      list: (query) => call('GET', `change_requests?${query}`),
      insert: (row) => call('POST', 'change_requests', row, 'return=representation').then(r => r[0]),
      // Only updates while still pending, so two approvers can't both decide the same request.
      decide: (id, fields) => call('PATCH', `change_requests?id=eq.${encodeURIComponent(id)}&status=eq.pending`, fields, 'return=representation')
    };
  }

  // ---------- utils ----------
  function uid() { return 'b' + Math.random().toString(36).slice(2, 9); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // Only allow http(s), mailto, tel, relative and anchor links.
  function safeUrl(url) {
    const u = String(url || '').trim();
    if (!u) return '';
    if (/^(https?:|mailto:|tel:)/i.test(u) || /^[#/.?]/.test(u) || !/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
    return '';
  }

  function toEmbedUrl(url) {
    const u = safeUrl(url);
    if (!/^https:/i.test(u)) return '';
    const yt = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})/i);
    if (yt) return `https://www.youtube.com/embed/${yt[1]}`;
    return u;
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === '') continue;
      if (k === 'style') Object.assign(node.style, v);
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
  }

  // ---------- Leave Tracker feed ----------
  // Reads the Leave Tracker's Supabase REST API (same query as its "Upcoming Leave" box).
  const leaveCache = new Map(); // cache key -> { at, promise }; avoids refetching on every designer re-render

  function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

  // Only leave of the viewer's domain (team members have a domain in the Leave Tracker).
  // If the Leave Tracker database hasn't got the domain column yet, falls back to everyone.
  function fetchUpcomingLeave(url, key, days, domain) {
    const id = `${url}|${key}|${days}|${domain}`;
    const hit = leaveCache.get(id);
    if (hit && Date.now() - hit.at < 60000) return hit.promise;

    const today = new Date(), until = new Date();
    until.setDate(until.getDate() + days);
    const request = (byDomain) => {
      const query = new URLSearchParams({
        select: `id,start_date,end_date,number_of_days,profiles!employee_id${byDomain ? '!inner' : ''}(full_name${byDomain ? ',domain' : ''}),leave_types!leave_type_id(name,color)`,
        order: 'start_date'
      });
      query.append('start_date', `gt.${isoDate(today)}`);
      query.append('start_date', `lte.${isoDate(until)}`);
      if (byDomain) query.append('profiles.domain', `eq.${domain}`);
      return fetch(`${url.replace(/\/+$/, '')}/rest/v1/leave_records?${query}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` }
      });
    };
    const promise = request(true).then(async res => {
      if (!res.ok && /domain/i.test(await res.clone().text())) res = await request(false); // column not added yet
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });
    promise.catch(() => leaveCache.delete(id));
    leaveCache.set(id, { at: Date.now(), promise });
    return promise;
  }

  const AVATAR_COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6'];
  function avatarColor(name) {
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }
  const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join('');
  const safeColor = (c) => /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#3b82f6';
  const shortDate = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };

  function upcomingLeave(p) {
    const box = el('div', { class: 'w-leave' }, el('div', { class: 'w-leave-msg', text: 'Loading upcoming leave…' }));
    const url = safeUrl(p.feedUrl), key = String(p.feedKey || '').trim();
    if (!/^https:/i.test(url) || !key) {
      box.firstChild.textContent = 'Set the Leave Tracker Supabase URL and anon key in this card’s settings.';
      return box;
    }
    const days = Math.max(1, Number(p.feedDays) || 30), max = Math.max(1, Number(p.feedMax) || 5);

    fetchUpcomingLeave(url, key, days, p.__domain || userDomain(getSession())).then(records => {
      if (!records.length) {
        box.replaceChildren(el('div', { class: 'w-leave-msg', text: `No leave scheduled in the next ${days} days.` }));
        return;
      }
      const items = records.slice(0, max).map(r => {
        const name = r.profiles?.full_name || 'Unknown';
        const type = r.leave_types?.name || 'Leave';
        const [, m, d] = r.start_date.split('-').map(Number);
        const n = Number(r.number_of_days);
        const range = r.end_date && r.end_date !== r.start_date ? `${shortDate(r.start_date)} – ${shortDate(r.end_date)}` : shortDate(r.start_date);
        return el('div', { class: 'w-leave-item' }, [
          el('div', { class: 'w-leave-date' }, [el('div', { class: 'day', text: String(d) }), el('div', { class: 'month', text: MONTHS_SHORT[m - 1] })]),
          el('div', { class: 'w-leave-info' }, [
            el('div', { class: 'w-leave-name' }, [
              el('span', { class: 'w-leave-avatar', text: initials(name), style: { background: avatarColor(name) } }),
              el('span', { text: name })
            ]),
            el('span', { class: 'w-leave-type', text: type, style: { background: safeColor(r.leave_types?.color) } }),
            el('div', { class: 'w-leave-range', text: Number.isFinite(n) ? `${range} · ${n} day${n === 1 ? '' : 's'}` : range })
          ])
        ]);
      });
      if (records.length > max) items.push(el('div', { class: 'w-leave-msg', text: `+ ${records.length - max} more` }));
      box.replaceChildren(...items);
    }).catch(err => {
      box.replaceChildren(el('div', { class: 'w-leave-msg', text: `Couldn’t load upcoming leave (${err.message}).` }));
    });
    return box;
  }
  const MONTHS_SHORT = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  // ---------- card list ----------
  // items: [{ text, url }]; url optional. External links open in a new tab.
  function linkList(items) {
    const list = (Array.isArray(items) ? items : []).filter(it => String(it.text || it.url || '').trim());
    if (!list.length) return null;
    return el('ul', { class: 'w-card-list' }, list.map(it => {
      const url = safeUrl(it.url), text = String(it.text || it.url).trim();
      if (!url) return el('li', {}, el('span', { text }));
      const a = el('a', { href: url, text });
      if (/^https?:/i.test(url)) { a.target = '_blank'; a.rel = 'noopener'; }
      return el('li', {}, a);
    }));
  }

  // ---------- VA summary (reads data/va.json, links to the VA Tracker) ----------
  // Same rules as the VA Tracker: days left = SLA Deadline − today; breached when negative.
  // One VA file per domain: Population Health keeps data/va.json; others use data/va-<domain>.json.
  // (The VA Tracker site uses the same rule.)
  function vaPath(domain) {
    if (!domain || domain.toLowerCase() === DEFAULT_DOMAIN.toLowerCase()) return 'data/va.json';
    return `data/va-${domain.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.json`;
  }
  const vaPromises = {};
  function loadVa(domain) {
    const path = vaPath(domain);
    vaPromises[path] = vaPromises[path] || fetchJSON(path).catch(err => { delete vaPromises[path]; throw err; });
    return vaPromises[path];
  }
  function parseDmy(s) {
    const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
  }
  function vaCounts(data) {
    const idx = Object.fromEntries(data.columns.map((c, i) => [c, i]));
    const get = (r, c) => String((Array.isArray(r) ? r[idx[c]] : r[c]) ?? '').trim();
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const out = { nostrategy: 0, breach: 0, d15: 0, d30: 0, total: data.rows.length };
    for (const r of data.rows) {
      const deadline = parseDmy(get(r, 'SLA Deadline'));
      let days = deadline ? Math.round((deadline - now) / 86400000) : parseInt(get(r, 'Days to SLA Breach'), 10);
      const breached = Number.isNaN(days) ? /breach/i.test(get(r, 'SLA Status')) : days < 0;
      if (breached) out.breach++;
      else if (days <= 15) out.d15++;
      else if (days <= 30) out.d30++;
      if (!get(r, 'Remediation Strategy')) out.nostrategy++;
    }
    return out;
  }
  const VA_TILES = [
    { key: 'nostrategy', flag: 'showNoStrategy', label: 'No Remediation Strategy', sub: 'strategy is blank' },
    { key: 'breach', flag: 'showBreach', label: 'SLA Breach', sub: 'deadline has passed' },
    { key: 'd15', flag: 'showD15', label: '< 15 days', sub: '0–15 days to SLA' },
    { key: 'd30', flag: 'showD30', label: '< 30 days', sub: '16–30 days to SLA' }
  ];
  function vaSummary(p) {
    // The viewer's domain (renderPage / the designer preview pass it in as __domain).
    const domain = p.__domain || userDomain(getSession());
    const base = `${safeUrl(p.trackerUrl) || '#'}#domain=${encodeURIComponent(domain)}`;
    const tiles = VA_TILES.filter(t => p[t.flag] !== false);
    // View-only users see the numbers but can't open the VA Tracker.
    const clickable = can(getSession(), 'vaClick');
    const tile = (t) => clickable
      ? el('a', { class: `w-va-tile tone-${t.key}`, href: `${base}&open=${t.key}` })
      : el('div', { class: `w-va-tile tone-${t.key} w-va-static`, title: 'View access: details are not available' });
    const nums = {};
    const box = el('div', { class: 'w-va' }, [
      el('div', { class: 'w-va-head' }, [
        p.title ? el('h3', { text: p.title }) : null,
        el('span', { class: 'w-va-meta', text: 'Loading VA data…' }),
        clickable ? el('a', { class: 'w-va-open', href: base, text: 'Open VA Tracker →' }) : null
      ]),
      el('div', { class: 'w-va-tiles' }, tiles.map(t => {
        const node = tile(t);
        node.append(
          nums[t.key] = el('div', { class: 'w-va-num', text: '…' }),
          el('div', { class: 'w-va-label', text: t.label }),
          el('div', { class: 'w-va-sub', text: t.sub })
        );
        return node;
      }))
    ]);
    const meta = box.querySelector('.w-va-meta');
    loadVa(domain).then(data => {
      const c = vaCounts(data);
      for (const t of tiles) nums[t.key].textContent = c[t.key].toLocaleString();
      const when = data.updatedAt ? new Date(data.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
      meta.textContent = `${c.total.toLocaleString()} findings${when ? ' · data from ' + when : ''}`;
    }).catch(() => {
      meta.textContent = `No VA data for ${domain} yet — upload it in Admin Dashboard → VA.`;
      for (const t of tiles) nums[t.key].textContent = '–';
    });
    return box;
  }

  // ---------- widget registry ----------
  const commonFields = [
    { key: 'width', label: 'Width', type: 'select', options: [
      { value: 12, label: 'Full' }, { value: 9, label: '3/4' }, { value: 8, label: '2/3' },
      { value: 6, label: '1/2' }, { value: 4, label: '1/3' }, { value: 3, label: '1/4' }
    ] },
    { key: 'padding', label: 'Padding (px)', type: 'number', min: 0, max: 200 },
    { key: 'domains', label: 'Visible to domains (none ticked = all domains)', type: 'domains' }
  ];
  const alignField = { key: 'align', label: 'Align', type: 'select', options: ['left', 'center', 'right'] };

  const WIDGETS = {
    hero: {
      label: 'Hero banner', icon: '★',
      defaults: { title: 'Big headline', subtitle: 'Supporting text', background: '#2563eb', color: '#ffffff', image: '', buttonText: 'Get started', buttonUrl: '#', width: 12, padding: 0 },
      fields: [
        { key: 'title', label: 'Title', type: 'text' },
        { key: 'subtitle', label: 'Subtitle', type: 'textarea' },
        { key: 'background', label: 'Background', type: 'color' },
        { key: 'color', label: 'Text color', type: 'color' },
        { key: 'image', label: 'Background image URL', type: 'text' },
        { key: 'buttonText', label: 'Button text', type: 'text' },
        { key: 'buttonUrl', label: 'Button link', type: 'text' }
      ],
      render(p, theme) {
        const style = { background: p.background, color: p.color, textAlign: 'center', borderRadius: '12px' };
        if (safeUrl(p.image)) {
          style.backgroundImage = `linear-gradient(rgba(0,0,0,.35),rgba(0,0,0,.35)), url("${encodeURI(safeUrl(p.image))}")`;
          style.backgroundSize = 'cover';
          style.backgroundPosition = 'center';
        }
        return el('div', { class: 'w-hero', style }, [
          el('h1', { text: p.title }),
          p.subtitle ? el('p', { text: p.subtitle }) : null,
          p.buttonText ? el('a', { class: 'w-button', href: safeUrl(p.buttonUrl) || '#', text: p.buttonText,
            style: { background: p.color, color: p.background } }) : null
        ]);
      }
    },
    heading: {
      label: 'Heading', icon: 'H',
      defaults: { text: 'New heading', level: 'h2', align: 'left', color: '', width: 12, padding: 8 },
      fields: [
        { key: 'text', label: 'Text', type: 'text' },
        { key: 'level', label: 'Size', type: 'select', options: ['h1', 'h2', 'h3', 'h4'] },
        alignField,
        { key: 'color', label: 'Color', type: 'color' }
      ],
      render(p) {
        const level = ['h1', 'h2', 'h3', 'h4'].includes(p.level) ? p.level : 'h2';
        return el(level, { class: 'w-heading', text: p.text, style: { textAlign: p.align, color: p.color || undefined } });
      }
    },
    text: {
      label: 'Paragraph', icon: '¶',
      defaults: { text: 'Write something here…', align: 'left', color: '', size: 16, width: 12, padding: 8 },
      fields: [
        { key: 'text', label: 'Text', type: 'textarea' },
        alignField,
        { key: 'size', label: 'Font size (px)', type: 'number', min: 10, max: 48 },
        { key: 'color', label: 'Color', type: 'color' }
      ],
      render(p) {
        return el('p', { class: 'w-text', text: p.text,
          style: { textAlign: p.align, color: p.color || undefined, fontSize: `${p.size}px` } });
      }
    },
    image: {
      label: 'Image', icon: '🖼',
      defaults: { src: 'https://picsum.photos/800/400', alt: 'Image', caption: '', radius: 8, align: 'center', width: 12, padding: 8 },
      fields: [
        { key: 'src', label: 'Image URL', type: 'text' },
        { key: 'alt', label: 'Alt text', type: 'text' },
        { key: 'caption', label: 'Caption', type: 'text' },
        { key: 'radius', label: 'Corner radius (px)', type: 'number', min: 0, max: 100 },
        alignField
      ],
      render(p) {
        return el('figure', { class: 'w-image', style: { textAlign: p.align } }, [
          safeUrl(p.src) ? el('img', { src: safeUrl(p.src), alt: p.alt, style: { borderRadius: `${p.radius}px` } }) : el('div', { class: 'w-empty', text: 'No image URL' }),
          p.caption ? el('figcaption', { text: p.caption }) : null
        ]);
      }
    },
    button: {
      label: 'Button', icon: '⬭',
      defaults: { text: 'Click me', url: '#', background: '', color: '#ffffff', align: 'left', newTab: false, width: 12, padding: 8 },
      fields: [
        { key: 'text', label: 'Text', type: 'text' },
        { key: 'url', label: 'Link', type: 'text' },
        { key: 'background', label: 'Background (blank = accent)', type: 'color' },
        { key: 'color', label: 'Text color', type: 'color' },
        alignField,
        { key: 'newTab', label: 'Open in new tab', type: 'checkbox' }
      ],
      render(p, theme) {
        const a = el('a', { class: 'w-button', href: safeUrl(p.url) || '#', text: p.text,
          style: { background: p.background || theme.accent, color: p.color } });
        if (p.newTab) { a.target = '_blank'; a.rel = 'noopener'; }
        return el('div', { style: { textAlign: p.align } }, a);
      }
    },
    card: {
      label: 'Card', icon: '▭',
      defaults: { title: 'Card title', body: 'Card description', items: [], image: '', linkText: '', linkUrl: '', background: '#ffffff',
        feed: '', feedUrl: '', feedKey: '', feedDays: 30, feedMax: 5, width: 4, padding: 24 },
      fields: [
        { key: 'title', label: 'Title', type: 'text' },
        { key: 'body', label: 'Body', type: 'textarea' },
        { key: 'items', label: 'List (each item can have a link)', type: 'links' },
        { key: 'image', label: 'Image URL', type: 'text' },
        { key: 'linkText', label: 'Link text', type: 'text' },
        { key: 'linkUrl', label: 'Link URL', type: 'text' },
        { key: 'clickable', label: 'Make the whole card clickable (opens the Link URL; hides the link text)', type: 'checkbox' },
        { key: 'background', label: 'Background', type: 'color' },
        { key: 'feed', label: 'Live content (replaces body)', type: 'select', options: [
          { value: '', label: 'None' },
          { value: 'leave', label: 'Upcoming leave (Leave Tracker)' }
        ] },
        { key: 'feedUrl', label: 'Leave Tracker Supabase URL', type: 'text' },
        { key: 'feedKey', label: 'Leave Tracker anon key (public key only, never service_role)', type: 'text' },
        { key: 'feedDays', label: 'Upcoming leave: days ahead', type: 'number', min: 1, max: 365 },
        { key: 'feedMax', label: 'Upcoming leave: max people shown', type: 'number', min: 1, max: 50 }
      ],
      render(p, theme) {
        const body = p.feed === 'leave' ? upcomingLeave(p) : p.body ? el('p', { text: p.body }) : null;
        // A white (default) background follows the light/dark theme; any other colour is kept as chosen.
        const plain = !p.background || /^#?f{3}(f{3})?$/i.test(p.background);
        const href = safeUrl(p.linkUrl);
        const whole = !!(p.clickable && href);
        const card = el('div', { class: `w-card${plain ? ' w-card-plain' : ''}${whole ? ' w-card-link' : ''}`, style: { background: plain ? undefined : p.background } }, [
          safeUrl(p.image) ? el('img', { src: safeUrl(p.image), alt: '' }) : null,
          el('h3', { text: p.title }),
          body,
          linkList(p.items),
          p.linkText && !whole ? el('a', { href: href || '#', text: p.linkText + ' →', style: { color: theme.accent } }) : null
        ]);
        if (whole) {
          // A click anywhere opens the link (list links inside the card still work on their own).
          // Not inside the admin designer, where a click selects the block.
          Object.assign(card, { tabIndex: 0, title: `Open ${p.title || 'link'}` });
          card.setAttribute('role', 'link');
          const go = (e) => {
            if (card.closest('.canvas') || e.target.closest('a')) return;
            const target = ssoUrl(href); // signs you in to other modules (VA Tracker, Leave Tracker, …)
            if (/^https?:/i.test(href) && (e.ctrlKey || e.metaKey)) window.open(target, '_blank', 'noopener');
            else location.href = target;
          };
          card.addEventListener('click', go);
          card.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(e); });
        }
        return card;
      }
    },
    vaSummary: {
      label: 'VA summary', icon: '🛡',
      defaults: { title: 'VA Status', trackerUrl: 'https://kailknight.github.io/VATracker/',
        showNoStrategy: true, showBreach: true, showD15: true, showD30: true, width: 12, padding: 0 },
      fields: [
        { key: 'title', label: 'Title', type: 'text' },
        { key: 'trackerUrl', label: 'VA Tracker URL', type: 'text' },
        { key: 'showNoStrategy', label: 'Show No Remediation Strategy', type: 'checkbox' },
        { key: 'showBreach', label: 'Show SLA Breach', type: 'checkbox' },
        { key: 'showD15', label: 'Show < 15 days', type: 'checkbox' },
        { key: 'showD30', label: 'Show < 30 days', type: 'checkbox' }
      ],
      render: (p) => vaSummary(p)
    },
    list: {
      label: 'List', icon: '☰',
      defaults: { items: 'First item\nSecond item\nThird item', ordered: false, width: 12, padding: 8 },
      fields: [
        { key: 'items', label: 'Items (one per line)', type: 'textarea' },
        { key: 'ordered', label: 'Numbered', type: 'checkbox' }
      ],
      render(p) {
        const items = String(p.items || '').split('\n').filter(s => s.trim());
        return el(p.ordered ? 'ol' : 'ul', { class: 'w-list' }, items.map(t => el('li', { text: t })));
      }
    },
    embed: {
      label: 'Video / Embed', icon: '▶',
      defaults: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', height: 360, width: 12, padding: 8 },
      fields: [
        { key: 'url', label: 'URL (YouTube or https page)', type: 'text' },
        { key: 'height', label: 'Height (px)', type: 'number', min: 100, max: 1200 }
      ],
      render(p) {
        const src = toEmbedUrl(p.url);
        if (!src) return el('div', { class: 'w-empty', text: 'Enter an https:// URL' });
        return el('iframe', { class: 'w-embed', src, height: p.height, allowfullscreen: '', loading: 'lazy',
          referrerpolicy: 'no-referrer', sandbox: 'allow-scripts allow-same-origin allow-presentation allow-popups' });
      }
    },
    divider: {
      label: 'Divider', icon: '—',
      defaults: { color: '#d1d5db', thickness: 1, width: 12, padding: 8 },
      fields: [
        { key: 'color', label: 'Color', type: 'color' },
        { key: 'thickness', label: 'Thickness (px)', type: 'number', min: 1, max: 20 }
      ],
      render(p) {
        return el('hr', { class: 'w-divider', style: { borderTop: `${p.thickness}px solid ${p.color}` } });
      }
    },
    spacer: {
      label: 'Spacer', icon: '↕',
      defaults: { height: 40, width: 12, padding: 0 },
      fields: [{ key: 'height', label: 'Height (px)', type: 'number', min: 4, max: 400 }],
      render(p) { return el('div', { class: 'w-spacer', style: { height: `${p.height}px` } }); }
    }
  };
  for (const w of Object.values(WIDGETS)) w.fields = [...w.fields, ...commonFields];

  const THEME_FIELDS = [
    { key: 'siteTitle', label: 'Site title', type: 'text' },
    { key: 'background', label: 'Page background', type: 'color' },
    { key: 'text', label: 'Text color', type: 'color' },
    { key: 'accent', label: 'Accent color', type: 'color' },
    { key: 'headerBg', label: 'Header background', type: 'color' },
    { key: 'headerText', label: 'Header text', type: 'color' },
    { key: 'font', label: 'Font', type: 'select', options: [
      { value: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', label: 'System' },
      { value: 'Georgia, "Times New Roman", serif', label: 'Serif' },
      { value: '"Trebuchet MS", Verdana, sans-serif', label: 'Humanist' },
      { value: '"Courier New", monospace', label: 'Monospace' }
    ] },
    { key: 'maxWidth', label: 'Content max width (px)', type: 'number', min: 600, max: 2000 }
  ];

  // ---------- rendering ----------
  // Page colours from the admin are the light theme (--theme-*); css/style.css maps them to the
  // --page-* variables and replaces them with a dark palette when dark mode is on.
  function applyTheme(theme, root = document.documentElement) {
    root.style.setProperty('--theme-page-bg', theme.background);
    root.style.setProperty('--theme-page-text', theme.text);
    root.style.setProperty('--accent', theme.accent);
    root.style.setProperty('--theme-header-bg', theme.headerBg);
    root.style.setProperty('--theme-header-text', theme.headerText);
    root.style.setProperty('--page-font', theme.font);
    root.style.setProperty('--max-width', `${theme.maxWidth}px`);
  }

  // ---------- dark mode ----------
  // Each page's <head> sets data-theme before painting; this wires up every [data-theme-toggle] button.
  const THEME_KEY = 'ph_theme';
  function setColorMode(mode) {
    document.documentElement.dataset.theme = mode;
    try { localStorage.setItem(THEME_KEY, mode); } catch { /* storage may be blocked */ }
    syncThemeButtons();
  }
  function syncThemeButtons() {
    const dark = document.documentElement.dataset.theme === 'dark';
    document.querySelectorAll('[data-theme-toggle]').forEach(b => {
      b.textContent = dark ? '☀️ Light' : '🌙 Dark';
      b.setAttribute('aria-pressed', String(dark));
      b.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    });
  }
  function initThemeToggle() {
    document.querySelectorAll('[data-theme-toggle]').forEach(b => {
      b.onclick = () => setColorMode(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });
    syncThemeButtons();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initThemeToggle);
  else initThemeToggle();

  function renderBlock(block, theme) {
    const def = WIDGETS[block.type];
    const props = { ...(def ? def.defaults : {}), ...block.props };
    const inner = def ? def.render(props, theme) : el('div', { class: 'w-empty', text: `Unknown block: ${block.type}` });
    const wrap = el('div', { class: 'ph-block', 'data-id': block.id }, inner);
    wrap.style.gridColumn = `span ${Math.min(12, Math.max(1, Number(props.width) || 12))}`;
    wrap.style.padding = `${Number(props.padding) || 0}px`;
    return wrap;
  }

  // With a session, only the blocks for that user's domain are shown.
  function renderPage(layout, container, session) {
    const domain = userDomain(session);
    const vars = tokenVars(layout, domain);
    const blocks = (session ? layout.blocks.filter(b => blockVisible(b, session)) : layout.blocks)
      .map(b => withDomain(fillTokens(b, vars), domain));
    container.replaceChildren(...blocks.map(b => renderBlock(b, layout.theme)));
    if (session) decorateSso(container);
    if (session && !blocks.length) {
      container.replaceChildren(el('div', { class: 'w-empty', style: { gridColumn: 'span 12' },
        text: `Nothing has been set up for the ${userDomain(session)} domain yet.` }));
    }
  }

  return {
    KEYS, readLocal, writeLocal, fetchJSON,
    getUsers, getPublishedUsers, getLayout, getPublishedLayout, reconcileDrafts, draftState,
    getSession, setSession, clearSession, isAdmin, requireLogin, requireAdmin, ROLES, can, approvalsDb, jwtRole,
    DEFAULT_DOMAIN, userDomain, inDomain, blockVisible, domainList, refreshSession, requireDomain, pageDomains, allowedIn, submittedInDomain,
    dashboardName, tokenVars, fillTokens, withDomain, vaPath, ssoUrl, isModuleUrl,
    uid, clone, el, WIDGETS, THEME_FIELDS, applyTheme, renderBlock, renderPage, setColorMode
  };
})();
