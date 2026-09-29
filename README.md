# baraona.org

My personal site, built by GitHub Pages with Jekyll. The page is generated from
plain text files, so adding content never means touching HTML.

## Where things live

| To change...                          | Edit this file              |
| ------------------------------------- | --------------------------- |
| Name, tagline, status line, links, CV | `_config.yml`               |
| About paragraphs                      | `_includes/about.md`        |
| News                                  | `_data/news.yml`            |
| Research                              | `_data/research.yml`        |
| Projects                              | `_data/projects.yml`        |
| Honors and awards                     | `_data/awards.yml`          |
| Colors and fonts                      | top of `assets/css/site.css`|

## Adding a project (or research entry)

1. Open `_data/projects.yml` on GitHub and click the pencil icon.
2. Copy an existing entry, paste it at the top, and change the values.
3. If it has a picture, upload it to `assets/images/` and set `image:` to its path.
4. Commit. The site updates in about a minute.

Only `title` is required. Leave out any line you don't need.

## YAML tips

- Indent with spaces, never tabs, and keep the indentation the same as the other entries.
- Wrap text in double quotes if it contains a colon, like `"VitalLink: Wearable Triage System"`.
- If the site doesn't update, check the Actions tab on GitHub; a failed build
  usually points to a YAML typo on a specific line.

## Previewing locally (optional)

```
gem install bundler jekyll
jekyll serve
```

Then open http://localhost:4000.
