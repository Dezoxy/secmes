import type { ApiClientError, ApiClientErrorKind, ApiResult } from './api-client';

export interface SafeUiError {
  safe: true;
  title: string;
  message: string;
  status?: number;
  kind?: ApiClientErrorKind | string;
}

interface SafeUiErrorOptions {
  title?: string;
  message?: string;
  status?: number;
  kind?: ApiClientErrorKind | string;
}

const DEFAULT_TITLE = 'Something went wrong';
const DEFAULT_MESSAGE = 'This action could not be completed. Try again in a moment.';

const API_ERROR_KINDS = new Set<ApiClientErrorKind>([
  'request-validation',
  'network',
  'http',
  'invalid-json',
  'response-validation',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createSafeUiError(options: SafeUiErrorOptions = {}): SafeUiError {
  return {
    safe: true,
    title: options.title ?? DEFAULT_TITLE,
    message: options.message ?? DEFAULT_MESSAGE,
    status: options.status,
    kind: options.kind,
  };
}

export function isSafeUiError(value: unknown): value is SafeUiError {
  return (
    isRecord(value) &&
    value.safe === true &&
    typeof value.title === 'string' &&
    typeof value.message === 'string'
  );
}

function isApiClientError(value: unknown): value is ApiClientError {
  return (
    isRecord(value) &&
    typeof value.kind === 'string' &&
    API_ERROR_KINDS.has(value.kind as ApiClientErrorKind) &&
    typeof value.message === 'string' &&
    (value.status === undefined || typeof value.status === 'number')
  );
}

function apiErrorFromResult(value: unknown): ApiClientError | null {
  if (!isRecord(value) || value.ok !== false) return null;
  return isApiClientError(value.error) ? value.error : null;
}

function apiErrorMessage(error: ApiClientError): string {
  if (error.kind === 'network') {
    return 'Check your connection and try again.';
  }
  if (error.kind === 'request-validation') {
    return 'The request could not be prepared. Reload and try again.';
  }
  if (error.kind === 'invalid-json' || error.kind === 'response-validation') {
    return 'The service returned an unexpected response. Try again in a moment.';
  }
  if (error.kind === 'http') {
    if (error.status === 401) {
      return 'Your session may have expired. Sign in again if this keeps happening.';
    }
    if (error.status === 403) {
      return 'You do not have access to this action.';
    }
    if (error.status === 404) {
      return 'This item is not available.';
    }
    if (error.status === 409) {
      return 'This changed somewhere else. Reload and try again.';
    }
    if (error.status === 429) {
      return 'Too many attempts. Wait a moment and try again.';
    }
    if (typeof error.status === 'number' && error.status >= 500) {
      return 'The service is unavailable. Try again in a moment.';
    }
  }

  return DEFAULT_MESSAGE;
}

function apiErrorTitle(error: ApiClientError): string {
  if (error.kind === 'network') return 'Connection problem';
  if (error.kind === 'http') return 'Request failed';
  return 'Service problem';
}

export function toSafeUiError(error: unknown, options: SafeUiErrorOptions = {}): SafeUiError {
  if (isSafeUiError(error)) {
    return createSafeUiError({
      title: options.title ?? error.title,
      message: options.message ?? error.message,
      status: options.status ?? error.status,
      kind: options.kind ?? error.kind,
    });
  }

  const apiError = isApiClientError(error)
    ? error
    : apiErrorFromResult(error as ApiResult<unknown>);
  if (apiError) {
    return createSafeUiError({
      title: options.title ?? apiErrorTitle(apiError),
      message: options.message ?? apiErrorMessage(apiError),
      status: options.status ?? apiError.status,
      kind: options.kind ?? apiError.kind,
    });
  }

  return createSafeUiError(options);
}
