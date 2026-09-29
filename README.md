# baraona.org

My personal site. GitHub Pages builds it with Jekyll from the content files in
`_data/`. I never need to touch code to change it: I can edit right on the
page, or use the full editor at **https://baraona.org/admin**.

## Editing on the page

1. Sign in once per browser: go to **https://baraona.org/?edit** and paste a
   token (see below). If I'm already signed in at /admin, this step is skipped.
2. On any page, click **Edit page** (bottom right). Every piece of text I can
   change gets a dotted outline. Click it and type. Paragraphs like About
   open in a text box where `[text](https://link)`, `**bold**`, and `*italic*`
   work.
3. **Colors and fonts** opens a panel with the main and detail fonts and the
   light- and dark-mode colors. Changes show up immediately.
4. Click **Save**. All changes go into one commit, and the live site updates
   about a minute later.

Clearing a field removes it from the site (handy for the status line). To add
or remove entries, reorder them, change link addresses, or upload photos and
PDFs, use /admin.

## Editing at /admin

Go to https://baraona.org/admin, sign in, pick a section (Profile, News,
Research, Projects, Awards, Colors and fonts, Life gallery), make changes, and
click **Save**. Each save is a commit to this repo.

### One-time setup: create a sign-in token

Both editors sign in with a GitHub personal access token, which only needs to
be made once per browser.

1. GitHub → Settings → Developer settings → Personal access tokens →
   **Fine-grained tokens** → Generate new token.
2. Repository access: **Only select repositories** → `baraona/baraona.github.io`.
3. Permissions → Repository permissions → **Contents: Read and write**.
4. Pick an expiration (for example, one year) and generate it.
5. Paste it at https://baraona.org/?edit, or at https://baraona.org/admin
   under **Sign in with token**.

Keep the token private. The editors are public, but they can't change anything
without a token that has write access to this repo. **Sign out** in the
toolbar removes it from that browser. If a token ever leaks, delete it on
GitHub and make a new one.

## Where things live

| Content                              | File                   |
| ------------------------------------ | ---------------------- |
| Name, tagline, status, about, links, CV | `_data/profile.yml` |
| News                                 | `_data/news.yml`       |
| Research                             | `_data/research.yml`   |
| Projects                             | `_data/projects.yml`   |
| Honors and awards                    | `_data/awards.yml`     |
| Life gallery (baraona.org/life)      | `_data/gallery.yml`    |
| Colors and fonts                     | `_data/theme.yml`      |
| Fonts to choose from                 | `_data/fonts.yml`      |
| Layout and spacing                   | `assets/css/site.css`  |
| On-page editor                       | `assets/js/edit.js`    |
| Editor settings                      | `admin/config.yml`     |

## Life gallery

In the editor, open **Life gallery**, click **Add**, upload a photo, video, or
file, and write a caption and date. Uploads are stored in `assets/life/`.

- Photos: JPG, PNG, or WebP. iPhone HEIC photos don't display in most browsers,
  so export them as JPEG first (on iPhone: Settings → Camera → Formats →
  Most Compatible).
- Videos: MP4 works everywhere. GitHub rejects files over 100 MB, so keep
  clips short or compress them; for longer videos, upload to YouTube and
  link to them instead.
- Everything on this page is public, just like the rest of the site.
- Removing an item in the editor takes it off the site. The file itself stays
  in `assets/life/` until you delete it from the Media section of the editor.

## Editing files by hand

Copy an existing entry, paste it right under `items:`, and keep the same
indentation (spaces, never tabs). Wrap text in double quotes if it contains a
colon. If the site stops updating, the Actions tab on GitHub shows which line
has the problem.
