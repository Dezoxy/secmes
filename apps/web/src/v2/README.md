# Argus UI v2

Purpose: isolated workspace for the **Minimal Messenger OS** redesign.

This folder is exposed only through the `/v2` sketch routes. The current production UI stays under
`features/` and `routes/`; v2 does not replace `/chat` or any existing v1 URL yet.

## Direction

V2 should feel like a sparse, fast, command-driven encrypted messenger:

- ultra-thin app rail
- top command/search layer
- collapsible conversation switcher
- chat thread as the primary surface
- tiny factual security state: `Verified`, `MLS`
- no purple/glow/cyber styling
- no heavy trust dashboard

## Folder Map

```text
v2/
  design/        # tokens, visual rules, density, motion
  shell/         # app rail, command bar, conversation switcher
  chat/          # thread, message, composer, attachment surfaces
  routes/        # future v2 route adapters and feature-flagged entry points
  mocks/         # static prototype data for visual sketches and tests
```

## Boundary Rules

- Keep v2 imports behind explicit `/v2` sketch routes or a future feature flag.
- Prefer stable shared code from `src/lib` over copying business logic.
- Avoid importing v1 feature components directly; use small adapters when needed.
- Keep early v2 work prototype-sized and reversible.
