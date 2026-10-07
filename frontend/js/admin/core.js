// core.js - helpers shared by every admin tab: DOM builder, API calls, forms, tables, dialogs.
import { getCurrentUser, endSession } from '/utils/storage.js';
import { showToast } from '../ui.js';

export { showToast };
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export const currentUser = getCurrentUser() || {};

// Small helper to build elements without innerHTML (so server text can never become markup)
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.filter(child => child != null));
  return node;
}

// Screen-reader announcements for things that appear without a page change (loading, empty, results).
// One permanent live region is reused, because regions that are inserted together with their text are often not read.
let announceTimer = null;
export function announce(text) {
  const region = document.getElementById('liveRegion');
  if (!region) return;
  clearTimeout(announceTimer);
  region.textContent = '';
  announceTimer = setTimeout(() => { region.textContent = text; }, 60);
}

// Calls the admin API with the admin token. On failure throws an Error whose .code is the
// server's `error` value and whose .message is a sentence that can be shown to the person.
export async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
        Authorization: `Bearer ${currentUser.adminToken || ''}`,
      },
      body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
    });
  } catch {
    throw Object.assign(new Error('Could not reach the server.'), { code: 'network' });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const auth = {
      admin_login_required: 'Sign out and sign in again as admin.',
      invalid_admin_token: 'Your admin session is invalid. Sign in again.',
      expired_admin_token: 'Your admin session expired. Sign in again.',
      admin_access_required: 'This account is no longer an admin. Sign in again.',
    };
    // An expired or invalid token can never work again: go to the login page with the reason
    // instead of leaving every screen showing a vague "could not load" message.
    if (response.status === 401 || body.error === 'admin_access_required') {
      endSession(
        body.error === 'expired_admin_token'
          ? 'Your admin session expired. Please sign in again.'
          : 'Your admin session is no longer valid. Please sign in again.',
      );
    }
    throw Object.assign(new Error(auth[body.error] || body.message || 'Request failed.'), {
      code: body.error || 'http_' + response.status,
      body,
    });
  }
  return body;
}

// Shows or clears the red/green message under a form field
export function setFieldMsg(id, text, kind = 'err') {
  const input = document.getElementById(id);
  const msg = document.getElementById(`${id}-msg`);
  if (!msg) return;
  msg.textContent = text || '';
  msg.hidden = !text;
  msg.className = `field-msg ${kind}`;
  if (input) {
    if (text && kind === 'err') input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

// Shows or clears the red box at the bottom of a dialog
export function setBox(id, text) {
  const box = document.getElementById(id);
  box.textContent = text || '';
  box.hidden = !text;
}

// Checks required fields, shows a message under each empty one and focuses the first.
// fields: [{ id, label, select }]. Returns true when everything is filled in.
export function requireFields(fields) {
  let firstBad = null;
  for (const { id, label, select } of fields) {
    const input = document.getElementById(id);
    const empty = !input.value.trim();
    setFieldMsg(
      id,
      empty ? (select ? `Choose a ${label}.` : `Enter the ${label}.`) : '',
    );
    if (empty && !firstBad) firstBad = input;
  }
  firstBad?.focus();
  return !firstBad;
}

// Clear a field's message as soon as the person starts fixing it
document.addEventListener('input', event => {
  const id = event.target.id;
  if (id && document.getElementById(`${id}-msg`) && id !== 'faceImages')
    setFieldMsg(id, '');
});

// Show / hide password buttons
$$('[data-toggle-password]').forEach(button => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.togglePassword);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? 'Hide' : 'Show';
    button.setAttribute('aria-pressed', String(show));
  });
});

// Busy state for buttons: shows a spinner and blocks double clicks
export const setBusy = (button, busy) => {
  if (busy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
};
// ==================== Data table (used for students, faculty, attendance) ====================
// columns: [{ key, label, get(row) -> text, sortable, num, clip, nowrap, title, render(row, cell) }]
// title: true marks the column used as the card heading on phones (default: "name", else the first column).
export function createDataTable({
  mount,
  columns,
  noun,
  pageSize = 10,
  onRetry,
  emptyHint = '',
  selectable = false, // adds a checkbox column; rows need an `id`
  onSelect,
  defaultSort = null, // { key, dir: 1 | -1 }
}) {
  const state = {
    selected: new Set(),
    pending: null, // the row button last used, so focus can come back after the table redraws
    rows: [],
    loading: true,
    error: false,
    query: '',
    filter: null,
    sortKey: defaultSort?.key ?? null,
    sortDir: defaultSort?.dir ?? 1,
    page: 0,
    focusSort: null,
    focusSortSelect: false,
  };
  // Phones show each row as a card; this column becomes the card heading
  const titleKey = (columns.find(c => c.title) || columns.find(c => c.key === 'name') || columns[0]).key;

  function visibleRows() {
    const query = state.query.trim().toLowerCase();
    let rows = state.rows.filter(row => !state.filter || state.filter(row));
    if (query) {
      rows = rows.filter(row =>
        columns.some(
          col =>
            col.get &&
            String(col.get(row) ?? '')
              .toLowerCase()
              .includes(query),
        ),
      );
    }
    if (state.sortKey) {
      const col = columns.find(c => c.key === state.sortKey);
      rows = [...rows].sort(
        (a, b) =>
          String(col.get(a) ?? '').localeCompare(
            String(col.get(b) ?? ''),
            undefined,
            { numeric: true, sensitivity: 'base' },
          ) * state.sortDir,
      );
    }
    return rows;
  }

  function render() {
    // Loading: grey placeholder rows (only on first load; later refreshes keep the old rows visible)
    if (state.loading && !state.rows.length) {
      announce(`Loading ${noun}s…`);
      mount.replaceChildren(
        h(
          'div',
          {
            class: 'adm-skeleton-rows',
            'aria-busy': 'true',
            'aria-label': `Loading ${noun}s`,
          },
          ...[1, 2, 3, 4, 5].map(() => h('div', { class: 'skeleton' })),
        ),
      );
      return;
    }
    if (state.error) {
      mount.replaceChildren(
        h(
          'div',
          { class: 'adm-state', role: 'alert' },
          h('strong', { text: `Could not load ${noun}s` }),
          h('span', { text: 'Check your connection and try again.' }),
          h('button', {
            class: 'btn btn-secondary',
            type: 'button',
            text: 'Try again',
            onclick: () => onRetry?.(),
          }),
        ),
      );
      return;
    }
    if (!state.rows.length) {
      announce(`No ${noun}s yet. ${emptyHint}`);
      mount.replaceChildren(
        h(
          'div',
          { class: 'adm-state' },
          h('strong', { text: `No ${noun}s yet` }),
          h('span', { text: emptyHint }),
        ),
      );
      return;
    }

    const rows = visibleRows();
    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
    state.page = Math.min(state.page, pageCount - 1);
    const pageRows = rows.slice(
      state.page * pageSize,
      (state.page + 1) * pageSize,
    );

    if (!rows.length) {
      announce(`No ${noun}s match the current search or filters.`);
      mount.replaceChildren(
        h(
          'div',
          { class: 'adm-state' },
          h('strong', { text: `No ${noun}s match` }),
          h('span', { text: 'Try a different search or filter.' }),
        ),
      );
      return;
    }

    const allBox = selectable
      ? h('input', { type: 'checkbox', 'aria-label': `Select all ${rows.length} matching ${noun}s`, onchange: event => {
          for (const row of rows) event.target.checked ? state.selected.add(row.id) : state.selected.delete(row.id);
          syncChecks();
        } })
      : null;
    const head = h(
      'tr',
      {},
      ...(selectable ? [h('th', { scope: 'col', class: 'adm-th-select' }, allBox)] : []),
      ...columns.map(col => {
        const th = h('th', { scope: 'col', role: 'columnheader' });
        if (col.sortable) {
          th.setAttribute(
            'aria-sort',
            state.sortKey === col.key
              ? state.sortDir === 1
                ? 'ascending'
                : 'descending'
              : 'none',
          );
          th.append(
            h('button', {
              class: 'adm-sort',
              type: 'button',
              'data-sort': col.key,
              text: col.label,
              onclick: () => sortBy(col.key),
            }),
          );
        } else th.textContent = col.label;
        if (col.help) th.append(h('span', { class: 'adm-th-help', text: col.help }));
        return th;
      }),
    );
    const body = h(
      'tbody',
      { role: 'rowgroup' },
      ...pageRows.map(row =>
        h(
          'tr',
          { role: 'row', 'data-row-id': row.id ?? false },
          ...(selectable ? [h('td', { class: 'adm-td-select', 'data-label': 'Select' }, h('input', {
            type: 'checkbox', 'data-select-id': row.id, checked: state.selected.has(row.id) || false,
            'aria-label': `Select ${row.name || row.label || row.abbr || `#${row.id}`}`,
            onchange: event => { event.target.checked ? state.selected.add(row.id) : state.selected.delete(row.id); syncChecks(); },
          }))] : []),
          ...columns.map(col => {
            const td = h('td', {
              'data-label': col.label,
              role: 'cell',
              class:
                [col.num && 'adm-num', col.clip && 'adm-clip', col.nowrap && 'adm-nowrap', col.key === titleKey && 'adm-td-title', col.key === 'actions' && 'adm-td-actions']
                  .filter(Boolean)
                  .join(' ') || false,
            });
            if (col.render) col.render(row, td);
            else {
              td.textContent = col.get(row) ?? '';
              if (col.clip) td.title = td.textContent;
            }
            return td;
          }),
        ),
      ),
    );

    const first = state.page * pageSize + 1;
    const last = Math.min(rows.length, first + pageSize - 1);
    const pager = h(
      'div',
      { class: 'adm-pager' },
      h('span', {
        role: 'status',
        text: `Showing ${first}–${last} of ${rows.length}`,
      }),
      h(
        'span',
        { class: 'adm-pager-btns' },
        h('button', {
          class: 'btn btn-secondary btn-sm',
          type: 'button',
          text: 'Previous',
          disabled: state.page === 0,
          onclick: () => go(-1),
        }),
        h('button', {
          class: 'btn btn-secondary btn-sm',
          type: 'button',
          text: 'Next',
          disabled: state.page >= pageCount - 1,
          onclick: () => go(1),
        }),
      ),
    );

    // Phones hide the column headings (rows become cards), so sorting moves into a menu
    const sortable = columns.filter(col => col.sortable);
    const sortBar = sortable.length
      ? h(
          'div',
          { class: 'adm-sortbar field' },
          h('label', { for: `sortSel-${mount.id}`, text: 'Sort by' }),
          h(
            'select',
            {
              class: 'input',
              id: `sortSel-${mount.id}`,
              onchange: event => {
                const [key, dir] = event.target.value.split(':');
                state.sortKey = key || null;
                state.sortDir = dir === 'desc' ? -1 : 1;
                state.focusSortSelect = true;
                render();
              },
            },
            new Option('Default order', ''),
            ...sortable.flatMap(col => [
              new Option(`${col.label} (ascending)`, `${col.key}:asc`),
              new Option(`${col.label} (descending)`, `${col.key}:desc`),
            ]),
          ),
        )
      : null;
    if (sortBar) sortBar.querySelector('select').value = state.sortKey ? `${state.sortKey}:${state.sortDir === 1 ? 'asc' : 'desc'}` : '';

    mount.replaceChildren(
      ...(sortBar ? [sortBar] : []),
      h(
        'div',
        {
          class: 'adm-table-wrap',
          tabindex: '0',
          role: 'region',
          'aria-label': `${noun} list`,
        },
        h('table', { class: 'adm-table', role: 'table' }, h('thead', { role: 'rowgroup' }, head), body),
      ),
      pager,
    );
    if (state.focusSortSelect) mount.querySelector('.adm-sortbar select')?.focus();
    state.focusSortSelect = false;
    syncChecks(false);
    // After re-sorting, put keyboard focus back on the heading button that was used
    if (state.focusSort)
      mount.querySelector(`[data-sort="${state.focusSort}"]`)?.focus();
    state.focusSort = null;
    restoreFocus();
  }

  // Keeps the header checkbox (all / some / none) and the row boxes in step with the selection
  function syncChecks(notify = true) {
    if (!selectable) return;
    const ids = visibleRows().map(r => r.id);
    const count = ids.filter(id => state.selected.has(id)).length;
    mount.querySelectorAll('[data-select-id]').forEach(box => { box.checked = state.selected.has(Number(box.dataset.selectId)) || state.selected.has(box.dataset.selectId); });
    const all = mount.querySelector('.adm-th-select input');
    if (all) { all.checked = ids.length > 0 && count === ids.length; all.indeterminate = count > 0 && count < ids.length; }
    if (notify) onSelect?.([...state.selected]);
  }

  // After a dialog closes (or a row button redraws the table) the button that was used is gone.
  // Put focus on the same row's button, or on the row that took its place, so keyboard users keep their spot.
  function restoreFocus() {
    const p = state.pending;
    if (!p) return;
    if (Date.now() - p.at > 60000) { state.pending = null; return; }
    if (document.querySelector('dialog[open]')) return;
    const active = document.activeElement;
    if (active && active !== document.body && document.contains(active)) { state.pending = null; return; }
    const trs = [...mount.querySelectorAll('tbody tr')];
    const tr = trs.find(t => p.id != null && t.dataset.rowId === String(p.id)) || trs[Math.min(p.index, trs.length - 1)];
    const target = tr?.querySelectorAll('td:not(.adm-td-select) button')[tr.dataset.rowId === String(p.id) ? p.button : 0]
      || tr?.querySelector('button') || mount.querySelector('.adm-table-wrap');
    target?.focus();
    state.pending = null;
  }
  mount.addEventListener('click', event => {
    const button = event.target.closest('tbody button');
    const tr = button?.closest('tr');
    if (!tr) return;
    const trs = [...tr.parentElement.children];
    state.pending = { id: tr.dataset.rowId ?? null, index: trs.indexOf(tr), button: [...tr.querySelectorAll('td:not(.adm-td-select) button')].indexOf(button), at: Date.now() };
  }, true);
  tables.add({ restoreFocus });

  function sortBy(key) {
    state.sortDir = state.sortKey === key ? -state.sortDir : 1;
    state.sortKey = key;
    state.focusSort = key;
    render();
  }
  function go(step) {
    state.page += step;
    render();
  }

  return {
    render,
    setRows(rows) {
      state.rows = rows;
      const ids = new Set(rows.map(r => r.id));
      let pruned = false;
      for (const id of [...state.selected]) if (!ids.has(id)) { state.selected.delete(id); pruned = true; }
      if (pruned) onSelect?.([...state.selected]);
      state.loading = false;
      state.error = false;
      render();
    },
    setLoading() {
      state.loading = true;
      state.error = false;
      render();
    },
    setError() {
      state.loading = false;
      state.error = true;
      render();
    },
    setQuery(query) {
      state.query = query;
      state.page = 0;
      render();
    },
    setFilter(fn) {
      state.filter = fn;
      state.page = 0;
      render();
    },
    get rows() {
      return visibleRows();
    },
    get selected() {
      return [...state.selected];
    },
    clearSelection() {
      state.selected.clear();
      syncChecks();
    },
    restoreFocus,
  };
}
// Every table registers here so a closing dialog can ask them to repair lost focus
const tables = new Set();
document.addEventListener('close', event => {
  if (event.target.tagName === 'DIALOG') requestAnimationFrame(() => tables.forEach(t => t.restoreFocus()));
}, true);

// ==================== Confirm dialog (shared) ====================
const deleteDialog = $('#deleteDialog');
let deleteAction = null;
let deleteFailText = 'Could not complete that. Try again.';

// run: async function that does the work; the dialog stays open (with a spinner) until it finishes.
// confirmLabel / cancelLabel name the buttons after what they do ("Deactivate", "Reset", "Split batches").
// danger: red button for things that destroy or hide data; false for ordinary confirmations.
export function askConfirm({ title, text, run, confirmLabel = 'Delete', cancelLabel = 'Keep', danger = true, failText = 'Could not complete that. Try again.', reasons = null }) {
  // reasons: ['Wrong person', ..., 'Other'] asks for a reason first; run(reasonText) receives it
  const reasonField = $('#deleteReasonField');
  reasonField.hidden = !reasons;
  if (reasons) {
    fillSelect($('#deleteReason'), reasons.map(r => ({ value: r, label: r })), 'Choose a reason…');
    $('#deleteReasonNote').value = '';
    $('#deleteReasonNote').hidden = true;
  }
  $('#deleteTitle').textContent = title;
  $('#deleteText').textContent = text;
  const confirm = $('#deleteConfirmBtn');
  confirm.textContent = confirmLabel;
  confirm.className = `btn ${danger ? 'btn-danger btn-solid' : 'btn-primary'}`;
  $('#deleteCancelBtn').textContent = cancelLabel;
  setBox('deleteError', '');
  deleteAction = run;
  deleteFailText = failText;
  deleteDialog.showModal();
}
// Kept for the existing callers
export const askDelete = options => askConfirm({ failText: 'Could not delete. Try again.', ...options });
$('#deleteCancelBtn').addEventListener('click', () => deleteDialog.close());
$('#deleteReason').addEventListener('change', event => {
  $('#deleteReasonNote').hidden = event.target.value !== 'Other';
  if (!$('#deleteReasonNote').hidden) $('#deleteReasonNote').focus();
});
const chosenReason = () => {
  if ($('#deleteReasonField').hidden) return { ok: true, text: '' };
  const picked = $('#deleteReason').value;
  const note = $('#deleteReasonNote').value.trim();
  if (!picked) return { ok: false, message: 'Choose a reason.', focus: $('#deleteReason') };
  if (picked === 'Other' && !note) return { ok: false, message: 'Write the reason in the box.', focus: $('#deleteReasonNote') };
  return { ok: true, text: picked === 'Other' ? note : picked + (note ? `: ${note}` : '') };
};
deleteDialog.addEventListener('cancel', event => {
  if ($('#deleteConfirmBtn').getAttribute('aria-busy')) event.preventDefault(); // don't close mid-action
});
$('#deleteConfirmBtn').addEventListener('click', async event => {
  const button = event.currentTarget;
  const reason = chosenReason();
  if (!reason.ok) { setBox('deleteError', reason.message); reason.focus.focus(); return; }
  setBusy(button, true);
  setBox('deleteError', '');
  try {
    await deleteAction(reason.text);
    deleteDialog.close();
  } catch (error) {
    setBox(
      'deleteError',
      error.code === 'network'
        ? 'Could not reach the server. Try again.'
        : error.message && error.message !== 'Request failed.'
          ? error.message // e.g. "Other records still use this item" - tells the admin WHY
          : deleteFailText,
    );
  } finally {
    setBusy(button, false);
  }
});

// Row buttons: Edit is a normal button, the remove button is outlined red so the two never look alike.
// opts.removeLabel names what the button really does (students are deactivated, not deleted);
// opts.removeKind 'secondary' is for the opposite, harmless action (Reactivate).
export function rowActions(noun, row, name, onEdit, onRemove, opts = {}) {
  const { removeLabel = 'Delete', removeKind = 'danger' } = opts;
  return h(
    'div',
    { class: 'adm-actions' },
    h('button', {
      class: 'btn btn-secondary btn-sm',
      type: 'button',
      text: 'Edit',
      'aria-label': `Edit ${noun} ${name}`,
      onclick: () => onEdit(row),
    }),
    h('button', {
      class: `btn btn-${removeKind} btn-sm`,
      type: 'button',
      text: removeLabel,
      'aria-label': `${removeLabel} ${noun} ${name}`,
      onclick: () => onRemove(row),
    }),
  );
}

// ---------- small shared helpers ----------
export const fillSelect = (select, options, placeholder) =>
  select.replaceChildren(
    ...(placeholder == null ? [] : [new Option(placeholder, '')]),
    ...options.map(o => new Option(o.label, o.value ?? o.id)),
  );

// Spreadsheet programs run text that starts with = + - or @ as a formula, so defuse those
export const csvCell = value => {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
export function downloadCsv(filename, header, rows) {
  const body = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
  const link = h('a', {
    href: URL.createObjectURL(new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' })),
    download: filename,
  });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

// Small CSV reader: handles quotes, commas and line breaks inside quotes. Returns objects keyed by header.
export function parseCsv(textInput) {
  const text = textInput.replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', quoted = false;
  const delimiter = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(v => v.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(v => v.trim() !== '')) rows.push(row);
  const [header = [], ...data] = rows;
  return data.map(r => Object.fromEntries(header.map((key, i) => [key.trim(), (r[i] ?? '').trim()])));
}

export const humanize = value => value.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase());
export const errorText = error => (error.code === 'network' ? 'Could not reach the server. Try again.' : error.message);

// Camera addresses often carry a login (rtsp://user:pass@host/stream). Hide that part until asked.
export function maskSecrets(url) {
  return String(url ?? '')
    .replace(/(\/\/)[^/@\s?#]*@/, '$1••••@')
    .replace(/([?&;](?:user(?:name)?|usr|pass(?:word)?|pwd|token|key|auth|secret)=)[^&#\s]*/gi, '$1••••');
}

// A random password that avoids look-alike characters (0/O, 1/l/I) so it can be read out or typed from a phone
export function generatePassword(length = 10) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const limit = 256 - (256 % alphabet.length); // reject values that would favour the first letters
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// A real combobox (ARIA 1.2 list pattern) in place of a native <datalist>. It sits on top of a hidden <select>,
// which keeps holding the value, so existing code that reads select.value keeps working.
// The list opens on focus, narrows as you type (all words must match), and works with arrow keys, Enter and Esc.
export function createCombobox(select, { placeholder = '', allowNone = false, noneLabel = 'None' } = {}) {
  const id = select.id;
  const input = h('input', { class: 'input adm-combo-input', type: 'text', id: `${id}Text`, role: 'combobox', autocomplete: 'off', spellcheck: 'false',
    'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': `${id}-listbox`, placeholder });
  const list = h('ul', { class: 'adm-combo-list', id: `${id}-listbox`, role: 'listbox', hidden: true });
  const arrow = h('button', { class: 'adm-combo-btn', type: 'button', tabindex: '-1', 'aria-hidden': 'true', text: '▾',
    onmousedown: event => { event.preventDefault(); if (list.hidden) { input.focus(); open(false); } else close(); } });
  const wrap = h('div', { class: 'adm-combo' }, input, arrow, list);
  select.hidden = true;
  select.after(wrap);
  document.querySelector(`label[for="${id}"]`)?.setAttribute('for', input.id);
  let shown = [];
  let active = -1;
  let typed = false; // false: show every option (just opened); true: filter by the text

  const options = () => [...select.options].filter(o => o.value).map(o => ({ value: o.value, label: o.textContent }));
  const labelOfValue = () => (select.value ? select.selectedOptions[0]?.textContent || '' : '');

  function filtered() {
    const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let items = options();
    if (typed && words.length) {
      items = items.filter(o => words.every(w => o.label.toLowerCase().includes(w)));
      const q = input.value.trim().toLowerCase();
      items.sort((a, b) => Number(b.label.toLowerCase().startsWith(q)) - Number(a.label.toLowerCase().startsWith(q)));
    }
    return allowNone && !(typed && words.length) ? [{ value: '', label: noneLabel }, ...items] : items;
  }
  function draw() {
    shown = filtered();
    list.replaceChildren(...(shown.length
      ? shown.map((o, i) => h('li', { class: 'adm-combo-opt', role: 'option', id: `${id}-opt-${i}`, 'aria-selected': String(o.value === select.value && (o.value || !select.value)), text: o.label,
        onmousedown: event => { event.preventDefault(); choose(i); } }))
      : [h('li', { class: 'adm-combo-empty', role: 'presentation', text: 'No match. Keep typing or clear the box.' })]));
    setActive(shown.length ? Math.max(0, typed ? 0 : shown.findIndex(o => o.value === select.value)) : -1);
  }
  function setActive(i) {
    active = i;
    list.querySelectorAll('.adm-combo-opt').forEach((li, k) => li.classList.toggle('active', k === i));
    if (i >= 0) { input.setAttribute('aria-activedescendant', `${id}-opt-${i}`); list.children[i]?.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }
  function open(fromTyping) {
    typed = fromTyping;
    draw();
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (fromTyping) announce(shown.length ? `${shown.length} match${shown.length === 1 ? '' : 'es'}` : 'No matches');
  }
  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  function choose(i) {
    const o = shown[i];
    if (!o) return;
    select.value = o.value;
    input.value = o.value ? o.label : '';
    close();
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  input.addEventListener('focus', () => input.select()); // the list opens on click, typing, the arrow button or the Down key
  input.addEventListener('click', () => { if (list.hidden) open(false); });
  input.addEventListener('input', () => {
    open(true);
    if (!input.value.trim() && allowNone) { select.value = ''; select.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (list.hidden) return open(false);
      if (shown.length) setActive((active + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
    } else if (event.key === 'Enter' && !list.hidden) {
      event.preventDefault(); // choosing must not submit the dialog
      if (active >= 0) choose(active);
    } else if (event.key === 'Escape' && !list.hidden) {
      event.preventDefault();
      event.stopPropagation(); // closes the list, not the dialog
      input.value = labelOfValue();
      close();
    } else if (event.key === 'Tab' && !list.hidden && typed && active >= 0 && shown.length === 1) choose(active);
  });
  input.addEventListener('blur', () => { close(); input.value = labelOfValue(); }); // typed text that was never picked is dropped
  select.comboInput = input;
  select.syncCombo = () => { input.value = labelOfValue(); close(); };
  return input;
}
