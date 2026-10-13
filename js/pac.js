/* Pre-Approved Change (SCR) template configuration. */
(() => {
  const crs = ({ data, listItems }) => listItems(data.crNumbers);
  // Bold part of the intro; falls back to the Change Summary. A leading "for" is optional when typing.
  const purpose = ({ data }) => String(data.purpose || data.summary || '').trim().replace(/^for\s+/i, '');
  const reason = ({ data }) => String(data.routingReason || '').trim();

  PHTemplate.mount({
    title: 'Pre-Approved Change Template',
    shortTitle: 'Pre-Approved Change',
    draftKey: 'ph_pac_draft',
    approvalsTitle: 'Reviewers and Approvers',
    approvalsUnderline: false,
    approvers: ['Reporting Officer', 'Product Specialist', 'Service Lead', 'Project Director'],
    headerAlign: 'left',
    type: 'pac',
    subjectFields: PHTemplate.SUBJECT_FIELDS.map(f => ({ ...f, example: {
      systemId: 'S1092', changeTitle: 'Routine monthly maintenance for Aug-26 baseline for SEA Production servers'
    }[f.key] || f.example })),
    // `example` = grey placeholder; Tab in the empty field inserts it.
    introFields: [
      { key: 'purpose', label: 'Purpose (bold, after the CR number)', multiline: true,
        example: 'for System Team to perform routine monthly maintenance for Aug-26 baseline for SEA Production servers',
        hint: 'Leave blank to use the Change Summary.' },
      { key: 'routingReason', label: 'Why it is routed for approval (optional)', multiline: true, rows: 3,
        example: 'We are routing this upcoming maintenance for approval as there is a need to reschedule from the pre-arranged date on 01 September 2026 due to monthly batch jobs running on 1st day of the month.' }
    ],
    // Row colours follow the original template: blue-grey rows and light-grey summary rows.
    fields: [
      { key: 'crNumbers', label: 'Change Request No', type: 'list', example: 'SCR-95710', hint: 'One per line.', bg: '#d9e1f2' },
      { key: 'summary', label: 'Change Summary', bg: '#f2f2f2',
        example: 'AIC SEA - For System team to perform routine monthly maintenance for Aug-26 baseline for SEA Production servers' },
      { key: 'description', label: 'Change Description', multiline: true, rows: 3, bg: '#f2f2f2',
        example: 'For System team to perform routine monthly maintenance for Aug-26 baseline for SEA Production servers.' },
      { key: 'system', label: 'System Name', example: 'AIC SEA (S1092)', bg: '#d9e1f2' },
      { key: 'institutions', label: 'Institution(s) Affected', example: 'AIC', bg: '#e9eef7' },
      { key: 'deployWindow', label: 'Deployment window\n(Start and End Date/Time)', type: 'window', bg: '#d9e1f2' },
      { key: 'downtime', label: 'Downtime Window\n(Start and End Date/Time, including rollback)', type: 'window', bg: '#d9e1f2',
        noteExample: '(Broadcast Message has been sent to the users)' },
      { key: 'implPlan', label: 'Implementation Plan & SOP', multiline: true, rows: 3, bg: '#d9e1f2',
        example: 'Implementation Plan and SOP is embedded to the ticket.\nTicket link: https://itsm.hcloud.healthgrp.com.sg/servicedesk/customer/portal/51/SCR-95710\n<<SCR-95710 AICSEA - Rescheduling Production Monthly Maintenance.pdf' },
      { key: 'uat', label: 'UAT Sign off', multiline: true, example: 'NA, as this is routine monthly maintenance.', bg: '#d9e1f2' }
    ],
    introHtml(ctx) {
      const { esc, ordinals, lines, joinItems } = ctx;
      return `I would like to seek your approval <b>for pre-approved change request ${esc(joinItems(crs(ctx)))} - for ${esc(purpose(ctx))}</b>.`
        + (reason(ctx) ? ' ' + ordinals(lines(reason(ctx))) : '');
    },
    introText: (ctx) =>
      `I would like to seek your approval for pre-approved change request ${ctx.joinItems(crs(ctx))} - for ${purpose(ctx)}.${reason(ctx) ? ' ' + reason(ctx) : ''}`,
    ticket: (ctx) => crs(ctx).join(', '),
    subject: (ctx) => PHTemplate.subjectLine(ctx.data, { type: 'Pre-Approved Change', ticket: crs(ctx).join(', '), systemName: ctx.data.system }),
    validate(ctx) {
      const missing = PHTemplate.subjectMissing(ctx.data, ctx.data.system);
      if (!crs(ctx).length) missing.push('Change Request No');
      if (!purpose(ctx)) missing.push('Purpose or Change Summary');
      return missing;
    }
  });
})();
