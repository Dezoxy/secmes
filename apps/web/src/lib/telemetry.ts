export type TelemetryMetadataValue = string | number | boolean;
export type TelemetryMetadata = Record<string, TelemetryMetadataValue>;

export interface TelemetryEvent {
  name: string;
  metadata: TelemetryMetadata;
}

export type TelemetryValidationErrorKind =
  | 'invalid-name'
  | 'sensitive-metadata'
  | 'unsupported-metadata';

export interface TelemetryValidationError {
  kind: TelemetryValidationErrorKind;
  message: string;
}

export type TelemetryEventResult =
  | { ok: true; event: TelemetryEvent }
  | { ok: false; error: TelemetryValidationError };

export type TelemetryMetadataInput = Record<string, unknown>;

const maxEventNameLength = 80;

const sensitiveMetadataKeyMarkers = [
  'authorization',
  'auth',
  'bearer',
  'body',
  'ciphertext',
  'content',
  'cookie',
  'credential',
  'key',
  'message',
  'passphrase',
  'password',
  'plaintext',
  'presigned',
  'private',
  'secret',
  'session',
  'signature',
  'token',
  'url',
  'xamz',
  'awsaccesskeyid',
];

const sensitiveMetadataValuePatterns = [
  /authorization\s*:/i,
  /bearer\s+[A-Za-z0-9._~+/-]+=*/i,
  /(^|[?&#\s])(access_token|awsaccesskeyid|id_token|refresh_token|signature|token|x-amz-credential|x-amz-security-token|x-amz-signature)=/i,
  /\b(private\s+key|passphrase|password|plaintext|message\s+body|secret)\b/i,
];

const presignedUrlParams = new Set([
  'X-Amz-Algorithm',
  'X-Amz-Credential',
  'X-Amz-Date',
  'X-Amz-Expires',
  'X-Amz-Security-Token',
  'X-Amz-Signature',
  'X-Amz-SignedHeaders',
  'AWSAccessKeyId',
  'Expires',
  'Signature',
]);

function validationError(kind: TelemetryValidationErrorKind): TelemetryEventResult {
  const messages: Record<TelemetryValidationErrorKind, string> = {
    'invalid-name': 'Telemetry event names must be stable technical identifiers.',
    'sensitive-metadata': 'Telemetry metadata cannot include sensitive keys or values.',
    'unsupported-metadata': 'Telemetry metadata only supports string, number, and boolean values.',
  };

  return { ok: false, error: { kind, message: messages[kind] } };
}

function isLowerAsciiLetter(char: string): boolean {
  return char >= 'a' && char <= 'z';
}

function isUpperAsciiLetter(char: string): boolean {
  return char >= 'A' && char <= 'Z';
}

function isAsciiDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isEventNameSeparator(char: string): boolean {
  return char === '.' || char === '_' || char === '-';
}

function isValidEventName(name: string): boolean {
  if (name.length === 0 || name.length > maxEventNameLength) return false;

  let needsSegmentStart = true;
  for (const char of name) {
    if (isEventNameSeparator(char)) {
      if (needsSegmentStart) return false;
      needsSegmentStart = true;
      continue;
    }

    if (needsSegmentStart) {
      if (!isLowerAsciiLetter(char)) return false;
      needsSegmentStart = false;
      continue;
    }

    if (!isLowerAsciiLetter(char) && !isAsciiDigit(char)) return false;
  }

  return !needsSegmentStart;
}

function isValidMetadataKey(key: string): boolean {
  if (
    key.length === 0 ||
    (!isUpperAsciiLetter(key[0] ?? '') && !isLowerAsciiLetter(key[0] ?? ''))
  ) {
    return false;
  }

  for (const char of key) {
    if (
      !isUpperAsciiLetter(char) &&
      !isLowerAsciiLetter(char) &&
      !isAsciiDigit(char) &&
      char !== '_'
    ) {
      return false;
    }
  }

  return true;
}

function isSensitiveKey(key: string): boolean {
  if (!isValidMetadataKey(key)) return true;

  const normalizedKey = key.replaceAll('_', '').toLowerCase();
  return sensitiveMetadataKeyMarkers.some((marker) => normalizedKey.includes(marker));
}

function hasPresignedUrlParam(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  for (const param of presignedUrlParams) {
    if (url.searchParams.has(param)) return true;
  }
  return false;
}

function isSensitiveStringValue(value: string): boolean {
  return (
    hasPresignedUrlParam(value) ||
    sensitiveMetadataValuePatterns.some((pattern) => pattern.test(value))
  );
}

function isTelemetryMetadataValue(value: unknown): value is TelemetryMetadataValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

export function createTelemetryEvent(
  name: string,
  metadata: TelemetryMetadataInput = {},
): TelemetryEventResult {
  if (!isValidEventName(name)) return validationError('invalid-name');

  const safeMetadata: TelemetryMetadata = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    if (isSensitiveKey(key)) return validationError('sensitive-metadata');
    if (!isTelemetryMetadataValue(value)) return validationError('unsupported-metadata');
    if (typeof value === 'string' && isSensitiveStringValue(value)) {
      return validationError('sensitive-metadata');
    }
    safeMetadata[key] = value;
  }

  return { ok: true, event: { name, metadata: safeMetadata } };
}
