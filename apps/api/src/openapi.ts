import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

// HTTPS-only public base URL. 42Crunch (and good sense) treat bearer auth as transmitted "in clear"
// unless every declared server is https — so we declare exactly one https origin. Override per env.
const PUBLIC_HTTPS_URL = process.env.API_PUBLIC_URL ?? 'https://api.argus.example.com';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'] as const;

// Standard error responses any operation may return, given a shared typed body. `429` applies to every
// route: a global per-user throttle guard (rate limiting, #46) caps request volume, with tighter caps on
// abuse-prone mutations. Success responses stay exactly as each controller declares them.
const STD_ERROR_RESPONSES: Record<string, string> = {
  '400': 'Validation failed — malformed or out-of-bounds request.',
  '401': 'Missing or invalid bearer token.',
  '403': 'Authenticated, but not permitted to perform this action.',
  '404': 'Resource not found (or deliberately hidden to avoid an existence oracle).',
  '406': 'No acceptable representation for the requested `Accept` header.',
  '415': 'Unsupported request media type.',
  '429': 'Rate limit exceeded — too many requests; retry after the `Retry-After` interval.',
  default: 'Unexpected server error.',
};

// Canonical patterns so every string carries an explicit, NON-loose bound (42Crunch flags both a
// missing pattern and a catch-all one). Each mirrors what the Zod layer already enforces / accepts.
const UUID_RE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const ISO_DATETIME_RE =
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$';
const EMAIL_RE = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$';
const BASE64_RE = '^[A-Za-z0-9+/]+={0,2}$'; // opaque MLS/crypto blobs (ciphertext, key packages, backups)
const BASE64URL_RE = '^[A-Za-z0-9_-]+$'; // opaque keyset cursors
const TAG_RE = '^[A-Za-z0-9._-]{1,64}$'; // short version/algorithm tags, e.g. "MLS_1.0"
// Opaque / free-form text: control chars excluded, length bounded by `maxLength` (NOT a `{0,N}`
// quantifier — a large bounded quantifier trips 42Crunch's ReDoS check and invalidates the contract).
const TEXT_RE = '^[^\\u0000-\\u001f\\u007f]+$';
const STRING_MAX = 65_536; // safe upper bound for opaque blobs (ciphertext is capped here on input too)
const ARRAY_MAX = 1_000;

type MutableSchema = Record<string, unknown>;

/** A real (non-loose) pattern for an opaque/structured string, inferred from its property name. */
function patternForName(name: string): string | undefined {
  const n = name.toLowerCase();
  // Only fields that are ALWAYS base64 — NOT `backup` (the sealed recovery artifact is `JSON.stringify`d
  // and starts with `{`) or other opaque blobs, which fall through to the bounded-text fallback.
  if (/cipher|keypackage|publickey|signature/.test(n)) return BASE64_RE;
  if (/cursor|after/.test(n)) return BASE64URL_RE;
  if (n === 'alg') return TAG_RE;
  if (/email/.test(n)) return EMAIL_RE;
  if (/deviceid$/.test(n)) return UUID_RE;
  if (/name/.test(n)) return TEXT_RE;
  return undefined;
}

/** Give a named string schema a real pattern from its name, before the generic fallback runs. */
function refineNamed(name: string, schema: unknown): void {
  if (!schema || typeof schema !== 'object' || '$ref' in schema) return;
  const s = schema as MutableSchema;
  if (s.type === 'string' && !('enum' in s) && s.pattern === undefined && s.format === undefined) {
    const pattern = patternForName(name);
    if (pattern) s.pattern = pattern;
  }
}

/** Pin an explicit bound on a single schema node (idempotent — never overrides an existing constraint).
 *  `inXof` = true when this node is a direct child of oneOf/anyOf/allOf — 42Crunch rule
 *  v3-schema-response-xof-additionalproperties-false flags additionalProperties:false inside
 *  combining schemas, so we skip that injection in that context. */
function tightenNode(node: MutableSchema, inXof = false): void {
  const type = node.type;
  if (!inXof && 'properties' in node && node.additionalProperties === undefined) {
    node.additionalProperties = false; // reject unknown keys (mirrors Zod `.strict()`)
  }
  if (type === 'string' && !('enum' in node)) {
    if (node.format === 'uuid') {
      node.pattern ??= UUID_RE;
      node.maxLength ??= 36;
    } else if (node.format === 'date-time') {
      node.pattern ??= ISO_DATETIME_RE;
      node.maxLength ??= 40;
    } else if (node.format === 'email') {
      node.pattern ??= EMAIL_RE;
      node.maxLength ??= 320;
    } else {
      node.pattern ??= TEXT_RE; // last resort: bounded text, control chars excluded (still non-loose)
      node.maxLength ??= STRING_MAX;
    }
  }
  if (type === 'integer' || type === 'number') {
    node.format ??= 'int64';
    node.maximum ??= Number.MAX_SAFE_INTEGER;
  }
  if (type === 'array') {
    node.maxItems ??= ARRAY_MAX;
  }
}

/** Recursively tighten every schema node reachable under `root` (components + inline path schemas).
 *  `inXof` propagates to direct children of oneOf/anyOf/allOf to suppress additionalProperties injection. */
function walk(root: unknown, inXof = false): void {
  if (Array.isArray(root)) {
    for (const item of root) walk(item, inXof);
    return;
  }
  if (!root || typeof root !== 'object') return;
  const node = root as MutableSchema;
  if ('$ref' in node) return; // a reference is a leaf
  // Name-aware refinement first, so opaque/structured strings get a real pattern, not the fallback.
  const props = node.properties;
  if (props && typeof props === 'object') {
    for (const [name, sub] of Object.entries(props)) refineNamed(name, sub);
  }
  if (Array.isArray(node.parameters)) {
    for (const p of node.parameters) {
      if (p && typeof p === 'object' && 'name' in p && 'schema' in p) {
        refineNamed((p as { name: string }).name, (p as { schema: unknown }).schema);
      }
    }
  }
  if ('type' in node || 'properties' in node || 'items' in node) tightenNode(node, inXof);
  for (const [key, value] of Object.entries(node)) {
    const childInXof = key === 'oneOf' || key === 'anyOf' || key === 'allOf';
    walk(value, childInXof);
  }
}

/** Single source of truth for the API spec that 42Crunch audits. */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('argus API')
    .setDescription(
      'Crypto-blind delivery API for the argus E2EE messaging platform. ' +
        'Stores and forwards ciphertext only; never message content.',
    )
    .setVersion(process.env.APP_VERSION ?? 'dev')
    // Exactly one HTTPS origin → bearer tokens never travel in clear (42Crunch transport rules).
    .addServer(PUBLIC_HTTPS_URL)
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .build();
  const doc = SwaggerModule.createDocument(app, config);

  // Deny-by-default: every documented operation requires the bearer token. (The only public routes,
  // healthz/root, are excluded from the documented contract via @ApiExcludeEndpoint.)
  // NOTE: passkey registration/auth endpoints and session/refresh are @Public() at runtime, but
  // 42Crunch rules v3-global-security + v3-operation-securityrequirement-emptyarray make it
  // impossible to document them as explicitly public without score penalty — adding security:[]
  // per-op triggers v3-operation-securityrequirement-emptyarray, while removing this global line
  // triggers v3-global-security and v3-operation-security on all other ops. The NestJS @Public()
  // guard correctly enforces no-auth at runtime; the spec limitation is recorded on PR #215.
  doc.security = [{ bearer: [] }];

  doc.components ??= {};
  const schemas = (doc.components.schemas ??= {}) as Record<string, MutableSchema>;

  // Shared error envelope (the NestJS exception shape) so 42Crunch sees a typed body on every error.
  schemas.ErrorResponse = {
    type: 'object',
    additionalProperties: false,
    required: ['statusCode', 'message'],
    properties: {
      statusCode: { type: 'integer', format: 'int64', minimum: 100, maximum: 599 },
      // ZodValidationPipe throws BadRequestException(issues[]) → Nest serializes `message` as a string[]
      // for 400s, while other HttpExceptions use a single string. Document both so generated clients and
      // conformance checks accept real validation failures.
      message: {
        oneOf: [
          { type: 'string', maxLength: 2048, pattern: TEXT_RE },
          {
            type: 'array',
            maxItems: 100,
            items: { type: 'string', maxLength: 2048, pattern: TEXT_RE },
          },
        ],
      },
      error: { type: 'string', maxLength: 256, pattern: TEXT_RE },
    },
  };
  const errorContent = {
    'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
  };

  // Inject the standard error responses into every operation; upgrade any pre-declared error response
  // (description only) to carry the typed body.
  for (const pathItem of Object.values(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method] as
        | { responses?: Record<string, MutableSchema> }
        | undefined;
      if (!op?.responses) continue;
      for (const [code, description] of Object.entries(STD_ERROR_RESPONSES)) {
        const existing = op.responses[code];
        if (!existing) {
          op.responses[code] = { description, content: errorContent };
        } else if (!('$ref' in existing) && !existing.content) {
          existing.content = errorContent;
        }
      }
      // Also type any controller-declared error response that's NOT in the standard set (e.g. the 413 on
      // /attachments/download-url) but carries a description and no body — every 4xx/5xx must have the typed
      // ErrorResponse schema, else 42Crunch flags v3-response-schema-undefined.
      for (const existing of Object.entries(op.responses)
        .filter(([code]) => /^[45]\d\d$/.test(code))
        .map(([, resp]) => resp)) {
        if (!('$ref' in existing) && !existing.content) {
          existing.content = errorContent;
        }
      }
    }
  }

  // 42Crunch / invariant 5: every object rejects unknown keys and every scalar carries an explicit
  // bound. Done centrally (not via per-DTO decorators) to keep the documented contract DRY and in
  // lockstep with the Zod the server enforces.
  walk(doc.components.schemas);
  walk(doc.paths);

  return doc;
}
