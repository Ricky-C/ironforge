# __IRONFORGE_SERVICE_NAME__

Live at https://__IRONFORGE_SERVICE_NAME__.__IRONFORGE_DOMAIN__

This repository holds the source for a static website. Every push to
`main` deploys automatically via GitHub Actions.

## Local development

Open `index.html` in a browser, or serve the directory with any static
server, for example:

```sh
python3 -m http.server 8000
```

Then visit http://localhost:8000.

## How deploys work

`.github/workflows/deploy.yml` runs on every push to `main`:

1. Authenticates to AWS via OIDC — no long-lived credentials.
2. Syncs the repository to the origin S3 bucket.
3. Invalidates the CloudFront cache so the new content is served
   immediately.

You don't need to configure secrets manually. The OIDC trust between
this repository and AWS was wired at provisioning time.

## What's deployed

Everything in the repository root **except** `.git/`, `.github/`, and
`README.md`. To exclude additional files from deployment, edit the
`--exclude` flags in `.github/workflows/deploy.yml`.

## Layout

- `index.html` — the home page.
- `404.html` — served for missing paths.
- `style.css` — site styles.
