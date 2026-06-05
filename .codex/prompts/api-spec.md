Refresh the OpenAPI spec for `apps/api` and run the 42Crunch audit.

Steps:
1. Annotate new/changed endpoints with `@nestjs/swagger` decorators: `@ApiTags`, `@ApiOperation`, typed request/response DTOs, and `@ApiBearerAuth` (every endpoint declares auth unless deliberately public — health only).
2. Generate the spec: `pnpm --filter @secmes/api openapi` (writes `apps/api/openapi.json`).
3. Run the 42Crunch audit on `apps/api/openapi.json`; treat the Security Quality Gate as a hard gate (≥ 75). Fix missing auth, loose/unbounded schemas, missing rate-limit hints.
4. When staging exists, run the 42Crunch conformance scan against the running API.

Rules: no undocumented routes (code and spec must agree); schemas tight (`additionalProperties: false`, explicit `maxLength`/`maximum`); never put real secrets/tokens in the spec.
