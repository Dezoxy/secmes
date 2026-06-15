# Frontend Lighthouse Pass

Status: F2 pass complete (point-in-time record). Follow-ups (bundle splitting, source-map policy, iOS install proof) are tracked in [`frontend-plan.md`](frontend-plan.md).
Last run: 2026-06-09

## Local PWA Result

Command:

```bash
npm exec --yes --package lighthouse@12.6.1 -- lighthouse http://localhost:4173/chat \
  --only-categories=performance,accessibility,best-practices,seo \
  --output=json --output=html --output-path=/tmp/argus-lighthouse-f2/final \
  --chrome-flags="--headless=new --no-sandbox" --quiet
```

Scores after the F2 pass:

- Performance: 96
- Accessibility: 100
- Best practices: 100
- SEO: 100

Lighthouse 12.6.1 no longer reports the old standalone PWA category for this local run, so PWA
installability stays covered by `scripts/verify-web-pwa-build.mjs`: manifest, local icons,
Apple touch icon metadata, maskable launcher icons, service worker registration, navigation fallback,
`robots.txt`, and static-only precache policy.

## Fixed In This Pass

- Added a document description for Lighthouse and search previews.
- Added a valid static `robots.txt`, avoiding SPA fallback content at `/robots.txt`.
- Fixed chat sidebar accessible-name mismatches by keeping visible conversation text in button names.
- Raised low-contrast sidebar metadata text.
- Expanded the pull-search handle hit target while keeping the visible handle compact.

## Intentionally Deferred

- Public production source maps are not enabled here. Code-delivery hardening and published bundle
  hash work should decide source-map policy together.
- Initial bundle splitting is tracked in F6. The first pass lazy-loads route/settings/recovery surfaces
  while leaving chat and crypto startup paths eager.
- iOS installed-PWA proof remains user/device work. It needs a real iPhone Safari install test because
  desktop Lighthouse cannot prove iOS storage, install, or launch behavior.
