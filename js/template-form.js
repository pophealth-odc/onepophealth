/* Shared engine for approval-email templates (Emergency Change, Pre-Approved Change, …).
   A page calls PHTemplate.mount(config); the engine builds the form, keeps a per-browser draft,
   generates Outlook-ready HTML and copies it to the clipboard. */
const PHTemplate = (() => {
  const { el } = PH;
  const $ = (id) => document.getElementById(id);

  // ---------- text helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const linkify = (html) => html.replace(/https?:\/\/[^\s<]+[^\s<.,;:)]/g, url => `<a href="${url}" style="color:#0563c1;">${url}</a>`);
  const lines = (s) => linkify(esc(s).replace(/\r?\n/g, '<br>'));
  // "1st" -> 1<sup>st</sup> (expects already-escaped HTML)
  const ordinals = (html) => html.replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1<sup>$2</sup>');
  // One item per line; leading "-", "•", "1." etc. removed.
  const listItems = (s) => String(s || '').split('\n').map(x => x.replace(/^\s*([-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
  // "A", "A and B", "A, B and C"
  const joinItems = (items) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

  // el() drops empty attributes, so set the placeholder option's empty value directly.
  function blankOption(text) { const o = el('option', { text }); o.value = ''; return o; }

  // ---------- date/time windows ----------
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pad = (n) => String(n).padStart(2, '0');

  // '2026-09-17', '21:00' -> '17-Sep-26 (Thu) 21:00'
  function formatPoint(date, time) {
    if (!date) return '';
    const [y, m, d] = date.split('-').map(Number);
    const day = DAYS[new Date(y, m - 1, d).getDay()];
    return `${pad(d)}-${MONTHS[m - 1]}-${String(y).slice(-2)} (${day})${time ? ' ' + time : ''}`;
  }
  function formatRange(w) {
    const start = formatPoint(w.startDate, w.startTime), end = formatPoint(w.endDate, w.endTime);
    return start && end ? `${start} to ${end}` : start || end;
  }
  function windowError(w, label) {
    if (!w.startDate || !w.endDate) return '';
    const start = `${w.startDate}T${w.startTime || '00:00'}`, end = `${w.endDate}T${w.endTime || '00:00'}`;
    if (end > start) return '';
    const what = w.endDate < w.startDate ? 'End date cannot be before the start date' : 'End time must be after the start time';
    return label ? `${label}: ${what.toLowerCase()}.` : `⚠ ${what}.`;
  }

  // 24-hour time picker: hour and minute selects (browser time inputs may show AM/PM).
  function timePicker(value, onChange) {
    const [h, m] = (value || '').split(':');
    const hour = el('select', { class: 'ecr-time', title: 'Hour (24h)' },
      [blankOption('HH'), ...Array.from({ length: 24 }, (_, i) => el('option', { text: pad(i) }))]);
    const min = el('select', { class: 'ecr-time', title: 'Minute' },
      [blankOption('MM'), ...Array.from({ length: 12 }, (_, i) => el('option', { text: pad(i * 5) }))]);
    hour.value = h || '';
    min.value = m || '';
    const update = () => {
      if (hour.value && !min.value) min.value = '00';
      onChange(hour.value ? `${hour.value}:${min.value}` : '');
    };
    hour.onchange = update;
    min.onchange = update;
    const node = el('span', { class: 'ecr-timepair' }, [hour, el('span', { text: ':' }), min]);
    Object.assign(node, { hour, min });
    return node;
  }

  // Grey out end-time options at or before the start time (only matters when both are on the same day).
  function limitEndTime(endPicker, w) {
    const sameDay = w.startDate && w.startDate === w.endDate && w.startTime;
    const [sh, sm] = sameDay ? w.startTime.split(':') : [];
    for (const o of endPicker.hour.options) o.disabled = !!sameDay && o.value !== '' && o.value < sh;
    const sameHour = sameDay && endPicker.hour.value === sh;
    for (const o of endPicker.min.options) o.disabled = !!sameHour && o.value !== '' && o.value <= sm;
  }

  // ---------- email styling (inline only — Outlook ignores <style> blocks) ----------
  const FONT = 'font-family:Arial,sans-serif;font-size:10pt;color:#000;';
  const CELL = `${FONT}border:1px solid #000;padding:3px 5px;vertical-align:middle;`;
  const BLUE = '#5b9bd5';
  const STATUSES = ['Pending Approval', 'Approved', 'Rejected'];

  function mount(cfg) {
    const session = PH.requireLogin();
    if (!session) return;

    $('userChip').textContent = `${session.username} · ${session.role}`;
    if (PH.isAdmin(session)) $('adminBtn').hidden = false;
    $('logoutBtn').onclick = () => { PH.clearSession(); location.href = 'index.html'; };
    document.title = cfg.title;
    $('siteTitle').textContent = cfg.shortTitle || cfg.title;

    // Reload if the user's role or domain changed in Admin → Users since they signed in.
    PH.refreshSession().then(s => { if (s && (s.role !== session.role || s.domain !== session.domain)) location.reload(); });
    // Hidden until the domain check (from the published settings) passes.
    $('app').hidden = true;
    PH.getLayout().then(layout => PH.requireDomain(session, PH.pageDomains(layout, 'templates'), $('app')))
      .catch(() => true)
      .finally(() => { $('app').hidden = false; });

    const colors ={ light: '#e9eef7', dark: '#d0dcef', ...cfg.colors };
    const subjectFields = cfg.subjectFields || [];
    const introFields = cfg.introFields || [];
    const allFields = [...subjectFields, ...introFields, ...cfg.fields];
    const canSubmit = PH.can(session, 'submit');

    const data = Object.assign(
      { approvals: cfg.approvers.map(division => ({ division, name: '', status: STATUSES[0], attachment: '' })) },
      PH.readLocal(cfg.draftKey) || {}
    );
    // Window fields are objects; older drafts stored free text, which becomes the note.
    for (const f of allFields) {
      if (f.type === 'window' && typeof data[f.key] !== 'object') data[f.key] = { note: data[f.key] || '' };
    }
    const onSave = []; // e.g. the live subject preview
    const save = () => { PH.writeLocal(cfg.draftKey, data); onSave.forEach(fn => fn()); };

    // The approver who still needs to approve: first one not yet Approved (the last one if all have).
    const addressee = () => data.approvals.find(a => a.status !== 'Approved') || data.approvals[data.approvals.length - 1];

    // ---------- inputs ----------
    function input(key, { multiline, placeholder, rows, example } = {}) {
      const node = multiline ? el('textarea', { rows: rows || 2, placeholder: example || placeholder }) : el('input', { placeholder: example || placeholder });
      node.value = data[key] || '';
      node.oninput = () => { data[key] = node.value; save(); };
      if (example) useExampleOnTab(node);
      return node;
    }

    // Tab in an empty field fills in the grey example (and stays there to edit); the next Tab moves on.
    function useExampleOnTab(node) {
      node.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab' || e.shiftKey || node.value !== '' || !node.placeholder) return;
        e.preventDefault();
        node.value = node.placeholder;
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.setSelectionRange?.(node.value.length, node.value.length);
      });
    }

    function windowInput(key, noteExample) {
      const w = data[key];
      const preview = el('div', { class: 'ecr-window-preview' });
      const warning = el('div', { class: 'ecr-window-warning' });
      const pickers = {};
      const refresh = () => {
        save();
        preview.textContent = formatRange(w) || 'Pick start and end date/time';
        // The end calendar can't go earlier than the start date; end times are limited on the same day.
        if (pickers.end) {
          pickers.end.date.min = w.startDate || '';
          limitEndTime(pickers.end.time, w);
        }
        warning.textContent = windowError(w, '');
        warning.hidden = !warning.textContent;
      };
      const point = (prefix, label) => {
        const date = el('input', { type: 'date' });
        date.value = w[prefix + 'Date'] || '';
        date.oninput = () => { w[prefix + 'Date'] = date.value; refresh(); };
        const time = timePicker(w[prefix + 'Time'], (t) => { w[prefix + 'Time'] = t; refresh(); });
        pickers[prefix] = { date, time };
        return el('div', { class: 'ecr-window-point' }, [el('span', { class: 'ecr-window-label', text: label }), date, time]);
      };
      const note = el('input', { placeholder: noteExample || 'Note (optional)' });
      note.value = w.note || '';
      note.oninput = () => { w.note = note.value; save(); };
      if (noteExample) useExampleOnTab(note);
      const nodes = [point('start', 'Start'), point('end', 'End'), preview, warning, note];
      refresh();
      return nodes;
    }

    const ctx = { data, save, input, esc, lines, ordinals, listItems, joinItems, blankOption, addressee };

    function fieldInput(f) {
      if (f.type === 'custom') return f.render(ctx);
      if (f.type === 'window') return windowInput(f.key, f.noteExample);
      if (f.type === 'list') return input(f.key, { multiline: true, rows: f.rows || 2, placeholder: f.placeholder, example: f.example });
      if (f.type === 'select') {
        const node = el('select', {}, f.options.map(o => el('option', { text: o })));
        if (!f.options.includes(data[f.key])) data[f.key] = f.options[0];
        node.value = data[f.key];
        node.onchange = () => { data[f.key] = node.value; save(); };
        return node;
      }
      return input(f.key, f);
    }
    const cellBg = (f) => f.bg || (f.shade ? colors.dark : colors.light);

    function fieldHtml(f) {
      if (f.type === 'custom') return f.html(ctx);
      if (f.type === 'window') return [esc(formatRange(data[f.key])), lines(data[f.key].note)].filter(Boolean).join('<br>');
      if (f.type === 'list') return listItems(data[f.key]).map(esc).join('<br>');
      return lines(data[f.key]);
    }
    function fieldText(f) {
      if (f.type === 'custom') return f.text(ctx);
      if (f.type === 'window') return [formatRange(data[f.key]), data[f.key].note].filter(Boolean).join(' – ');
      if (f.type === 'list') return listItems(data[f.key]).join(', ');
      return data[f.key] || '';
    }

    // ---------- page ----------
    const rows = (fields) => fields.map(f => {
      const cell = el('td', {}, fieldInput(f));
      cell.style.background = cellBg(f);
      return el('tr', {}, [el('th', {}, [el('span', { text: f.label }), f.hint ? el('div', { class: 'ecr-field-hint', text: f.hint }) : null]), cell]);
    });

    const approvalRows = el('tbody');
    const error = el('div', { class: 'error' });
    // Preview is view-only: the email can only be copied from My requests once approved.
    const preview = el('div', { class: 'ecr-preview ecr-preview-locked', title: 'Preview only — copy is available after approval' });
    for (const evt of ['copy', 'cut', 'contextmenu', 'dragstart', 'selectstart']) preview.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt === 'copy' || evt === 'cut' || evt === 'contextmenu') toast('Preview only — you can copy the email after it is approved');
    });
    const previewWrap = el('section', {}, [
      el('div', { class: 'ecr-preview-head' }, [
        el('h3', { class: 'ecr-sub', text: 'Email preview (not approved — copying is disabled)' }),
        button('Close preview', 'btn btn-sm', () => { previewWrap.hidden = true; preview.replaceChildren(); })
      ]),
      preview
    ]);
    previewWrap.hidden = true;

    function button(text, cls, onClick) {
      const b = el('button', { class: cls, type: 'button', text });
      b.onclick = onClick;
      return b;
    }

    const infoHead = el('thead', {}, el('tr', {}, [el('th', { text: 'Information' }), el('th', { text: 'Description' })]));
    if (cfg.headerAlign === 'left') infoHead.classList.add('align-left');

    const subjectPreview = el('div', { class: 'ecr-subject-preview' });
    const refreshSubject = () => { subjectPreview.textContent = cfg.subject(ctx); };
    onSave.push(refreshSubject);
    const myRequests = el('div', { class: 'req-list' });

    $('app').replaceChildren(...[ // optional sections are null; filtered out below so they don't print as "null"
      el('h1', { text: cfg.title }),
      el('p', { class: 'muted', text: canSubmit
        ? 'Fill in the form and click Submit for approval. Once an Approver approves it, the email unlocks under My requests — copy it there and paste into Outlook (Ctrl+V). Tip: press Tab in an empty field to use its grey example.'
        : `Your role (${session.role}) can view this template but not submit change requests.` }),
      subjectFields.length ? el('h3', { class: 'ecr-sub', text: 'Email subject' }) : null,
      subjectFields.length ? el('table', { class: 'ecr-table ecr-intro' }, el('tbody', {}, [
        ...rows(subjectFields),
        el('tr', {}, [el('th', { text: 'Subject (preview)' }), el('td', {}, subjectPreview)])
      ])) : null,
      introFields.length ? el('h3', { class: 'ecr-sub', text: 'Email intro' }) : null,
      introFields.length ? el('table', { class: 'ecr-table ecr-intro' }, el('tbody', {}, rows(introFields))) : null,
      introFields.length ? el('h3', { class: 'ecr-sub', text: 'Details' }) : null,
      el('table', { class: 'ecr-table' }, [infoHead, el('tbody', {}, rows(cfg.fields))]),
      el('h3', { class: 'ecr-sub', text: cfg.approvalsTitle }),
      el('table', { class: 'ecr-table ecr-approval' }, [
        el('thead', {}, el('tr', {}, ['Name', 'Division/Synapxe', 'Status of Approval', 'Email Attachment', '']
          .map((t, i) => el('th', { text: t, class: i === 4 ? 'ecr-x' : undefined })))),
        approvalRows
      ]),
      button('+ Add approver', 'btn btn-sm', () => {
        data.approvals.push({ division: '', name: '', status: STATUSES[0], attachment: '', custom: true });
        save();
        renderApprovals();
      }),
      el('p', { class: 'muted ecr-hint', text: 'The email is addressed to the first approver whose status is not Approved.' }),
      error,
      el('div', { class: 'props-actions' }, [
        canSubmit ? button('Submit for approval', 'btn btn-primary', submit) : null,
        button('Preview email', 'btn', showPreview),
        button('Clear form', 'btn btn-danger', () => {
          if (!confirm('Clear all fields?')) return;
          PH.writeLocal(cfg.draftKey, null);
          location.reload();
        })
      ]),
      previewWrap,
      canSubmit ? el('div', { class: 'req-head' }, [
        el('h3', { class: 'ecr-sub', text: 'My requests' }),
        button('↻ Refresh', 'btn btn-sm', loadMyRequests)
      ]) : null,
      canSubmit ? myRequests : null
    ].filter(Boolean));
    refreshSubject();

    function renderApprovals() {
      approvalRows.replaceChildren(...data.approvals.map((a, i) => {
        const name = el('input', { placeholder: 'Name' });
        name.value = a.name;
        name.oninput = () => { a.name = name.value; save(); };
        const status = el('select', {}, STATUSES.map(s => el('option', { text: s })));
        status.value = a.status;
        status.onchange = () => { a.status = status.value; save(); };
        const attach = el('input', { placeholder: 'optional' });
        attach.value = a.attachment;
        attach.oninput = () => { a.attachment = attach.value; save(); };

        let division = el('td', { text: a.division });
        if (a.custom) {
          const d = el('input', { placeholder: 'Division / role' });
          d.value = a.division;
          d.oninput = () => { a.division = d.value; save(); };
          division = el('td', {}, d);
        }
        const remove = button('✕', 'ecr-remove', () => { data.approvals.splice(i, 1); save(); renderApprovals(); });
        remove.title = 'Remove approver';

        return el('tr', {}, [el('td', {}, name), division, el('td', {}, status), el('td', {}, attach), el('td', { class: 'ecr-x' }, remove)]);
      }));
    }
    renderApprovals();

    // ---------- email ----------
    function buildEmailHtml() {
      const headAlign = cfg.headerAlign === 'left' ? 'left' : 'center';
      const infoRowsHtml = cfg.fields.map(f => `<tr>
        <td style="${CELL}background:${BLUE};font-weight:bold;width:260px;">${esc(f.label).replace(/\n/g, '<br>')}</td>
        <td style="${CELL}background:${cellBg(f)};">${fieldHtml(f) || '&nbsp;'}</td>
      </tr>`).join('');
      const approvalRowsHtml = data.approvals.map(a => `<tr>
        <td style="${CELL}">${esc(a.name) || '&nbsp;'}</td>
        <td style="${CELL}">${esc(a.division)}</td>
        <td style="${CELL}white-space:nowrap;">${esc(a.status)}</td>
        <td style="${CELL}">${esc(a.attachment) || '&nbsp;'}</td>
      </tr>`).join('');
      const title = cfg.approvalsUnderline ? `<b><u>${esc(cfg.approvalsTitle)}</u></b>` : `<b>${esc(cfg.approvalsTitle)}</b>`;

      return `<div style="${FONT}">
      <p style="${FONT}margin:0 0 12px;">Dear ${esc(addressee().name)},</p>
      <p style="${FONT}margin:0 0 12px;">${cfg.introHtml(ctx)}</p>
      <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:760px;">
        <tr>
          <td style="${CELL}background:${BLUE};font-weight:bold;text-align:${headAlign};width:260px;">Information</td>
          <td style="${CELL}background:${BLUE};font-weight:bold;text-align:${headAlign};">Description</td>
        </tr>
        ${infoRowsHtml}
      </table>
      <p style="${FONT}margin:16px 0 4px;">${title}</p>
      <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:700px;">
        <tr>
          <td style="${CELL}font-weight:bold;width:140px;">Name</td>
          <td style="${CELL}font-weight:bold;width:160px;">Division/Synapxe</td>
          <td style="${CELL}font-weight:bold;width:130px;white-space:nowrap;">Status of Approval</td>
          <td style="${CELL}font-weight:bold;">Email Attachment</td>
        </tr>
        ${approvalRowsHtml}
      </table>
    </div>`;
    }

    function buildEmailText() {
      const out = [`Dear ${addressee().name},`, '', cfg.introText(ctx), ''];
      for (const f of cfg.fields) out.push(`${f.label.replace(/\n/g, ' ')}: ${fieldText(f)}`);
      out.push('', cfg.approvalsTitle);
      for (const a of data.approvals) out.push(`${a.name} | ${a.division} | ${a.status} | ${a.attachment}`);
      return out.join('\n');
    }

    // ---------- actions ----------
    function validate() {
      const missing = cfg.validate(ctx);
      const to = addressee();
      if (!to) missing.push('at least one approver');
      else if (!to.name.trim()) missing.push(`${to.division || 'approver'} name`);
      const errors = [
        missing.length ? `Please fill in: ${missing.join(', ')}.` : '',
        ...allFields.filter(f => f.type === 'window').map(f => windowError(data[f.key], f.label.split(/[\n(]/)[0].trim()))
      ].filter(Boolean);
      error.textContent = errors.join(' ');
      return !errors.length;
    }

    function showPreview() {
      if (!validate()) return;
      preview.innerHTML = buildEmailHtml(); // built by this page from escaped form values
      previewWrap.hidden = false;
      previewWrap.scrollIntoView({ behavior: 'smooth' });
    }

    async function submit(e) {
      if (!validate()) return;
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const db = await PH.approvalsDb();
        await db.insert({
          type: cfg.type, ticket: cfg.ticket(ctx), subject: cfg.subject(ctx), form: JSON.parse(JSON.stringify(data)),
          email_html: buildEmailHtml(), email_text: buildEmailText(), submitted_by: session.username, status: 'pending'
        });
        toast('✔ Submitted — waiting for an Approver');
        await loadMyRequests();
        myRequests.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) {
        error.textContent = `✖ Could not submit: ${err.message}`;
      } finally {
        btn.disabled = false;
      }
    }


    // ---------- my requests ----------
    async function loadMyRequests() {
      if (!canSubmit) return;
      myRequests.replaceChildren(el('div', { class: 'muted', text: 'Loading…' }));
      try {
        const db = await PH.approvalsDb();
        const list = await db.list(`select=*&type=eq.${cfg.type}&submitted_by=eq.${encodeURIComponent(session.username)}&order=submitted_at.desc&limit=50`);
        myRequests.replaceChildren(...(list.length ? list.map(requestCard) : [el('div', { class: 'muted', text: 'No requests yet.' })]));
      } catch (err) {
        myRequests.replaceChildren(el('div', { class: 'muted', text: err.message }));
      }
    }

    function requestCard(r) {
      const when = (t) => t ? new Date(t).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '';
      const status = { pending: 'Pending approval', approved: 'Approved', rejected: 'Rejected' }[r.status] || r.status;
      const actions = [];
      if (r.status === 'approved') {
        actions.push(
          button('Copy email', 'btn btn-primary btn-sm', async () => {
            const ok = await copyRich(r.email_html, r.email_text, null);
            toast(ok ? 'Email copied — paste into Outlook with Ctrl+V' : 'Copy failed — your browser blocked clipboard access');
          }),
          button('Copy subject', 'btn btn-sm', async () => { await navigator.clipboard.writeText(r.subject); toast('Subject copied'); })
        );
      }
      actions.push(button('Load into form', 'btn btn-sm', () => {
        if (!confirm('Replace the current form with this request?')) return;
        PH.writeLocal(cfg.draftKey, r.form);
        location.reload();
      }));
      return el('div', { class: `req-card req-${r.status}` }, [
        el('div', { class: 'req-top' }, [el('span', { class: 'req-status', text: status }), el('span', { class: 'req-subject', text: r.subject })]),
        el('div', { class: 'req-meta', text: `Submitted ${when(r.submitted_at)}` +
          (r.decided_by ? ` · ${status} by ${r.decided_by} ${when(r.decided_at)}` : '') }),
        r.comment ? el('div', { class: 'req-comment', text: `Comment: ${r.comment}` }) : null,
        el('div', { class: 'props-actions' }, actions)
      ]);
    }
    loadMyRequests();
  }

  async function copyRich(html, text, fallbackNode) {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' })
      })]);
      return true;
    } catch {
      // No page element to select (stored request): fall back to plain text.
      if (!fallbackNode) {
        try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
      }
      // Fallback for browsers without ClipboardItem: copy the rendered preview selection.
      const range = document.createRange();
      range.selectNodeContents(fallbackNode);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const ok = document.execCommand('copy');
      sel.removeAllRanges();
      return ok;
    }
  }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
  }

  // ---------- subject line ----------
  // "[For RO Approval] S1532_PACES | Emergency Change | ECR-673 - Request to fix …"
  const AUTO_PREFIX = 'Automatic — [For RO/PS/… Approval] by who approves next';
  const SUBJECT_FIELDS = [
    { key: 'subjectPrefix', label: 'Prefix', type: 'select', options: [AUTO_PREFIX, '[Action Required]'],
      hint: 'Automatic follows the Deployment Approval table: the first approver not yet Approved.' },
    { key: 'systemId', label: 'System ID', example: 'S1532', hint: 'Taken from System Name if it contains one.' },
    { key: 'changeTitle', label: 'Change title', example: 'Request to Remediate VA Items' }
  ];
  function subjectParts(data, systemName) {
    const name = String(systemName || '').trim();
    const id = String(data.systemId || '').trim() || (name.match(/\b(S\d{3,})\b/i) || [])[1] || '';
    // "AIC SEA (S1092)" → "AIC SEA" when the bracket is just the System ID.
    const shortName = id ? name.replace(new RegExp(`\\s*\\(\\s*${id}\\s*\\)\\s*$`, 'i'), '') : name;
    return { id, name: shortName, title: String(data.changeTitle || '').trim() };
  }
  // Reporting Officer → RO, Product Specialist → PS, Service Lead → SL, Project Director → PD; others by initials.
  const ROLE_ABBR = { 'reporting officer': 'RO', 'product specialist': 'PS', 'service lead': 'SL', 'project director': 'PD' };
  function prefixFor(data) {
    // A manual choice wins; an old saved "[For RO Approval]" counts as automatic.
    if (data.subjectPrefix && data.subjectPrefix !== AUTO_PREFIX && !/^\[For \w+ Approval\]$/.test(data.subjectPrefix)) return data.subjectPrefix;
    const list = data.approvals || [];
    const next = list.find(a => a.status !== 'Approved') || list[list.length - 1];
    const division = String(next?.division || '').trim();
    const abbr = ROLE_ABBR[division.toLowerCase()] || division.split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase()).join('') || 'RO';
    return `[For ${abbr} Approval]`;
  }
  function subjectLine(data, { type, ticket, systemName }) {
    const p = subjectParts(data, systemName);
    return `${prefixFor(data)} ${p.id || '<System ID>'}_${p.name || '<System Name>'} | ${type} | ` +
      `${String(ticket || '').trim() || '<Ticket>'} - ${p.title || '<Change title>'}`;
  }
  function subjectMissing(data, systemName) {
    const p = subjectParts(data, systemName);
    return [!p.id && 'System ID', !p.name && 'System Name', !p.title && 'Change title'].filter(Boolean);
  }

  return { mount, SUBJECT_FIELDS, subjectLine, subjectMissing };
})();
