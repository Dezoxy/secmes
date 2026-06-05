## Summary

<!-- what changed and why -->

## Checklist

- [ ] `pnpm -r typecheck && pnpm -r test && pnpm lint && pnpm format:check` pass
- [ ] New/changed endpoints are in the OpenAPI spec (auth + tight schemas); new tables have `tenant_id` + RLS
- [ ] Security-relevant change has a `docs/threat-models/` note
- [ ] No secrets; no banned log patterns
- [ ] **Waited for the Codex (`chatgpt-codex-connector`) review and resolved its findings** — do not merge on green CI alone
