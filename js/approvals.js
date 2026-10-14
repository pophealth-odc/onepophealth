/* Approvals: Approvers (and Admins) review submitted Emergency / Pre-Approved Change emails. */
(async () => {
  const session = PH.requireLogin();
  if (!session) return;
  if (!PH.can(session, 'approve')) { location.replace('main.html'); return; }
  PH.refreshSession().then(s => { if (s && (s.role !== session.role || s.domain !== session.domain)) location.reload(); });
  const main = document.querySelector('main');
  main.hidden = true;
  const layout = await PH.getLayout().catch(() => null);
  main.hidden = false;
  if (layout && !PH.requireDomain(session, PH.pageDomains(layout, 'templates'), main)) return;

  const $ = (id) => document.getElementById(id);
  const { el } = PH;
  const TYPES = { ecr: 'Emergency Change', pac: 'Pre-Approved Change' };
  let status = 'pending';

  $('userChip').textContent = `${session.username} · ${session.role}`;
  if (PH.isAdmin(session)) $('adminBtn').hidden = false;
  $('logoutBtn').onclick = () => { PH.clearSession(); location.href = 'index.html'; };

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
  }
  const when = (t) => t ? new Date(t).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '';

  async function load() {
    $('error').textContent = '';
    $('list').replaceChildren(el('div', { class: 'muted', text: 'Loading…' }));
    try {
      const db = await PH.approvalsDb();
      const type = $('typeFilter').value;
      const order = status === 'pending' ? 'submitted_at.asc' : 'decided_at.desc';
      const rows = await db.list(`select=*&status=eq.${status}${type ? '&type=eq.' + type : ''}&order=${order}&limit=100`);
      $('count').textContent = `${rows.length} ${status}`;
      $('list').replaceChildren(...(rows.length ? rows.map(card) : [el('div', { class: 'muted', text: `No ${status} requests.` })]));
    } catch (err) {
      $('list').replaceChildren();
      $('error').textContent = err.message;
    }
  }

  // The email is shown in a sandboxed frame (no scripts), since it comes from the shared database.
  function emailFrame(html) {
    const frame = el('iframe', { class: 'req-frame', title: 'Email preview' });
    frame.setAttribute('sandbox', ''); // set directly: PH.el skips empty attribute values
    frame.srcdoc = `<!doctype html><html><body style="margin:12px;background:#fff">${html}</body></html>`;
    return frame;
  }

  function card(r) {
    const own = r.submitted_by.toLowerCase() === session.username.toLowerCase();
    const body = el('div', { class: 'req-body' });
    body.hidden = true;
    const comment = el('textarea', { rows: 2, placeholder: 'Comment (required when rejecting)' });
    const error = el('div', { class: 'error' });

    const decide = async (decision, btns) => {
      if (decision === 'rejected' && !comment.value.trim()) { error.textContent = 'Please add a comment explaining the rejection.'; return; }
      btns.forEach(b => { b.disabled = true; });
      try {
        const db = await PH.approvalsDb();
        const updated = await db.decide(r.id, {
          status: decision, decided_by: session.username, decided_at: new Date().toISOString(), comment: comment.value.trim() || null
        });
        if (!updated.length) throw new Error('Someone else has already decided this request.');
        toast(decision === 'approved' ? '✔ Approved' : 'Rejected');
        load();
      } catch (err) {
        error.textContent = `✖ ${err.message}`;
        btns.forEach(b => { b.disabled = false; });
      }
    };

    if (r.status === 'pending') {
      if (own) {
        body.append(el('div', { class: 'muted', text: 'You submitted this request, so another Approver must decide it.' }));
      } else {
        const approve = el('button', { class: 'btn btn-primary', type: 'button', text: '✔ Approve' });
        const reject = el('button', { class: 'btn btn-danger', type: 'button', text: '✕ Reject' });
        approve.onclick = () => decide('approved', [approve, reject]);
        reject.onclick = () => decide('rejected', [approve, reject]);
        body.append(comment, error, el('div', { class: 'props-actions' }, [approve, reject]));
      }
    }

    const toggle = el('button', { class: 'btn btn-sm', type: 'button', text: 'Review ▾' });
    toggle.onclick = () => {
      body.hidden = !body.hidden;
      toggle.textContent = body.hidden ? 'Review ▾' : 'Hide ▴';
      if (!body.hidden && !body.querySelector('iframe')) body.prepend(el('div', { class: 'req-subject-line', text: `Subject: ${r.subject}` }), emailFrame(r.email_html));
    };

    return el('div', { class: `req-card req-${r.status}` }, [
      el('div', { class: 'req-top' }, [
        el('span', { class: 'req-status', text: TYPES[r.type] || r.type }),
        el('span', { class: 'req-subject', text: r.subject }),
        toggle
      ]),
      el('div', { class: 'req-meta', text: `Submitted by ${r.submitted_by} · ${when(r.submitted_at)}` +
        (r.decided_by ? ` · ${r.status} by ${r.decided_by} ${when(r.decided_at)}` : '') }),
      r.comment ? el('div', { class: 'req-comment', text: `Comment: ${r.comment}` }) : null,
      body
    ]);
  }

  document.querySelectorAll('.seg-btn').forEach(b => {
    b.onclick = () => {
      status = b.dataset.status;
      document.querySelectorAll('.seg-btn').forEach(x => x.classList.toggle('active', x === b));
      load();
    };
  });
  $('typeFilter').onchange = load;
  $('refreshBtn').onclick = load;
  load();
})();
