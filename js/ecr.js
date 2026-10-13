/* Emergency Change (ECR) template configuration. */
(() => {
  // Emergency change type must be 1, 2 or 3; the stored value is "<category> – <reason>".
  const CHANGE_TYPES = [
    { name: '1. Urgent System Recovery', reasons: [
      'a. Application/Server/DB/Switch Interface Hang or Slowness or Outage',
      'b. Extreme Performance Degrading',
      'c. DB Corruption/Error',
      'd. High Utilization (Memory/CPU)',
      'e. Hardware Failure',
      'f. Immediate operational or clinical disruptions'
    ] },
    { name: '2. Emergency Situation', reasons: [
      'a. Statutory/Ministry Implementation Requirement',
      'b. Change Request to Support Pandemic or Hospital emergencies (e.g. Actual Mass Casualty, BCP)',
      'c. Urgent Critical Security Patches or Cyber Incidents'
    ] },
    { name: '3. Unplanned Change', reasons: [
      'a. All other changes (apart from urgent system recovery and emergency situations listed above) will be part of unplanned changes. These changes need to have proper justification for being raised as unplanned changes'
    ] }
  ];
  const isUnplanned = (data) => String(data.changeType || '').startsWith('3.');

  const changeType = {
    key: 'changeType', label: 'Emergency Change Type', type: 'custom',
    render({ data, save, blankOption }) {
      const { el } = PH;
      const select = el('select', {}, [
        blankOption('Select emergency change type (1, 2 or 3)…'),
        ...CHANGE_TYPES.map(t => el('optgroup', { label: t.name },
          t.reasons.map(r => el('option', { value: `${t.name} – ${r}`, text: t.name[0] + r }))))
      ]);
      // Keep a free-text value from an older draft selectable so it isn't silently lost.
      if (data.changeType && ![...select.options].some(o => o.value === data.changeType)) {
        select.append(el('option', { value: data.changeType, text: `${data.changeType} (old value — please reselect)` }));
      }
      select.value = data.changeType || '';
      const hint = el('div', { class: 'ecr-type-hint', text: 'Unplanned change: provide proper justification under Justification / Reason for change.' });
      const refresh = () => { hint.hidden = !isUnplanned(data); };
      select.onchange = () => { data.changeType = select.value; save(); refresh(); };
      refresh();
      return [select, hint];
    },
    html: ({ data, lines }) => lines(data.changeType),
    text: ({ data }) => data.changeType || ''
  };

  const justification = {
    key: 'justification', label: 'Justification / Reason for change', type: 'custom',
    render({ input }) {
      const { el } = PH;
      return [
        el('label', { class: 'ecr-inline-label', text: 'Background:' }),
        input('background', { multiline: true, rows: 3 }),
        el('label', { class: 'ecr-inline-label', text: 'Changes: (one item per line)' }),
        input('changes', { multiline: true, rows: 3, placeholder: 'Microsoft Edge Chromium\nWindows Patch 2022 Server' })
      ];
    },
    html: ({ data, lines, esc, listItems }) =>
      `<b><u>Background:</u></b><br>${lines(data.background)}<br><br><b><u>Changes:</u></b><br>${listItems(data.changes).map(esc).join('<br>')}`,
    text: ({ data, listItems }) => `Background: ${data.background || ''} / Changes: ${listItems(data.changes).join('; ')}`
  };

  PHTemplate.mount({
    title: 'Emergency Change Template',
    shortTitle: 'Emergency Change',
    draftKey: 'ph_ecr_draft',
    approvalsTitle: 'Deployment Approval:',
    approvalsUnderline: true,
    approvers: ['Reporting Officer', 'Product Specialist', 'Service Lead', 'Project Director'],
    type: 'ecr',
    subjectFields: PHTemplate.SUBJECT_FIELDS,
    // `shade` mirrors the darker rows in the original template.
    fields: [
      { key: 'ecrNumber', label: 'Emergency Change Number', placeholder: 'e.g. ECR-673' },
      { key: 'incident', label: 'Incident Number (if any)' },
      changeType,
      justification,
      { key: 'system', label: 'System Name' },
      { key: 'description', label: 'Change Description', multiline: true },
      { key: 'reasonNoCR', label: 'Reason for not raising Normal CR', multiline: true },
      { key: 'institutions', label: 'Institution(s) Affected', shade: true },
      { key: 'deployWindow', label: 'Deployment window (Start and End Date/Time, including rollback)', type: 'window' },
      { key: 'downtime', label: 'Downtime Window (Start and End Date/Time, including rollback)', type: 'window' },
      { key: 'impact', label: 'Business Impact', multiline: true, shade: true },
      { key: 'dependencies', label: 'Indicate System Dependencies', multiline: true },
      { key: 'rollback', label: 'Is there roll-back plan?', multiline: true, shade: true },
      { key: 'directorApproval', label: 'Program/Infra Director Approval', shade: true },
      { key: 'ownerApproval', label: 'System Owner/Custodian Approval' },
      { key: 'uat', label: 'UAT signoff', multiline: true },
      { key: 'implPlan', label: 'Implementation Plan', multiline: true }
    ],
    introHtml: ({ data, esc, listItems, joinItems }) =>
      `I would like to seek your email approval for <b>Emergency Change ${esc(data.ecrNumber)}</b> – To roll out VA scan issue fixes to resolve ${esc(joinItems(listItems(data.changes)))}.`,
    introText: ({ data, listItems, joinItems }) =>
      `I would like to seek your email approval for Emergency Change ${data.ecrNumber} – To roll out VA scan issue fixes to resolve ${joinItems(listItems(data.changes))}.`,
    ticket: ({ data }) => String(data.ecrNumber || '').trim(),
    subject: ({ data }) => PHTemplate.subjectLine(data, { type: 'Emergency Change', ticket: data.ecrNumber, systemName: data.system }),
    validate({ data, listItems }) {
      const missing = PHTemplate.subjectMissing(data, data.system);
      if (!String(data.ecrNumber || '').trim()) missing.push('Emergency Change Number');
      if (!/^[123]\. /.test(data.changeType || '')) missing.push('Emergency Change Type (1, 2 or 3)');
      if (isUnplanned(data) && !String(data.background || '').trim()) missing.push('Background (justification required for Unplanned Change)');
      if (!listItems(data.changes).length) missing.push('Changes');
      return missing;
    }
  });
})();
