# portfolio-demo bespoke content

Source-of-truth copy of the bespoke content deployed to the live
`portfolio-demo` service at
<https://portfolio-demo.ironforge.rickycaballero.com>.

## Why this directory exists

Ironforge's deprovision flow recreates the GitHub repo from the template
on next provision. If `portfolio-demo` is ever DELETEd and re-POSTed,
bespoke commits to `ironforge-svc/portfolio-demo` are wiped and the
deployed repo reverts to the template default. This directory is the
recovery source — the bespoke `index.html` is regenerated from here, not
reconstructed from memory.

## What's in here

- `index.html` — the Ironforge-narrative landing page (replaces template
  default). Contains hardcoded `portfolio-demo` references and inline
  CSS overrides for prose layout.

Other files (`404.html`, `style.css`, `README.md`,
`.github/workflows/deploy.yml`, `.gitignore`) stay at template defaults
in the deployed repo. If a template default changes, the deployed copy
gets the new version on next re-provision; nothing to mirror here.

## How to deploy

After provisioning (or re-provisioning) `portfolio-demo`:

```sh
git clone https://github.com/ironforge-svc/portfolio-demo.git /tmp/portfolio-demo
```

```sh
cp /home/ricky/Projects/ironforge/demo/portfolio-demo-content/index.html /tmp/portfolio-demo/index.html
```

```sh
cd /tmp/portfolio-demo && git add index.html && git commit -m "feat: bespoke portfolio narrative content" && git push origin main
```

The deploy workflow runs on push to `main`, syncs to S3, and invalidates
the CloudFront cache. Live within ~30 seconds.

## How to update the bespoke content

1. Edit `demo/portfolio-demo-content/index.html` here in the monorepo
2. Commit to the Ironforge repo
3. Run the deploy procedure above

The monorepo copy is the source of truth; the deployed copy is a mirror.
Don't edit the deployed copy directly without back-porting to here.
