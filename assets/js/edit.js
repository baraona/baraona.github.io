// On-page editor for baraona.org.
//
// Visitors never see it. It only wakes up in a browser that has signed in,
// either here (add ?edit to any page's address) or at /admin. Text marked
// data-edit="file.path.to.value" in the templates becomes editable in place,
// the Colors and fonts panel edits _data/theme.yml, and Save commits every
// changed _data/*.yml file to GitHub in one commit. GitHub Pages then
// rebuilds the site in about a minute.

const REPO = 'baraona/baraona.github.io';
const BRANCH = 'master';
const TOKEN_KEY = 'baraona-edit-token';
const CMS_KEY = 'sveltia-cms.user'; // written by the /admin editor
const YAML_LIB = 'https://cdn.jsdelivr.net/npm/yaml@2.9.1/+esm';
const THEME = '_data/theme.yml';
const FONTS = '_data/fonts.yml';

const COLOR_LABELS = {
  accent: 'Accent (links)',
  text: 'Text',
  text_soft: 'Soft text',
  text_faint: 'Faint text (dates)',
  lines: 'Lines',
  background: 'Background',
};

let token = readToken();
let YAML;              // the yaml library, loaded when editing starts
let editing = false;
const data = {};       // file -> contents as plain objects, read when editing starts
const changes = new Map(); // data-edit key -> { value, type }
let theme;             // working copy of theme.yml, shown live
let fonts;             // fonts.yml
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
  if (changes.size && !confirm('Sign out and discard your unsaved changes?')) return;
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(CMS_KEY);
  } catch {}
  changes.clear();
  location.reload();
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

// Apply every change to the latest version of each file and commit them together.
async function commitChanges() {
  const ref = await gh(`/git/ref/heads/${BRANCH}`);
  const head = await gh(`/git/commits/${ref.object.sha}`);
  const byFile = new Map();
  for (const [key, change] of changes) {
    const { file, keys } = parseKey(key);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ keys, ...change });
  }
  const tree = [];
  for (const [file, list] of byFile) {
    const doc = YAML.parseDocument(await readFile(file, head.sha));
    list.forEach((c) => setValue(doc, c.keys, c.value, c.type));
    tree.push({ path: file, mode: '100644', type: 'blob', content: doc.toString({ lineWidth: 0, flowCollectionPadding: false }) });
  }
  const names = [...byFile.keys()].map((f) => f.replace('_data/', ''));
  const newTree = await gh('/git/trees', { method: 'POST', body: { base_tree: head.tree.sha, tree } });
  const commit = await gh('/git/commits', {
    method: 'POST',
    body: { message: `Edit ${names.join(', ')} from the site`, tree: newTree.sha, parents: [head.sha] },
  });
  await gh(`/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: { sha: commit.sha } });
}

// ------------------------------------------------------------
// YAML
// ------------------------------------------------------------

// "news.items.0.text" -> { file: "_data/news.yml", keys: ["items", 0, "text"] }
function parseKey(key) {
  const [file, ...keys] = key.split('.');
  return { file: `_data/${file}.yml`, keys: keys.map((k) => (/^\d+$/.test(k) ? Number(k) : k)) };
}

function lookup(key) {
  const { file, keys } = parseKey(key);
  return keys.reduce((o, k) => (o == null ? o : o[k]), data[file]);
}

function toText(value, type) {
  if (value == null) return '';
  if (type === 'list') return [].concat(value).join(', ');
  return String(value).trim();
}

// Change one value in place so the file keeps its comments and formatting.
function setValue(doc, keys, value, type) {
  const node = doc.getIn(keys, true);
  if (type === 'list') {
    const list = doc.createNode(value.split(',').map((s) => s.trim()).filter(Boolean));
    list.flow = node ? Boolean(node.flow) : true;
    doc.setIn(keys, list);
  } else if (value === '') {
    doc.deleteIn(keys); // an empty field hides that line on the site
  } else if (YAML.isScalar(node)) {
    node.value = String(node.value).endsWith('\n') ? value + '\n' : value;
  } else {
    doc.setIn(keys, value);
  }
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
  button('save').disabled = !changes.size;
  button('save').textContent = changes.size ? `Save ${changes.size} change${changes.size > 1 ? 's' : ''}` : 'Save';
}

// ------------------------------------------------------------
// Editing text
// ------------------------------------------------------------

async function startEditing() {
  status('Loading…');
  try {
    YAML = YAML || (await import(YAML_LIB));
    const fields = [...document.querySelectorAll('[data-edit]')];
    const files = new Set([THEME, FONTS, ...fields.map((f) => parseKey(f.dataset.edit).file)]);
    await Promise.all([...files].map(async (f) => { data[f] = YAML.parse(await readFile(f, BRANCH)); }));
    theme = structuredClone(data[THEME]);
    fonts = data[FONTS];
    fields.forEach(makeEditable);
  } catch (error) {
    status(error.message, true);
    return;
  }
  editing = true;
  document.documentElement.classList.add('is-editing');
  status('Click any outlined text to change it.');
  refreshBar();
}

function makeEditable(field) {
  const type = field.dataset.editType || 'text';
  const value = lookup(field.dataset.edit);
  if (type === 'markdown') {
    field.tabIndex = 0;
    field.title = 'Click to edit';
    return;
  }
  // Show what's in the repo now, in case the site hasn't rebuilt since the last save.
  if (value != null && toText(value, type) !== field.textContent.trim()) field.textContent = toText(value, type);
  field.contentEditable = 'plaintext-only';
  if (field.contentEditable !== 'plaintext-only') field.contentEditable = 'true';
  field.spellcheck = true;
}

function record(key, value, type) {
  if (value === toText(lookup(key), type)) changes.delete(key);
  else changes.set(key, { value, type });
  refreshBar();
  if (changes.size) status('');
}

function openMarkdown(field) {
  const key = field.dataset.edit;
  const change = changes.get(key);
  const box = el(`
    <div class="edit-md-box">
      <textarea class="edit-md" spellcheck="true"></textarea>
      <p class="edit-hint">Links: [text](https://…) · **bold** · *italic* · blank line for a new paragraph</p>
    </div>`);
  const area = box.querySelector('textarea');
  area.value = change ? change.value : toText(lookup(key));
  field.hidden = true;
  field.after(box);
  const fit = () => { area.style.height = 'auto'; area.style.height = area.scrollHeight + 2 + 'px'; };
  area.addEventListener('input', () => { fit(); record(key, area.value.trim(), 'markdown'); });
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
  if (inline) return span(src);
  return src.trim().split(/\n\s*\n/).map((p) => `<p>${span(p)}</p>`).join('\n');
}

function cancel() {
  if (changes.size && !confirm('Discard your unsaved changes?')) return;
  changes.clear();
  location.reload();
}

async function save() {
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
  changes.clear();
  stopEditing();
  status('Saved. The live site updates in about a minute.');
}

function stopEditing() {
  editing = false;
  document.documentElement.classList.remove('is-editing');
  document.querySelectorAll('[data-edit]').forEach((f) => {
    f.removeAttribute('contenteditable');
    f.removeAttribute('tabindex');
    f.removeAttribute('title');
  });
  ui.querySelector('.edit-theme')?.remove();
  applyTheme();
  refreshBar();
}

document.addEventListener('input', (e) => {
  const field = editing && e.target.closest?.('[data-edit]');
  if (!field || field.dataset.editType === 'markdown') return;
  record(field.dataset.edit, field.textContent.trim(), field.dataset.editType || 'text');
});

document.addEventListener('keydown', (e) => {
  if (!editing) return;
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
  const text = e.clipboardData.getData('text/plain').replace(/\s+/g, ' ');
  document.execCommand('insertText', false, text);
});

document.addEventListener('click', (e) => {
  if (!editing || e.target.closest('#edit-ui')) return;
  const field = e.target.closest('[data-edit]');
  // Don't follow links while editing: clicking a link's text edits it.
  if (e.target.closest('a, button')) e.preventDefault();
  if (field && field.dataset.editType === 'markdown' && !field.hidden) openMarkdown(field);
}, true);

window.addEventListener('beforeunload', (e) => {
  if (changes.size) e.preventDefault();
});

// ------------------------------------------------------------
// Colors and fonts
// ------------------------------------------------------------

function toggleThemePanel() {
  const open = ui.querySelector('.edit-theme');
  if (open) { open.remove(); applyTheme(); return; }

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

  let preview = dark ? 'dark' : 'light';
  panel.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-mode]');
    if (!tab) return;
    preview = tab.dataset.mode;
    panel.querySelectorAll('[data-mode]').forEach((t) => t.setAttribute('aria-selected', t === tab));
    panel.querySelectorAll('[data-colors]').forEach((c) => { c.hidden = c.dataset.colors !== preview; });
    applyTheme(preview);
  });
  panel.addEventListener('input', (e) => {
    const key = e.target.dataset.key;
    if (!key) return;
    const [, ...path] = key.split('.');
    const last = path.pop();
    path.reduce((o, k) => o[k], theme)[last] = e.target.value;
    const code = e.target.parentElement.querySelector('code');
    if (code) code.textContent = e.target.value;
    record(key, e.target.value, 'text');
    applyTheme(preview);
  });
  applyTheme(preview);
}

// Same output as the <style id="theme"> block in _includes/head.html.
function applyTheme(forceMode) {
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
