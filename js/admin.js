/* Admin dashboard: drag-and-drop page designer, user management, publishing. */
(async () => {
  const session = PH.requireAdmin();
  if (!session) return;

  const $ = (id) => document.getElementById(id);
  const { el } = PH;

  await PH.reconcileDrafts();
  const state = {
    layout: await PH.getLayout(),
    users: await PH.getUsers(),
    selectedId: null
  };

  // ---------- helpers ----------
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function updateStatus() {
    const draft = PH.draftState();
    const s = $('draftStatus');
    s.textContent = { none: 'All changes published', deploying: 'Published — GitHub Pages updating…', unpublished: '● Unpublished changes' }[draft];
    s.classList.toggle('clean', draft !== 'unpublished');
  }

  function saveLayout() {
    PH.writeLocal(PH.KEYS.layoutDraft, state.layout);
    updateStatus();
  }
  function saveUsers() {
    PH.writeLocal(PH.KEYS.usersDraft, state.users);
    updateStatus();
  }

  function download(name, data) {
    const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- tabs ----------
  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${tab.dataset.view}`));
    };
  });
  $('logoutBtn').onclick = () => { PH.clearSession(); location.href = 'index.html'; };

  // ---------- designer: palette ----------
  let dragPayload = null; // { kind: 'new', type } | { kind: 'move', id }

  for (const [type, def] of Object.entries(PH.WIDGETS)) {
    const item = el('div', { class: 'palette-item', draggable: 'true' }, [
      el('span', { class: 'icon', text: def.icon }), el('span', { text: def.label })
    ]);
    item.addEventListener('dragstart', (e) => {
      dragPayload = { kind: 'new', type };
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', type);
    });
    item.addEventListener('dragend', clearDropMarkers);
    item.addEventListener('click', () => insertBlock(type, state.layout.blocks.length));
    $('palette').append(item);
  }

  function newBlock(type) {
    return { id: PH.uid(), type, props: PH.clone(PH.WIDGETS[type].defaults) };
  }
  function insertBlock(type, index) {
    const block = newBlock(type);
    state.layout.blocks.splice(index, 0, block);
    state.selectedId = block.id;
    saveLayout();
    renderCanvas();
    renderProps();
  }
  function indexOf(id) { return state.layout.blocks.findIndex(b => b.id === id); }

  // ---------- designer: canvas ----------
  const canvas = $('canvas');
  let dropIndex = null;

  function renderCanvas() {
    PH.applyTheme(state.layout.theme, $('canvasFrame'));
    $('canvasTitle').textContent = state.layout.theme.siteTitle;

    if (!state.layout.blocks.length) {
      canvas.replaceChildren(el('div', { class: 'canvas-empty', text: 'Drag blocks here to build the main page' }));
      return;
    }
    canvas.replaceChildren(...state.layout.blocks.map((block, i) => {
      const node = PH.renderBlock(block, state.layout.theme);
      node.draggable = true;
      if (block.id === state.selectedId) node.classList.add('selected');

      const tools = el('div', { class: 'block-tools' }, [
        el('span', { class: 'type', text: PH.WIDGETS[block.type]?.label || block.type }),
        toolBtn('↑', 'Move up', () => move(i, i - 1)),
        toolBtn('↓', 'Move down', () => move(i, i + 1)),
        toolBtn('⧉', 'Duplicate', () => duplicate(i)),
        toolBtn('✕', 'Delete', () => remove(i))
      ]);
      node.append(tools);

      node.addEventListener('click', () => select(block.id));
      node.addEventListener('dragstart', (e) => {
        dragPayload = { kind: 'move', id: block.id };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', block.id);
        node.classList.add('dragging');
      });
      node.addEventListener('dragend', () => { node.classList.remove('dragging'); clearDropMarkers(); });
      return node;
    }));
  }

  function toolBtn(label, title, fn) {
    const b = el('button', { type: 'button', title, text: label });
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  }

  function clearDropMarkers() {
    canvas.classList.remove('drag-over-end');
    canvas.querySelectorAll('.drop-before, .drop-after').forEach(n =>
      n.classList.remove('drop-before', 'drop-after', 'vertical', 'horizontal'));
    dropIndex = null;
  }

  canvas.addEventListener('dragover', (e) => {
    if (!dragPayload) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dragPayload.kind === 'new' ? 'copy' : 'move';
    clearDropMarkers();

    const target = e.target.closest('.ph-block');
    if (!target) {
      dropIndex = state.layout.blocks.length;
      canvas.classList.add('drag-over-end');
      return;
    }
    const rect = target.getBoundingClientRect();
    // Blocks that share a row (narrow) use left/right halves; full-width blocks use top/bottom.
    const sideBySide = rect.width < canvas.clientWidth * 0.8;
    const after = sideBySide ? e.clientX > rect.left + rect.width / 2 : e.clientY > rect.top + rect.height / 2;
    target.classList.add(after ? 'drop-after' : 'drop-before', sideBySide ? 'horizontal' : 'vertical');
    dropIndex = indexOf(target.dataset.id) + (after ? 1 : 0);
  });
  canvas.addEventListener('dragleave', (e) => {
    if (!canvas.contains(e.relatedTarget)) clearDropMarkers();
  });
  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    const payload = dragPayload, index = dropIndex;
    dragPayload = null;
    clearDropMarkers();
    if (!payload || index === null) return;

    if (payload.kind === 'new') {
      insertBlock(payload.type, index);
    } else {
      const from = indexOf(payload.id);
      move(from, from < index ? index - 1 : index);
    }
  });

  // Clicking empty canvas space deselects (shows page settings).
  canvas.addEventListener('click', (e) => { if (!e.target.closest('.ph-block')) select(null); });

  function select(id) {
    state.selectedId = id;
    canvas.querySelectorAll('.ph-block').forEach(n => n.classList.toggle('selected', n.dataset.id === id));
    renderProps();
  }
  function move(from, to) {
    const blocks = state.layout.blocks;
    if (from < 0 || to < 0 || to >= blocks.length || from === to) return;
    blocks.splice(to, 0, blocks.splice(from, 1)[0]);
    saveLayout();
    renderCanvas();
  }
  function duplicate(i) {
    const copy = { ...PH.clone(state.layout.blocks[i]), id: PH.uid() };
    state.layout.blocks.splice(i + 1, 0, copy);
    state.selectedId = copy.id;
    saveLayout();
    renderCanvas();
    renderProps();
  }
  function remove(i) {
    const [gone] = state.layout.blocks.splice(i, 1);
    if (gone.id === state.selectedId) state.selectedId = null;
    saveLayout();
    renderCanvas();
    renderProps();
  }

  // ---------- designer: properties ----------
  function buildField(field, value, onChange) {
    const id = 'f_' + field.key;
    const wrap = el('div', { class: 'field' + (field.type === 'checkbox' ? ' checkbox' : '') });
    let input;

    if (field.type === 'textarea') {
      input = el('textarea', { id });
      input.value = value ?? '';
      input.oninput = () => onChange(input.value);
    } else if (field.type === 'select') {
      input = el('select', { id });
      for (const opt of field.options) {
        const o = typeof opt === 'object' ? opt : { value: opt, label: opt };
        const option = el('option', { value: o.value, text: o.label });
        if (String(o.value) === String(value)) option.selected = true;
        input.append(option);
      }
      input.onchange = () => {
        const isNum = field.options.some(o => typeof o === 'object' && typeof o.value === 'number');
        onChange(isNum ? Number(input.value) : input.value);
      };
    } else if (field.type === 'checkbox') {
      input = el('input', { id, type: 'checkbox' });
      input.checked = !!value;
      input.onchange = () => onChange(input.checked);
    } else if (field.type === 'number') {
      input = el('input', { id, type: 'number', min: field.min, max: field.max });
      input.value = value ?? '';
      input.oninput = () => { if (input.value !== '') onChange(Number(input.value)); };
    } else if (field.type === 'color') {
      // Colour picker + free text (allows blank = "inherit" and any CSS colour).
      const picker = el('input', { type: 'color' });
      const text = el('input', { id, type: 'text', placeholder: 'default' });
      text.value = value ?? '';
      if (/^#[0-9a-f]{6}$/i.test(value)) picker.value = value;
      picker.oninput = () => { text.value = picker.value; onChange(picker.value); };
      text.oninput = () => {
        if (/^#[0-9a-f]{6}$/i.test(text.value)) picker.value = text.value;
        onChange(text.value.trim());
      };
      input = el('div', { class: 'color-row' }, [picker, text]);
    } else {
      input = el('input', { id, type: 'text' });
      input.value = value ?? '';
      input.oninput = () => onChange(input.value);
    }

    const label = el('label', { for: id, text: field.label });
    if (field.type === 'checkbox') wrap.append(input, label);
    else wrap.append(label, input);
    return wrap;
  }

  function renderProps() {
    const panel = $('props');
    const block = state.layout.blocks.find(b => b.id === state.selectedId);

    if (!block) {
      $('propsTitle').textContent = 'Page settings';
      const theme = state.layout.theme;
      panel.replaceChildren(
        el('p', { class: 'muted', style: { fontSize: '13px', marginTop: 0 }, text: 'Select a block on the page to edit it.' }),
        ...PH.THEME_FIELDS.map(f => buildField(f, theme[f.key], (v) => {
          theme[f.key] = v;
          saveLayout();
          renderCanvas();
        }))
      );
      return;
    }

    const def = PH.WIDGETS[block.type];
    $('propsTitle').textContent = def ? def.label : block.type;
    const props = { ...(def?.defaults || {}), ...block.props };
    const i = indexOf(block.id);
    panel.replaceChildren(
      ...(def?.fields || []).map(f => buildField(f, props[f.key], (v) => {
        block.props[f.key] = v;
        saveLayout();
        renderCanvas();
      })),
      el('div', { class: 'props-actions' }, [
        actionBtn('Duplicate', '', () => duplicate(i)),
        actionBtn('Delete', 'btn-danger', () => remove(i)),
        actionBtn('Done', '', () => select(null))
      ])
    );
  }

  function actionBtn(text, cls, fn) {
    const b = el('button', { class: `btn btn-sm ${cls}`, type: 'button', text });
    b.onclick = fn;
    return b;
  }

  // ---------- users ----------
  function renderUsers() {
    $('userRows').replaceChildren(...state.users.map((u, i) => {
      const role = el('select', {}, ['User', 'Admin'].map(r => {
        const o = el('option', { text: r });
        if (r.toLowerCase() === String(u.role).toLowerCase()) o.selected = true;
        return o;
      }));
      role.style.width = 'auto';
      role.onchange = () => {
        if (u.role === 'Admin' && role.value !== 'Admin' && adminCount() === 1) {
          role.value = 'Admin';
          return showUserError('There must be at least one Admin.');
        }
        u.role = role.value;
        saveUsers();
      };
      const del = actionBtn('Remove', 'btn-danger', () => {
        if (String(u.role).toLowerCase() === 'admin' && adminCount() === 1) return showUserError('There must be at least one Admin.');
        if (!confirm(`Remove user "${u.username}"?`)) return;
        state.users.splice(i, 1);
        saveUsers();
        renderUsers();
      });
      return el('tr', {}, [el('td', { text: u.username }), el('td', {}, role), el('td', {}, del)]);
    }));
  }
  function adminCount() { return state.users.filter(u => String(u.role).toLowerCase() === 'admin').length; }
  function showUserError(msg) { $('userError').textContent = msg; }

  $('addUserForm').addEventListener('submit', (e) => {
    e.preventDefault();
    showUserError('');
    const username = $('newUsername').value.trim();
    if (!username) return;
    if (state.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
      return showUserError('That username already exists.');
    }
    state.users.push({ username, role: $('newRole').value });
    $('newUsername').value = '';
    saveUsers();
    renderUsers();
    toast(`Added ${username}`);
  });

  // ---------- publish ----------
  const gh = PH.readLocal(PH.KEYS.github) || {};
  // Guess owner/repo when hosted at https://<owner>.github.io/<repo>/
  const pagesHost = location.hostname.match(/^([^.]+)\.github\.io$/i);
  $('ghOwner').value = gh.owner || (pagesHost ? pagesHost[1] : '');
  $('ghRepo').value = gh.repo || (pagesHost ? (location.pathname.split('/')[1] || `${pagesHost[1]}.github.io`) : '');
  $('ghBranch').value = gh.branch || 'main';
  $('ghToken').value = gh.token || '';
  $('ghRemember').checked = !!gh.token;

  function log(msg) { $('publishLog').textContent += msg + '\n'; }

  function toBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async function putFile(cfg, path, data) {
    const api = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}`;
    const headers = { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' };

    const existing = await fetch(`${api}?ref=${encodeURIComponent(cfg.branch)}`, { headers, cache: 'no-store' });
    if (!existing.ok && existing.status !== 404) throw new Error(`${path}: ${existing.status} ${(await existing.json()).message}`);
    const sha = existing.ok ? (await existing.json()).sha : undefined;

    const res = await fetch(api, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `Update ${path} via admin dashboard (${session.username})`,
        content: toBase64(JSON.stringify(data, null, 2) + '\n'),
        branch: cfg.branch,
        sha
      })
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.json()).message}`);
  }

  // GitHub settings from the Publish tab; null if incomplete. Remembers them (token only if ticked).
  function ghConfig() {
    const cfg = {
      owner: $('ghOwner').value.trim(),
      repo: $('ghRepo').value.trim(),
      branch: $('ghBranch').value.trim() || 'main',
      token: $('ghToken').value.trim()
    };
    if (!cfg.owner || !cfg.repo || !cfg.token) return null;
    PH.writeLocal(PH.KEYS.github, { ...cfg, token: $('ghRemember').checked ? cfg.token : '' });
    return cfg;
  }

  $('publishBtn').onclick = async () => {
    const cfg = ghConfig();
    if (!cfg) { $('publishLog').textContent = 'Owner, repository and token are required.'; return; }

    $('publishLog').textContent = '';
    $('publishBtn').disabled = true;
    try {
      log('Publishing data/layout.json…');
      await putFile(cfg, 'data/layout.json', state.layout);
      log('Publishing data/users.json…');
      await putFile(cfg, 'data/users.json', state.users);
      PH.writeLocal(PH.KEYS.lastPublished, { layout: JSON.stringify(state.layout), users: JSON.stringify(state.users) });
      updateStatus();
      log('✔ Published. GitHub Pages usually updates within 1–5 minutes.');
      log('  Drafts in this browser are cleared automatically once the live site matches.');
      toast('Published');
    } catch (err) {
      log('✖ ' + err.message);
    } finally {
      $('publishBtn').disabled = false;
    }
  };

  // ---------- VA (paste from Excel or upload CSV → data/va.json) ----------
  // Built for large sheets (tens of MB): pasted text never goes into the textarea, the preview shows only
  // the first rows, rows are stored as arrays (column names once), and saving uses the Git Data API (≤100 MB).
  const VA_PATH = 'data/va.json';
  const VA_PREVIEW_ROWS = 100;
  const GITHUB_MAX_BYTES = 100 * 1024 * 1024;
  let vaData = null;    // { updatedAt, updatedBy, columns, rows: [[...], ...] }
  let vaLoaded = false; // the saved file is only fetched when the VA tab is first opened
  let vaPending = false; // true while vaData holds pasted (unsaved) rows; further pastes are appended
  let vaHeadRaw = '';    // header row as pasted, to skip it when a later batch repeats it

  const fmtBytes = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  // Give the browser a moment to show the "Reading…" message before the (blocking) parse starts.
  const nextPaint = () => new Promise(r => setTimeout(r, 50));
  function vaStatus(msg) { $('vaInfo').textContent = msg; }

  // Guess the delimiter from the first line: Excel paste/TSV = tab, CSV = comma (or ";" in some locales).
  function detectDelimiter(text) {
    const first = text.slice(0, text.indexOf('\n') === -1 ? 2000 : text.indexOf('\n'));
    const counts = { '\t': first.split('\t').length, ',': first.split(',').length, ';': first.split(';').length };
    return Object.keys(counts).reduce((a, b) => counts[b] > counts[a] ? b : a);
  }

  // Delimited-text parser. Cells containing the delimiter/newlines/quotes are wrapped in "…" with "" escapes.
  // Uses indexOf/slice instead of per-character string building so tens of MB parse in about a second.
  function parseDelimited(text, d) {
    const rows = [];
    const n = text.length;
    let row = [], i = 0;
    while (i < n) {
      if (text[i] === '"') {
        let j = i + 1, cell = '';
        for (;;) {
          const q = text.indexOf('"', j);
          if (q === -1) { cell += text.slice(j); i = n; break; }
          cell += text.slice(j, q);
          if (text[q + 1] === '"') { cell += '"'; j = q + 2; } else { i = q + 1; break; }
        }
        row.push(cell);
      } else {
        let k = i;
        while (k < n) { const c = text[k]; if (c === d || c === '\n' || c === '\r') break; k++; }
        row.push(text.slice(i, k));
        i = k;
      }
      const c = text[i];
      if (c === d) { i++; if (i === n) row.push(''); }
      else if (c === '\r' || c === '\n') { i += (c === '\r' && text[i + 1] === '\n') ? 2 : 1; rows.push(row); row = []; }
    }
    if (row.length) rows.push(row);
    return rows;
  }

  // Non-blank rows of delimited text, cells trimmed.
  function parseRows(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // Excel "CSV UTF-8" starts with a byte-order mark
    return parseDelimited(text, detectDelimiter(text))
      .filter(r => r.some(v => v.trim() !== ''))
      .map(r => r.map(v => v.trim()));
  }
  const padRow = (r, width) => { const out = r.slice(0, width); while (out.length < width) out.push(''); return out; };

  // First row = headers (blank → "Column N", duplicates get " (2)"); rows padded to the widest row.
  function toVaData(all) {
    const head = all[0];
    if (!head) return null;
    let width = 0;
    for (const r of all) if (r.length > width) width = r.length;
    const seen = {};
    const columns = Array.from({ length: width }, (_, i) => {
      const base = head[i] || `Column ${i + 1}`;
      seen[base] = (seen[base] || 0) + 1;
      return seen[base] > 1 ? `${base} (${seen[base]})` : base;
    });
    vaHeadRaw = padRow(head, width).join('\t');
    return { updatedAt: new Date().toISOString(), updatedBy: session.username, columns, rows: all.slice(1).map(r => padRow(r, width)) };
  }

  // Later batches: skip a repeated header row, then add the rows under the existing columns.
  function appendVaRows(all) {
    const width = vaData.columns.length;
    if (all.length && padRow(all[0], width).join('\t') === vaHeadRaw) all = all.slice(1);
    const wide = all.find(r => r.length > width && r.slice(width).some(v => v !== ''));
    if (wide) throw new Error(`this batch has ${wide.length} columns but the first batch had ${width} — copy the same columns each time`);
    for (const r of all) vaData.rows.push(padRow(r, width));
    return all.length;
  }

  // Older va.json files stored each row as an object; convert to arrays.
  function normalizeVa(d) {
    if (d && d.rows.length && !Array.isArray(d.rows[0])) d.rows = d.rows.map(r => d.columns.map(c => r[c] ?? ''));
    return d;
  }

  function renderVaTable(d) {
    const table = $('vaTable');
    if (!d || !d.rows.length) { table.replaceChildren(); return; }
    table.replaceChildren(
      el('thead', {}, el('tr', {}, d.columns.map(c => el('th', { text: c })))),
      el('tbody', {}, d.rows.slice(0, VA_PREVIEW_ROWS).map(r => el('tr', {}, r.map(v => el('td', { text: v })))))
    );
  }

  function describeVa(d) {
    const shown = d.rows.length > VA_PREVIEW_ROWS ? ` (showing first ${VA_PREVIEW_ROWS})` : '';
    return `${d.rows.length.toLocaleString()} row${d.rows.length === 1 ? '' : 's'} × ${d.columns.length} columns${shown}`;
  }

  // The first paste starts a new data set (header row + data); later pastes add rows to it,
  // so a big sheet can be copied in batches. "Start over" begins a new data set.
  async function loadVaText(text, source) {
    if (!text || !text.trim()) { vaStatus('The clipboard has no text — copy the cells in Excel first.'); return; }
    vaStatus(`Reading ${fmtBytes(text.length)} from ${source}…`);
    await nextPaint();
    let added;
    try {
      const rows = parseRows(text);
      if (vaPending && vaData) {
        added = appendVaRows(rows);
      } else {
        vaData = toVaData(rows);
        vaPending = !!vaData;
        added = vaData ? vaData.rows.length : 0;
      }
    } catch (err) {
      vaStatus(`✖ Could not read the data: ${err.message}.`);
      return;
    }
    renderVaTable(vaData);
    $('vaResetBtn').hidden = !vaPending;
    vaStatus(!vaData ? 'No rows found.'
      : !vaData.rows.length ? 'Only a header row was found — include the data rows too.'
      : `Added ${added.toLocaleString()} rows. Total: ${describeVa(vaData)} — not saved yet. Paste more rows to add them, or click Save.`);
  }

  // Ctrl+V: read only the plain-text version of the clipboard; it never goes into the textarea.
  $('vaPaste').addEventListener('paste', (e) => {
    e.preventDefault();
    loadVaText(e.clipboardData.getData('text/plain'), 'clipboard');
  });
  // Button: Clipboard API reads text only, skipping Excel's much larger HTML copy (can freeze Ctrl+V on big ranges).
  $('vaClipboardBtn').onclick = async () => {
    if (!navigator.clipboard?.readText) { vaStatus('This browser can’t read the clipboard from a button — click the box and press Ctrl+V instead.'); return; }
    vaStatus('Reading clipboard… (allow clipboard access if the browser asks)');
    try {
      loadVaText(await navigator.clipboard.readText(), 'clipboard');
    } catch (err) {
      vaStatus(`✖ Clipboard access was blocked (${err.message}). Click the box and press Ctrl+V instead.`);
    }
  };
  $('vaResetBtn').onclick = () => {
    vaData = null;
    vaPending = false;
    vaHeadRaw = '';
    renderVaTable(null);
    $('vaResetBtn').hidden = true;
    vaStatus('Cleared. Paste the first batch including the header row.');
  };
  $('vaPaste').addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) && e.key.length === 1) e.preventDefault(); // paste-only box
  });
  $('vaFile').onchange = async () => {
    const file = $('vaFile').files[0];
    $('vaFile').value = '';
    if (file) { vaPending = false; loadVaText(await file.text(), file.name); }
  };

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  // Commit one (possibly large) file via the Git Data API: blob → tree → commit → move branch.
  async function commitLargeFile(cfg, path, blob, message) {
    const api = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
    const headers = { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' };
    const call = async (method, url, body) => {
      const res = await fetch(api + url, { method, headers, body: body && JSON.stringify(body), cache: 'no-store' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${res.status} ${json.message || res.statusText}`);
      return json;
    };
    const ref = `heads/${cfg.branch}`;
    vaStatus('Saving… (1/4) reading branch');
    const head = await call('GET', `/git/ref/${ref}`);
    const parent = await call('GET', `/git/commits/${head.object.sha}`);
    vaStatus(`Saving… (2/4) uploading ${fmtBytes(blob.size)}`);
    const content = await blobToBase64(blob);
    const blobRes = await call('POST', '/git/blobs', { content, encoding: 'base64' });
    vaStatus('Saving… (3/4) creating commit');
    const tree = await call('POST', '/git/trees', { base_tree: parent.tree.sha, tree: [{ path, mode: '100644', type: 'blob', sha: blobRes.sha }] });
    const commit = await call('POST', '/git/commits', { message, tree: tree.sha, parents: [head.object.sha] });
    vaStatus('Saving… (4/4) updating branch');
    await call('PATCH', `/git/refs/${ref}`, { sha: commit.sha });
  }

  function vaBlob() {
    vaData.updatedAt = new Date().toISOString();
    return new Blob([JSON.stringify(vaData)], { type: 'application/json' });
  }

  $('vaSaveBtn').onclick = async () => {
    if (!vaData?.rows.length) { vaStatus('Paste the Excel rows (including the header row) or choose a CSV file first.'); return; }
    const cfg = ghConfig();
    if (!cfg) { vaStatus('Saving needs the GitHub owner, repository and token — fill them in on the Publish tab, or use Download JSON.'); return; }
    const blob = vaBlob();
    if (blob.size > GITHUB_MAX_BYTES) {
      vaStatus(`✖ The JSON is ${fmtBytes(blob.size)}; GitHub allows at most 100 MB per file. Remove unneeded columns/rows in Excel and try again.`);
      return;
    }
    $('vaSaveBtn').disabled = true;
    try {
      await commitLargeFile(cfg, VA_PATH, blob, `Update ${VA_PATH} via admin dashboard (${session.username})`);
      vaPending = false; // the next paste starts a new data set
      $('vaResetBtn').hidden = true;
      vaStatus(`✔ Saved ${fmtBytes(blob.size)} to ${VA_PATH}: ${describeVa(vaData)}.`);
      toast('VA saved');
    } catch (err) {
      vaStatus('✖ Save failed: ' + err.message);
    } finally {
      $('vaSaveBtn').disabled = false;
    }
  };
  $('vaDownloadBtn').onclick = () => {
    if (!vaData?.rows.length) { vaStatus('Nothing to download yet.'); return; }
    const a = el('a', { href: URL.createObjectURL(vaBlob()), download: 'va.json' });
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Load the saved file only when the VA tab is opened (it can be large).
  document.querySelector('.tab[data-view="va"]').addEventListener('click', () => {
    if (vaLoaded) return;
    vaLoaded = true;
    vaStatus('Loading saved VA data…');
    PH.fetchJSON(VA_PATH).then(d => {
      if (vaPending) return; // don't replace rows the user has already pasted
      vaData = normalizeVa(d);
      renderVaTable(vaData);
      const when = d.updatedAt ? ` · last saved ${new Date(d.updatedAt).toLocaleString()}${d.updatedBy ? ' by ' + d.updatedBy : ''}` : '';
      vaStatus(`Current: ${describeVa(vaData)}${when}`);
    }).catch(() => vaStatus('Nothing saved yet.'));
  });

  $('exportLayoutBtn').onclick = () => download('layout.json', state.layout);
  $('exportUsersBtn').onclick = () => download('users.json', state.users);
  $('importLayoutBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = async () => {
    const file = $('importFile').files[0];
    $('importFile').value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data.theme || !Array.isArray(data.blocks)) throw new Error('Expected { theme, blocks }');
      state.layout = data;
      state.selectedId = null;
      saveLayout();
      renderCanvas();
      renderProps();
      toast('Layout imported');
    } catch (err) {
      alert('Invalid layout file: ' + err.message);
    }
  };
  $('discardBtn').onclick = async () => {
    if (!confirm('Discard all unpublished changes in this browser?')) return;
    PH.writeLocal(PH.KEYS.layoutDraft, null);
    PH.writeLocal(PH.KEYS.usersDraft, null);
    state.layout = await PH.getPublishedLayout();
    state.users = await PH.getPublishedUsers();
    state.selectedId = null;
    renderCanvas();
    renderProps();
    renderUsers();
    updateStatus();
    toast('Drafts discarded');
  };

  // ---------- init ----------
  renderCanvas();
  renderProps();
  renderUsers();
  updateStatus();
})();
