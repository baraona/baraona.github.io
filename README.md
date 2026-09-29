# baraona.org

My personal site. GitHub Pages builds it with Jekyll from the content files in
`_data/`, and I can edit everything in the browser at **https://baraona.org/admin**.

## Editing from the website

Go to https://baraona.org/admin, sign in, pick a section (Profile, News,
Research, Projects, Awards), make changes, and click **Save**. Each save is a
commit to this repo, and the live site updates about a minute later. Images and
PDFs can be uploaded right in the editor.

### One-time setup: create a sign-in token

The editor signs in with a GitHub personal access token, which only needs to be
made once per browser.

1. GitHub → Settings → Developer settings → Personal access tokens →
   **Fine-grained tokens** → Generate new token.
2. Repository access: **Only select repositories** → `baraona/baraona.github.io`.
3. Permissions → Repository permissions → **Contents: Read and write**.
4. Pick an expiration (for example, one year) and generate it.
5. At https://baraona.org/admin choose **Sign in with token** and paste it.

Keep the token private. The /admin page is public, but it can't change anything
without a token that has write access to this repo. If a token ever leaks,
delete it on GitHub and make a new one.

## Where things live

| Content                              | File                   |
| ------------------------------------ | ---------------------- |
| Name, tagline, status, about, links, CV | `_data/profile.yml` |
| News                                 | `_data/news.yml`       |
| Research                             | `_data/research.yml`   |
| Projects                             | `_data/projects.yml`   |
| Honors and awards                    | `_data/awards.yml`     |
| Life gallery (baraona.org/life)      | `_data/gallery.yml`    |
| Colors and fonts                     | `assets/css/site.css`  |
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
