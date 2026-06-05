---
name: api-spec
description: Generate or refresh the OpenAPI spec for apps/api and run the 42Crunch audit on it. Use after adding or changing an API endpoint, or before an API security review, so the spec stays the source of truth that 42Crunch and the boundary auditor rely on.
---

# api-spec

The OpenAPI spec is the contract 42Crunch audits and the security-boundary-auditor checks against. Keep it accurate and high-scoring.

## Procedure
1. **Annotate** new/changed endpoints in `apps/api` with `@nestjs/swagger` decorators: `@ApiTags`, `@ApiOperation`, typed request/response DTOs, and the security scheme (`@ApiBearerAuth`). Every endpoint must declare auth unless it is deliberately public (health only).
2. **Generate** the spec:
   ```bash
   pnpm --filter @secmes/api openapi   # builds, then writes apps/api/openapi.json
   ```
3. **Audit** with 42Crunch — invoke the `42crunch-audit` skill on `apps/api/openapi.json`. Treat the Security Quality Gate as a hard gate; fix findings (missing auth, weak/unbounded schemas, missing rate-limit hints) until the score clears the threshold.
4. **Scan** (when a staging deployment exists) — invoke `42crunch-scan` for a dynamic conformance scan against the running API.

## Rules
- No undocumented routes. If the spec and the code disagree, the code is wrong until reconciled.
- Schemas must be tight: explicit types, `maxLength`/`maximum` bounds, `additionalProperties: false`. Loose schemas are how injection and DoS get in.
- Never put example secrets or real tokens in the spec.

Setup of the 42Crunch token/binary is handled once via the `42crunch-setup` skill.
