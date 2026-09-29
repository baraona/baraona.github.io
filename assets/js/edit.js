// On-page editor for baraona.org.
//
// Visitors never see it. It only wakes up in a browser that has signed in,
// either here (the Edit link in the footer, or ?edit on any page) or at /admin.
//
// The templates describe what's editable with a few attributes, each holding
// a path into the _data files ("news.items.0.text" is items[0].text in
// _data/news.yml):
//   data-edit="path"        text you can type into (data-edit-type="markdown"
//                           opens a text box, "list" is comma-separated)
//   data-edit-url="path"    a link's address, edited in a small popover
//   data-edit-file="path"   a photo or file you can click to replace
//   data-edit-list="path"   a list you can add to and rearrange. data-edit-kind
//                           says which lists items can be dragged between, and
//                           <template data-edit-template> holds a blank item
//                           (lists without one borrow a template of their kind)
//   data-edit-item="path"   one item in a list, which you can move or remove
//
// Edits change a working copy of the data. Save compares it with the
// original, applies only the differences to each file so comments and
// formatting are kept, and commits everything to GitHub in one commit.

const REPO = 'baraona/baraona.github.io';
const BRANCH = 'master';
const TOKEN_KEY = 'baraona-edit-token';
const CMS_KEY = 'sveltia-cms.user'; // written by the /admin editor
const YAML_LIB = 'https://cdn.jsdelivr.net/npm/yaml@2.9.1/+esm';
const YAML_FORMAT = { lineWidth: 0, flowCollectionPadding: false };
const THEME = '_data/theme.yml';
const FONTS = '_data/fonts.yml';
const KEY_ATTRS = ['data-edit', 'data-edit-url', 'data-edit-file', 'data-edit-list', 'data-edit-item'];
const MAX_UPLOAD = 50 * 1024 * 1024;

const COLOR_LABELS = {
  accent: 'Accent (links)',
  text: 'Text',
  text_soft: 'Soft text',
  text_faint: 'Faint text (dates)',
  lines: 'Lines',
  background: 'Background',
};

let token = readToken();
let YAML; // the yaml library, loaded when editing starts
let editing = false;
const data = {}; // file -> contents when Edit was clicked
const work = {}; // file -> working copy with your edits
const origin = new WeakMap(); // list item in work -> { list, index } it came from in data
const uploads = new Map(); // repo path -> base64 contents of a new file
let fonts;
let ui;

if (token || new URLSearchParams(location.search).has('edit')) boot();

// ------------------------------------------------------------
// Sign-in
// ------------------------------------------------------------

function readToken() {
  try {
    const own = localStorage.getItem(TOKEN_KEY);
    if (own) return own;
    const cms = JSON.parse(localStorage.getItem(CMS_KEY));
    return (cms && cms.backendName === 'github' && cms.token) || null;
  } catch {
    return null;
  }
}

function signOut() {
  if (isDirty() && !confirm('Sign out and discard your unsaved changes?')) return;
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(CMS_KEY);
  } catch {}
  discard();
}

function showSignIn() {
  const box = el(`
    <dialog class="edit-signin">
      <form method="dialog">
        <h2>Sign in to edit</h2>
        <p>Paste a GitHub token with <b>Contents: Read and write</b> access to
          <code>${REPO}</code>. It stays in this browser only.
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">Make a token</a></p>
        <input name="token" type="password" autocomplete="off" placeholder="github_pat_…" required />
        <p class="edit-error" hidden></p>
        <div class="edit-row">
          <button value="cancel" formnovalidate>Cancel</button>
          <button class="edit-primary" value="ok">Sign in</button>
        </div>
      </form>
    </dialog>`);
  ui.append(box);
  const form = box.querySelector('form');
  const err = box.querySelector('.edit-error');
  form.addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    token = form.token.value.trim();
    try {
      await gh('');
      localStorage.setItem(TOKEN_KEY, token);
      box.close();
      box.remove();
      showBar();
    } catch (error) {
      token = null;
      err.textContent = error.message;
      err.hidden = false;
    }
  });
  box.showModal();
}

// ------------------------------------------------------------
// GitHub
// ------------------------------------------------------------

async function gh(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  if (res.ok) return res.json();
  const error = new Error(
    res.status === 401 ? 'GitHub didn’t accept that token. It may have expired or been deleted.' :
    res.status === 403 || res.status === 404 ? 'That token can’t change this site. It needs Contents: Read and write on ' + REPO + '.' :
    `GitHub returned an error (${res.status}). Try again in a minute.`
  );
  error.status = res.status;
  throw error;
}

async function readFile(path, ref) {
  const file = await gh(`/contents/${path}?ref=${ref}`);
  const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, '')), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function commitChanges() {
  const ref = await gh(`/git/ref/heads/${BRANCH}`);
  const head = await gh(`/git/commits/${ref.object.sha}`);
  const tree = [];
  const names = [];
  for (const file of Object.keys(work)) {
    if (same(work[file], data[file])) continue;
    const text = await readFile(file, head.sha);
    if (!same(YAML.parse(text) ?? {}, data[file])) {
      throw new Error(`${short(file)} was changed somewhere else after you clicked Edit. Reload the page and make your edits again.`);
    }
    const doc = YAML.parseDocument(text);
    seqs = new Map();
    indexSeqs(doc.contents, data[file]);
    doc.contents = sync(doc, doc.contents, data[file], work[file]);
    tree.push({ path: file, mode: '100644', type: 'blob', content: doc.toString(YAML_FORMAT) });
    names.push(short(file));
  }
  for (const [path, base64] of liveUploads()) {
    const blob = await gh('/git/blobs', { method: 'POST', body: { content: base64, encoding: 'base64' } });
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    names.push(path.split('/').pop());
  }
  const newTree = await gh('/git/trees', { method: 'POST', body: { base_tree: head.tree.sha, tree } });
  const commit = await gh('/git/commits', {
    method: 'POST',
    body: { message: `Edit ${names.join(', ')} from the site`, tree: newTree.sha, parents: [head.sha] },
  });
  await gh(`/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: { sha: commit.sha } });
}

// ------------------------------------------------------------
// Data
// ------------------------------------------------------------

// "news.items.0.text" -> { file: "_data/news.yml", keys: ["items", 0, "text"] }
function parseKey(key) {
  const [file, ...keys] = key.split('.');
  return { file: `_data/${file}.yml`, keys: keys.map((k) => (/^\d+$/.test(k) ? Number(k) : k)) };
}

function getPath(key, from = work) {
  const { file, keys } = parseKey(key);
  return keys.reduce((o, k) => (o == null ? undefined : o[k]), from[file]);
}

function setPath(key, value) {
  const { file, keys } = parseKey(key);
  let o = (work[file] ??= {});
  keys.slice(0, -1).forEach((k, i) => {
    if (o[k] == null || typeof o[k] !== 'object') o[k] = typeof keys[i + 1] === 'number' ? [] : {};
    o = o[k];
  });
  o[keys.at(-1)] = value;
}

function deletePath(key) {
  const { file, keys } = parseKey(key);
  const parent = keys.slice(0, -1).reduce((o, k) => (o == null ? undefined : o[k]), work[file]);
  if (parent && typeof parent === 'object') delete parent[keys.at(-1)];
}

function setField(key, value, type) {
  if (type === 'list') value = value.split(',').map((s) => s.trim()).filter(Boolean);
  if (value === '' || (Array.isArray(value) && !value.length)) {
    deletePath(key); // an empty field is left out, which hides it on the site
  } else {
    const old = getPath(key);
    if (typeof old === 'string' && old.endsWith('\n') && typeof value === 'string') value += '\n';
    setPath(key, value);
  }
  refreshBar();
}

function toText(value, type) {
  if (value == null) return '';
  if (type === 'list') return [].concat(value).join(', ');
  return String(value).trim();
}

// Copy data, remembering where each list item came from so Save can keep its formatting.
function clone(value) {
  if (Array.isArray(value)) {
    return value.map((item, i) => {
      const copy = clone(item);
      if (isObject(copy)) origin.set(copy, { list: value, index: i });
      return copy;
    });
  }
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
  return value;
}

// Each list in the file's data -> its YAML node, so an item moved between lists
// in the same file keeps its formatting.
let seqs = new Map();
function indexSeqs(node, value) {
  if (Array.isArray(value) && YAML.isSeq(node)) {
    seqs.set(value, node);
    value.forEach((v, i) => indexSeqs(node.items[i], v));
  } else if (isObject(value) && YAML.isMap(node)) {
    Object.entries(value).forEach(([k, v]) => indexSeqs(node.get(k, true), v));
  }
}

// Bring a YAML node in line with `next`, reusing every part that didn't change.
function sync(doc, node, orig, next) {
  if (node && same(orig, next)) return node;
  if (Array.isArray(next) && Array.isArray(orig) && YAML.isSeq(node) && next.every(isObject)) {
    const spaced = node.items.some((n, i) => i > 0 && n.spaceBefore); // blank lines between items
    node.items = next.map((item) => {
      // Reuse the item's YAML if it was in this list before (moved within it or untouched).
      const from = origin.get(item);
      if (from && from.list === orig && node.items[from.index]) return sync(doc, node.items[from.index], orig[from.index], item);
      const elsewhere = from && seqs.get(from.list)?.items[from.index]; // moved here from another list
      return elsewhere ? sync(doc, elsewhere.clone(), from.list[from.index], item) : newNode(doc, item);
    });
    node.items.forEach((n, i) => { n.spaceBefore = spaced && i > 0; }); // moved-in items follow this list's spacing
    node.flow = false; // an empty `items: []` becomes a normal list once it has entries
    return node;
  }
  if (isObject(next) && isObject(orig) && YAML.isMap(node)) {
    Object.keys(orig).filter((k) => !(k in next)).forEach((k) => node.delete(k));
    for (const [k, v] of Object.entries(next)) {
      const child = node.get(k, true);
      const synced = k in orig ? sync(doc, child, orig[k], v) : newNode(doc, v);
      if (synced !== child) node.set(k, synced);
    }
    return node;
  }
  if (YAML.isScalar(node) && !isObject(next) && !Array.isArray(next)) {
    node.value = next;
    return node;
  }
  const fresh = newNode(doc, next);
  if (YAML.isSeq(node) && YAML.isSeq(fresh)) fresh.flow = node.flow;
  return fresh;
}

// New YAML in the same style as the hand-written files: fields in the usual
// order, and short lists like skills on one line.
const FIELD_ORDER = ['heading', 'title', 'name', 'label', 'file', 'caption', 'where', 'date', 'dates', 'text',
  'description', 'skills', 'detail', 'year', 'url', 'alt', 'image', 'image_alt', 'links', 'items'];
function newNode(doc, value) {
  const rank = (k) => (FIELD_ORDER.includes(k) ? FIELD_ORDER.indexOf(k) : FIELD_ORDER.length);
  const order = (v) => Array.isArray(v) ? v.map(order)
    : isObject(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => rank(a) - rank(b)).map(([k, x]) => [k, order(x)]))
    : v;
  const node = doc.createNode(order(value));
  const flowLists = (n) => {
    if (YAML.isSeq(n) && n.items.length && n.items.every(YAML.isScalar)) n.flow = true;
    if (YAML.isCollection(n)) n.items.forEach((item) => flowLists(YAML.isPair(item) ? item.value : item));
  };
  flowLists(node);
  return node;
}

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (file) => file.replace('_data/', '');

// New files that something still points to (a file added then removed isn't uploaded).
function liveUploads() {
  const all = JSON.stringify(work);
  return [...uploads].filter(([path]) => all.includes(path));
}

function isDirty() {
  return Object.keys(work).some((f) => !same(work[f], data[f])) || liveUploads().length > 0;
}

// ------------------------------------------------------------
// Toolbar
// ------------------------------------------------------------

function boot() {
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/assets/css/edit.css';
  document.head.append(css);
  ui = el('<div id="edit-ui"></div>');
  document.body.append(ui);
  if (token) showBar();
  else showSignIn();
  if (new URLSearchParams(location.search).has('edit')) history.replaceState(null, '', location.pathname + location.hash);
}

function showBar() {
  ui.querySelector('.edit-bar')?.remove();
  const bar = el(`
    <div class="edit-bar" role="toolbar" aria-label="Site editor">
      <span class="edit-status" role="status"></span>
      <button data-act="edit" class="edit-primary">Edit page</button>
      <button data-act="theme" hidden>Colors and fonts</button>
      <button data-act="cancel" hidden>Cancel</button>
      <button data-act="save" class="edit-primary" hidden disabled>Save</button>
      <button data-act="signout" class="edit-quiet" title="Sign out of the editor in this browser">Sign out</button>
    </div>`);
  ui.append(bar);
  bar.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'edit') startEditing();
    if (act === 'theme') toggleThemePanel();
    if (act === 'cancel') cancel();
    if (act === 'save') save();
    if (act === 'signout') signOut();
  });
}

function status(text, isError) {
  const s = ui.querySelector('.edit-status');
  s.textContent = text;
  s.classList.toggle('is-error', Boolean(isError));
}

function refreshBar() {
  const bar = ui.querySelector('.edit-bar');
  const button = (act) => bar.querySelector(`[data-act="${act}"]`);
  button('edit').hidden = editing;
  button('signout').hidden = editing;
  button('theme').hidden = !editing;
  button('cancel').hidden = !editing;
  button('save').hidden = !editing;
  button('save').disabled = !editing || !isDirty();
}

// ------------------------------------------------------------
// Editing
// ------------------------------------------------------------

async function startEditing() {
  status('Loading…');
  try {
    YAML = YAML || (await import(YAML_LIB));
    const keys = [...document.querySelectorAll(KEY_ATTRS.map((a) => `[${a}]`).join())]
      .flatMap((node) => KEY_ATTRS.map((a) => node.getAttribute(a)).filter(Boolean));
    const files = new Set([THEME, FONTS, ...keys.map((k) => parseKey(k).file)]);
    await Promise.all([...files].map(async (f) => {
      data[f] = YAML.parse(await readFile(f, BRANCH)) ?? {};
      work[f] = clone(data[f]);
    }));
    fonts = data[FONTS];
  } catch (error) {
    status(error.message, true);
    return;
  }
  editing = true;
  document.documentElement.classList.add('is-editing');
  decorate(document.body);
  status('Click any text to edit it. Hover over an item to move or remove it.');
  refreshBar();
}

// Make everything inside root editable and add the add/remove buttons.
function decorate(root) {
  within(root, '[data-edit]').forEach(makeEditable);
  within(root, '[data-edit-file]').forEach((f) => { f.title = 'Click to upload a replacement'; });
  within(root, '[data-edit-item]').forEach(addItemTools);
  within(root, '[data-edit-list]').forEach(addListButton);
}

function within(root, selector) {
  return [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)];
}

function makeEditable(field) {
  const type = field.dataset.editType || 'text';
  if (type === 'markdown') {
    field.tabIndex = 0;
    field.title = 'Click to edit';
    return;
  }
  // Show what's in the repo now, in case the site hasn't rebuilt since the last save.
  const value = toText(getPath(field.dataset.edit), type);
  if (value !== field.textContent.trim()) field.textContent = value;
  field.contentEditable = 'plaintext-only';
  if (field.contentEditable !== 'plaintext-only') field.contentEditable = 'true';
}

function stopEditing() {
  editing = false;
  document.documentElement.classList.remove('is-editing');
  document.querySelectorAll('.edit-control').forEach((c) => c.remove());
  document.querySelectorAll(KEY_ATTRS.map((a) => `[${a}]`).join()).forEach((f) => {
    f.removeAttribute('contenteditable');
    f.removeAttribute('tabindex');
    f.removeAttribute('title');
  });
  hideLinkPop();
  ui.querySelector('.edit-theme')?.remove();
  applyTheme();
  refreshBar();
}

function cancel() {
  if (isDirty() && !confirm('Discard your unsaved changes?')) return;
  discard();
}

function discard() {
  Object.keys(work).forEach((f) => { work[f] = data[f]; });
  uploads.clear();
  location.reload();
}

async function save() {
  // Items added but never filled in aren't saved.
  [...document.querySelectorAll('[data-edit-item]')].reverse().forEach((item) => {
    const value = getPath(item.dataset.editItem);
    if (isObject(value) && !Object.keys(value).length) removeItem(item);
  });
  if (!isDirty()) { stopEditing(); status('Nothing to save.'); return; }
  const button = ui.querySelector('[data-act="save"]');
  button.disabled = true;
  status('Saving…');
  try {
    try {
      await commitChanges();
    } catch (error) {
      if (error.status !== 422) throw error;
      await commitChanges(); // someone else committed at the same moment; retry on top of it
    }
  } catch (error) {
    status(error.message, true);
    button.disabled = false;
    return;
  }
  uploads.clear();
  stopEditing();
  status('Saved. The live site updates in about a minute.');
}

// ------------------------------------------------------------
// Adding and removing
// ------------------------------------------------------------

function itemsOf(list) {
  return [...list.querySelectorAll('[data-edit-item]')].filter((i) => i.parentElement.closest('[data-edit-list]') === list);
}

function templatesFor(list) {
  const own = [...list.children].filter((c) => c.matches('template[data-edit-template]'));
  return own.length ? own : [...document.querySelectorAll(`template[data-edit-template][data-kind="${list.dataset.editKind}"]`)];
}

function addListButton(list) {
  const buttons = templatesFor(list).map((template) => {
    const label = template.dataset.label || list.dataset.addLabel || 'Add';
    const button = el(`<button type="button" class="edit-add edit-control" data-tool="add">+ ${label}</button>`);
    button.list = list;
    button.template = template;
    return button;
  });
  if (!buttons.length) return;
  const row = buttons.length > 1 ? el('<div class="edit-add-row edit-control"></div>') : null;
  if (row) row.append(...buttons);
  const node = row || buttons[0];
  if (list.dataset.add === 'start') list.before(node);
  else list.after(node);
}

function addItemTools(item) {
  item.querySelector(':scope > .edit-item-tools')?.remove();
  if (item.matches('[data-edit-url]') || item.querySelector(':scope > [data-edit-url]')) return; // links use the link popover
  const list = item.parentElement.closest('[data-edit-list]');
  const name = (list && list.dataset.itemName) || 'item';
  const hasImage = Boolean(item.querySelector('.entry-media'));
  const image = !item.matches('.entry') ? ''
    : hasImage ? `<button type="button" data-tool="unimage" title="Remove image" aria-label="Remove image">${ICONS.noImage}</button>`
    : `<button type="button" data-tool="image" title="Add image" aria-label="Add image">${ICONS.image}</button>`;
  const tools = el(`
    <div class="edit-item-tools edit-control">
      <button type="button" class="edit-handle" data-tool="drag" title="Drag to move (or use the arrow keys)" aria-label="Move ${name}">${ICONS.grip}</button>
      ${image}
      <button type="button" data-tool="remove" title="Remove ${name}" aria-label="Remove ${name}">${ICONS.remove}</button>
    </div>`);
  const handle = tools.querySelector('.edit-handle');
  handle.addEventListener('pointerdown', (e) => startDrag(e, item));
  handle.addEventListener('keydown', (e) => {
    const step = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key];
    if (!step) return;
    e.preventDefault();
    nudge(item, step);
    item.querySelector(':scope > .edit-item-tools .edit-handle')?.focus();
  });
  item.append(tools);
}

const ICONS = {
  grip: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><g fill="currentColor"><circle cx="5.5" cy="3.5" r="1.3"/><circle cx="10.5" cy="3.5" r="1.3"/><circle cx="5.5" cy="8" r="1.3"/><circle cx="10.5" cy="8" r="1.3"/><circle cx="5.5" cy="12.5" r="1.3"/><circle cx="10.5" cy="12.5" r="1.3"/></g></svg>',
  remove: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  image: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2.5 11.5l3.5-3.5 3 3 2-2 2.5 2.5"/></g></svg>',
  noImage: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 14L14 2"/></g></svg>',
};

function addItem(list, template = templatesFor(list)[0]) {
  const listKey = list.dataset.editList;
  let items = getPath(listKey);
  if (!Array.isArray(items)) { items = []; setPath(listKey, items); }
  const atStart = list.dataset.add === 'start';
  const index = atStart ? 0 : items.length;
  items.splice(index, 0, {});

  const item = template.content.cloneNode(true).firstElementChild;
  for (const node of [item, ...item.querySelectorAll('*')]) {
    for (const a of KEY_ATTRS) {
      if (node.hasAttribute(a)) node.setAttribute(a, node.getAttribute(a).replace('__KEY__', `${listKey}.${index}`));
    }
  }
  const existing = itemsOf(list);
  if (atStart && existing.length) existing[0].before(item);
  else if (!atStart && existing.length) existing.at(-1).after(item);
  else list.prepend(item);

  renumber();
  decorate(item);
  refreshBar();
  const link = item.matches('[data-edit-url]') ? item : item.querySelector(':scope > [data-edit-url]');
  (link || item.querySelector('[data-edit]') || item).focus?.();
  if (link) showLinkPop(link); // a new link needs an address
  return item;
}

function removeItem(item) {
  const key = item.dataset.editItem;
  const cut = key.lastIndexOf('.');
  const listKey = key.slice(0, cut);
  const items = getPath(listKey);
  if (Array.isArray(items)) items.splice(Number(key.slice(cut + 1)), 1);
  // A list that only existed because something was added and removed again isn't saved.
  if (Array.isArray(items) && !items.length && getPath(listKey, data) === undefined) deletePath(listKey);
  if (item.contains(document.activeElement)) hideLinkPop();
  item.remove();
  renumber();
  refreshBar();
}

// Move an item to position `index` of `list` (which can be another list of the same kind).
function moveItem(item, list, index) {
  const key = item.dataset.editItem;
  const cut = key.lastIndexOf('.');
  const value = getPath(key.slice(0, cut)).splice(Number(key.slice(cut + 1)), 1)[0];
  let target = getPath(list.dataset.editList);
  if (!Array.isArray(target)) { target = []; setPath(list.dataset.editList, target); }
  target.splice(index, 0, value);

  const others = itemsOf(list).filter((i) => i !== item);
  if (index < others.length) others[index].before(item);
  else if (others.length) others.at(-1).after(item);
  else list.prepend(item);
  renumber();
  refreshBar();
  item.classList.add('edit-moved');
  setTimeout(() => item.classList.remove('edit-moved'), 600);
}

function nudge(item, step) {
  const list = item.parentElement.closest('[data-edit-list]');
  const index = itemsOf(list).indexOf(item) + step;
  if (index >= 0 && index < itemsOf(list).length) moveItem(item, list, index);
}

// Dragging by the handle. Works with a mouse, trackpad, or finger. Items can be
// dropped anywhere in a list of the same kind, or onto a closed folder.
function startDrag(e, item) {
  if (e.button > 0) return;
  e.preventDefault();
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  const kind = item.parentElement.closest('[data-edit-list]').dataset.editKind;
  const marker = el('<div class="edit-drop-marker"></div>');
  ui.append(marker);
  item.classList.add('is-dragging');
  let drop = null;
  let target = null;

  const move = (ev) => {
    if (ev.clientY < 60) scrollBy(0, -14);
    if (ev.clientY > innerHeight - 60) scrollBy(0, 14);
    drop = findDrop(ev.clientX, ev.clientY, item, kind);
    target?.classList.remove('is-drop-target');
    target = drop && drop.folder;
    target?.classList.add('is-drop-target');
    marker.hidden = !drop || Boolean(drop.folder);
    if (drop && !drop.folder) {
      Object.assign(marker.style, {
        top: `${drop.line.top + scrollY}px`, left: `${drop.line.left + scrollX}px`,
        width: `${drop.line.width}px`, height: `${drop.line.height}px`,
      });
    }
  };
  const end = (ev) => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    marker.remove();
    target?.classList.remove('is-drop-target');
    item.classList.remove('is-dragging');
    if (ev.type === 'pointerup' && drop) moveItem(item, drop.list, drop.index);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

// Which list of this kind the pointer is "in": the smallest part of the page around
// the pointer that holds exactly one such list (so a section's heading counts as
// its list), or failing that, the closest one.
function nearestList(x, y, item, kind) {
  const selector = `[data-edit-list][data-edit-kind="${kind}"]`;
  const usable = (list) => !item.contains(list) && list.offsetParent;
  let candidates = [...document.querySelectorAll(selector)].filter(usable);
  for (let node = document.elementFromPoint(x, y); node && node !== document.body; node = node.parentElement) {
    const inside = [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)].filter(usable);
    if (inside.length === 1) return inside[0];
    if (inside.length > 1) { candidates = inside; break; }
  }
  const distance = (list) => {
    const r = list.getBoundingClientRect();
    return Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
  };
  return candidates.reduce((a, b) => (distance(b) < distance(a) ? b : a), item.parentElement.closest('[data-edit-list]'));
}

function findDrop(x, y, item, kind) {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  const folder = hit.closest('.folder-open')?.closest('.tile--folder'); // over a folder's cover: drop into it
  if (kind === 'gallery' && folder && folder !== item && !item.contains(folder)) {
    const list = folder.querySelector(':scope > .folder-view > [data-edit-list]');
    return { list, index: 0, folder };
  }
  const list = nearestList(x, y, item, kind);
  const items = itemsOf(list).filter((i) => i !== item && i.offsetParent);
  if (!items.length) {
    const r = list.getBoundingClientRect();
    return { list, index: 0, line: { top: r.top, left: r.left, width: Math.max(r.width, 40), height: 2 } };
  }
  const rects = items.map((i) => i.getBoundingClientRect());
  const dist = (r) => Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
  const n = rects.indexOf(rects.reduce((a, b) => (dist(b) < dist(a) ? b : a)));
  const r = rects[n];
  const style = getComputedStyle(list);
  const inRow = style.display.includes('flex') && !style.flexDirection.startsWith('column');
  const before = inRow ? x < r.left + r.width / 2 : y < r.top + r.height / 2;
  const line = inRow
    ? { top: r.top, left: before ? r.left - 4 : r.right + 2, width: 2, height: r.height }
    : { top: before ? r.top - 3 : r.bottom + 1, left: r.left, width: r.width, height: 2 };
  return { list, index: n + (before ? 0 : 1), line };
}

// After adding, moving, or removing, give every item the path of its new position.
function renumber() {
  document.querySelectorAll('.tile--folder').forEach((folder) => {
    const n = itemsOf(folder.querySelector(':scope > .folder-view > [data-edit-list]')).length;
    const count = folder.querySelector(':scope > .folder-name .folder-count');
    if (count) count.textContent = `${n} ${n === 1 ? 'item' : 'items'}`;
  });
  for (const list of document.querySelectorAll('[data-edit-list]')) {
    const listKey = list.dataset.editList;
    itemsOf(list).forEach((item, i) => {
      const old = item.dataset.editItem;
      const now = `${listKey}.${i}`;
      if (old === now) return;
      for (const node of [item, ...item.querySelectorAll('*')]) {
        for (const a of KEY_ATTRS) {
          const v = node.getAttribute(a);
          if (v && (v === old || v.startsWith(old + '.'))) node.setAttribute(a, now + v.slice(old.length));
        }
      }
    });
  }
}

function runTool(button) {
  const tool = button.dataset.tool;
  const item = button.closest('[data-edit-item]');
  if (tool === 'add') {
    const { list, template } = button;
    if ('needsFile' in template.dataset) {
      chooseFile('image/*,video/*,application/pdf', (file) => {
        const added = addItem(list, template);
        assignFile(added.querySelector('[data-edit-file]'), file);
      });
    } else {
      addItem(list, template);
    }
  }
  if (tool === 'remove') {
    const inside = itemsOf(item.querySelector('[data-edit-list]') || item).length;
    if (item.matches('.tile--folder') && inside && !confirm(`Remove this folder and the ${inside} thing${inside > 1 ? 's' : ''} in it?`)) return;
    removeItem(item);
  }
  if (tool === 'image') {
    chooseFile('image/*', (file) => {
      const key = `${item.dataset.editItem}.image`;
      const media = el(`<a class="entry-media" data-edit-file="${key}" data-accept="image/*" data-folder="assets/images" title="Click to upload a replacement"></a>`);
      item.append(media);
      item.classList.add('entry--media');
      assignFile(media, file);
      addItemTools(item);
    });
  }
  if (tool === 'unimage') {
    deletePath(`${item.dataset.editItem}.image`);
    deletePath(`${item.dataset.editItem}.image_alt`);
    item.querySelector('.entry-media')?.remove();
    item.classList.remove('entry--media');
    addItemTools(item);
    refreshBar();
  }
}

// ------------------------------------------------------------
// Files
// ------------------------------------------------------------

function chooseFile(accept, then) {
  const input = el(`<input type="file" accept="${accept}" hidden />`);
  ui.append(input);
  input.addEventListener('change', () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    if (file.size > MAX_UPLOAD) { status('That file is over 50 MB. Try compressing it, or put videos on YouTube and link to them.', true); return; }
    then(file);
  });
  input.click();
}

// Upload `file` for the field at `key`. A file of the same type replaces the
// old one at the same address (so links to your CV keep working); anything
// else is saved alongside it under its own name.
function assignFile(target, file, key = target.dataset.editFile, folder = target.dataset.folder) {
  const ext = (name) => (name.match(/\.([^./]+)$/) || ['', ''])[1].toLowerCase();
  const old = String(getPath(key) || '');
  const oldPath = old.replace(/^\//, '');
  let path = oldPath;
  if (!oldPath || /^[a-z]+:/i.test(old) || ext(oldPath) !== ext(file.name)) {
    const dir = folder || oldPath.split('/').slice(0, -1).join('/') || 'assets/docs';
    const name = file.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-');
    path = `${dir}/${name}`;
    setField(key, '/' + path);
  }
  const reader = new FileReader();
  reader.onload = () => {
    uploads.set(path, reader.result.split(',')[1]);
    preview(target, URL.createObjectURL(file), file.type);
    status(`“${file.name}” will be uploaded when you save.`);
    refreshBar();
  };
  reader.readAsDataURL(file);
}

function preview(target, url, type) {
  if (target.matches('a') && !target.querySelector('img')) { target.href = url; return; }
  target.innerHTML =
    type.startsWith('image/') ? `<img src="${url}" alt="" />` :
    type.startsWith('video/') ? `<video src="${url}" controls playsinline></video>` :
    '<span class="tile-file"><span class="tile-file-ext">FILE</span></span>';
}

// ------------------------------------------------------------
// Link popover
// ------------------------------------------------------------

function showLinkPop(link) {
  if (ui.querySelector('.edit-pop')?.link === link) return;
  hideLinkPop();
  const pop = el(`
    <div class="edit-pop" role="group" aria-label="Link">
      <label>Address <input type="text" inputmode="url" placeholder="https://… or mailto:you@example.com" /></label>
      <div class="edit-row">
        <button type="button" data-pop="upload">Upload a file</button>
        <button type="button" data-pop="earlier" title="Move earlier" aria-label="Move earlier">←</button>
        <button type="button" data-pop="later" title="Move later" aria-label="Move later">→</button>
        <button type="button" data-pop="remove">Remove</button>
      </div>
    </div>`);
  pop.link = link;
  const input = pop.querySelector('input');
  input.value = getPath(link.dataset.editUrl) || '';
  input.addEventListener('input', () => {
    setField(link.dataset.editUrl, input.value.trim());
    link.href = input.value.trim() || '#';
  });
  // Keep focus in place so the popover doesn't close before a button click lands.
  pop.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  pop.addEventListener('click', (e) => {
    const act = e.target.closest('[data-pop]')?.dataset.pop;
    if (act === 'remove') removeItem(link.closest('[data-edit-item]'));
    if (act === 'earlier' || act === 'later') {
      nudge(link.closest('[data-edit-item]'), act === 'earlier' ? -1 : 1);
      const r = link.getBoundingClientRect();
      pop.style.top = `${r.bottom + scrollY + 8}px`;
      pop.style.left = `${Math.max(8, Math.min(r.left + scrollX, scrollX + innerWidth - pop.offsetWidth - 8))}px`;
    }
    if (act === 'upload') {
      chooseFile('*/*', (file) => {
        assignFile(link, file, link.dataset.editUrl, 'assets/docs');
        input.value = getPath(link.dataset.editUrl) || '';
      });
    }
  });
  pop.addEventListener('focusout', () => setTimeout(closeLinkPopIfDone));
  ui.append(pop);
  const r = link.getBoundingClientRect();
  pop.style.top = `${r.bottom + scrollY + 8}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left + scrollX, scrollX + innerWidth - pop.offsetWidth - 8))}px`;
}

function closeLinkPopIfDone() {
  const pop = ui.querySelector('.edit-pop');
  if (pop && !pop.contains(document.activeElement) && document.activeElement !== pop.link) hideLinkPop();
}

function hideLinkPop() {
  ui?.querySelector('.edit-pop')?.remove();
}

// ------------------------------------------------------------
// Markdown fields
// ------------------------------------------------------------

function openMarkdown(field) {
  const key = field.dataset.edit;
  const box = el(`
    <div class="edit-md-box edit-control">
      <textarea class="edit-md" spellcheck="true"></textarea>
      <p class="edit-hint">Links: [text](https://…) · **bold** · *italic* · blank line for a new paragraph</p>
    </div>`);
  const area = box.querySelector('textarea');
  area.value = toText(getPath(key));
  field.hidden = true;
  field.after(box);
  const fit = () => { area.style.height = 'auto'; area.style.height = area.scrollHeight + 2 + 'px'; };
  area.addEventListener('input', () => { fit(); setField(key, area.value.trim()); });
  area.addEventListener('blur', () => {
    field.innerHTML = renderMarkdown(area.value, field.tagName === 'SPAN');
    field.hidden = false;
    box.remove();
  });
  fit();
  area.focus();
}

// Enough Markdown to preview a change until the site rebuilds.
function renderMarkdown(src, inline) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const span = (s) => esc(s.trim())
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => (/^javascript:/i.test(url) ? text : `<a href="${url}">${text}</a>`))
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,;:!?])/g, '$1<em>$2</em>');
  if (!src.trim()) return '';
  if (inline) return span(src);
  return src.trim().split(/\n\s*\n/).map((p) => `<p>${span(p)}</p>`).join('\n');
}

// ------------------------------------------------------------
// Page events while editing
// ------------------------------------------------------------

document.addEventListener('input', (e) => {
  const field = editing && e.target.closest?.('[data-edit]');
  if (!field || field.dataset.editType === 'markdown') return;
  setField(field.dataset.edit, field.textContent.trim(), field.dataset.editType);
  // The same value can appear twice (a folder's name on its tile and in its header).
  document.querySelectorAll(`[data-edit="${CSS.escape(field.dataset.edit)}"]`).forEach((other) => {
    if (other !== field) other.textContent = field.textContent;
  });
});

document.addEventListener('keydown', (e) => {
  if (!editing) return;
  if (e.key === 'Escape') hideLinkPop();
  const field = e.target.closest?.('[data-edit]');
  if (!field) return;
  if (field.dataset.editType === 'markdown') {
    if (e.key === 'Enter' && e.target === field) { e.preventDefault(); openMarkdown(field); }
  } else if (e.key === 'Enter' || e.key === 'Escape') {
    e.preventDefault();
    field.blur();
  }
});

// Paste as plain text so no formatting sneaks into the files.
document.addEventListener('paste', (e) => {
  if (!editing || !e.target.closest?.('[contenteditable]')) return;
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\s+/g, ' '));
});

document.addEventListener('focusin', (e) => {
  if (!editing) return;
  const link = e.target.closest?.('[data-edit-url]');
  if (link) showLinkPop(link);
  else setTimeout(closeLinkPopIfDone);
});

document.addEventListener('click', (e) => {
  if (!editing || e.target.closest('#edit-ui')) return;
  const control = e.target.closest('.edit-control');
  if (control) {
    const tool = e.target.closest('[data-tool]');
    if (tool) { e.preventDefault(); runTool(tool); }
    return;
  }
  if (e.target.closest('[data-nav]')) return; // opening and closing folders still works
  // Don't follow links while editing: clicking a link's text edits it.
  if (e.target.closest('a, button')) e.preventDefault();
  const fileTarget = e.target.closest('[data-edit-file]');
  if (fileTarget) { chooseFile(fileTarget.dataset.accept || '*/*', (file) => assignFile(fileTarget, file)); return; }
  const field = e.target.closest('[data-edit]');
  if (field && field.dataset.editType === 'markdown' && !field.hidden) openMarkdown(field);
}, true);

window.addEventListener('beforeunload', (e) => {
  if (editing && isDirty()) e.preventDefault();
});

// ------------------------------------------------------------
// Colors and fonts
// ------------------------------------------------------------

function toggleThemePanel() {
  const open = ui.querySelector('.edit-theme');
  if (open) { open.remove(); applyTheme(); return; }

  const theme = work[THEME];
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const fontOptions = (current) => Object.keys(fonts)
    .map((name) => `<option${name === current ? ' selected' : ''}>${name}</option>`).join('');
  const colorRows = (mode) => Object.keys(theme[mode]).map((k) => `
      <label class="edit-color">
        <input type="color" data-key="theme.${mode}.${k}" value="${theme[mode][k]}" />
        <span>${COLOR_LABELS[k] || k}</span>
        <code>${theme[mode][k]}</code>
      </label>`).join('');

  const panel = el(`
    <section class="edit-theme" aria-label="Colors and fonts">
      <h2>Colors and fonts</h2>
      <label class="edit-field">Main font <small>headings and paragraphs</small>
        <select data-key="theme.text_font">${fontOptions(theme.text_font)}</select></label>
      <label class="edit-field">Detail font <small>menu, dates, and labels</small>
        <select data-key="theme.detail_font">${fontOptions(theme.detail_font)}</select></label>
      <div class="edit-tabs" role="tablist">
        <button role="tab" data-mode="light" aria-selected="${!dark}">Light mode</button>
        <button role="tab" data-mode="dark" aria-selected="${dark}">Dark mode</button>
      </div>
      <div data-colors="light"${dark ? ' hidden' : ''}>${colorRows('light')}</div>
      <div data-colors="dark"${dark ? '' : ' hidden'}>${colorRows('dark')}</div>
      <p class="edit-hint">Visitors see light or dark mode based on their device setting. The tab you pick is what you're previewing.</p>
    </section>`);
  ui.prepend(panel);

  let mode = dark ? 'dark' : 'light';
  panel.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-mode]');
    if (!tab) return;
    mode = tab.dataset.mode;
    panel.querySelectorAll('[data-mode]').forEach((t) => t.setAttribute('aria-selected', t === tab));
    panel.querySelectorAll('[data-colors]').forEach((c) => { c.hidden = c.dataset.colors !== mode; });
    applyTheme(mode);
  });
  panel.addEventListener('input', (e) => {
    const key = e.target.dataset.key;
    if (!key) return;
    setField(key, e.target.value);
    const code = e.target.parentElement.querySelector('code');
    if (code) code.textContent = e.target.value;
    applyTheme(mode);
  });
  applyTheme(mode);
}

// Same output as the <style id="theme"> block in _includes/head.html.
function applyTheme(forceMode) {
  const theme = work[THEME];
  if (!theme) return;
  const vars = (set) => Object.entries(set).map(([k, v]) => `--${k.replace(/_/g, '-')}: ${v};`).join(' ');
  const font = (name) => `'${name}', ${fonts[name] ? fonts[name].fallback : 'serif'}`;
  const base = `--font-text: ${font(theme.text_font)}; --font-detail: ${font(theme.detail_font)};`;
  document.getElementById('theme').textContent = forceMode
    ? `:root { color-scheme: ${forceMode}; ${base} ${vars(theme[forceMode])} }`
    : `:root { ${base} ${vars(theme.light)} } @media (prefers-color-scheme: dark) { :root { ${vars(theme.dark)} } }`;
  const families = [...new Set([theme.text_font, theme.detail_font].map((n) => fonts[n] && fonts[n].google).filter(Boolean))];
  document.getElementById('theme-fonts').href =
    `https://fonts.googleapis.com/css2?${families.map((f) => 'family=' + f).join('&')}&display=swap`;
}

// ------------------------------------------------------------

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
