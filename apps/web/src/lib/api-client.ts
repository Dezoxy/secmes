import { accessToken } from './auth';

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';
const DEFAULT_JSON_STATUSES = [200, 201] as const;
const DEFAULT_EMPTY_STATUSES = [204] as const;

type Fetcher = typeof fetch;

interface ApiSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

export type ApiClientErrorKind =
  | 'request-validation'
  | 'network'
  | 'http'
  | 'invalid-json'
  | 'response-validation';

export interface ApiClientError {
  kind: ApiClientErrorKind;
  message: string;
  status?: number;
}

export type ApiResult<T> =
  | {
      ok: true;
      status: number;
      data: T;
    }
  | {
      ok: false;
      status?: number;
      error: ApiClientError;
    };

interface ApiRequestBase<TBody> {
  path: string;
  method?: string;
  headers?: HeadersInit;
  body?: TBody;
  requestSchema?: ApiSchema<TBody>;
  expectedStatuses?: readonly number[];
  fetcher?: Fetcher;
}

interface ApiJsonRequest<TBody, TResponse> extends ApiRequestBase<TBody> {
  responseSchema: ApiSchema<TResponse>;
}

async function authedHeaders(extra?: HeadersInit): Promise<Headers> {
  const headers = new Headers(extra);
  const token = await accessToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

/** fetch() against the API with the Bearer token attached. */
export async function apiFetch(
  path: string,
  init: RequestInit = {},
  fetcher: Fetcher = fetch,
): Promise<Response> {
  return fetcher(`${API_BASE}${path}`, { ...init, headers: await authedHeaders(init.headers) });
}

export async function requestJson<TResponse, TBody = undefined>(
  request: ApiJsonRequest<TBody, TResponse>,
): Promise<ApiResult<TResponse>> {
  const initResult = await buildRequestInit(request);
  if (!initResult.ok) return initResult;

  const res = await sendApiRequest(request.path, initResult.data, request.fetcher);
  if (!res.ok) return res;

  const expectedStatuses = request.expectedStatuses ?? DEFAULT_JSON_STATUSES;
  if (!expectedStatuses.includes(res.data.status)) {
    return httpFailure(res.data.status);
  }

  let json: unknown;
  try {
    json = await res.data.json();
  } catch {
    return {
      ok: false,
      status: res.data.status,
      error: {
        kind: 'invalid-json',
        status: res.data.status,
        message: 'API response was not valid JSON.',
      },
    };
  }

  const parsed = request.responseSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      status: res.data.status,
      error: {
        kind: 'response-validation',
        status: res.data.status,
        message: 'API response did not match the expected contract.',
      },
    };
  }

  return { ok: true, status: res.data.status, data: parsed.data };
}

export async function requestStatus<TBody = undefined>(
  request: ApiRequestBase<TBody>,
): Promise<ApiResult<void>> {
  const initResult = await buildRequestInit(request);
  if (!initResult.ok) return initResult;

  const res = await sendApiRequest(request.path, initResult.data, request.fetcher);
  if (!res.ok) return res;

  const expectedStatuses = request.expectedStatuses ?? DEFAULT_EMPTY_STATUSES;
  if (!expectedStatuses.includes(res.data.status)) {
    return httpFailure(res.data.status);
  }

  return { ok: true, status: res.data.status, data: undefined };
}

export function unwrapApiResult<T>(result: ApiResult<T>): T {
  if (result.ok) return result.data;
  throw new Error(result.error.message);
}

async function buildRequestInit<TBody>(
  request: ApiRequestBase<TBody>,
): Promise<ApiResult<RequestInit>> {
  const headers = new Headers(request.headers);
  const init: RequestInit = {
    method: request.method,
    headers,
  };

  if (request.body !== undefined) {
    const parsedBody = request.requestSchema?.safeParse(request.body);
    if (parsedBody && !parsedBody.success) {
      return {
        ok: false,
        error: {
          kind: 'request-validation',
          message: 'API request body did not match the expected contract.',
        },
      };
    }

    headers.set('content-type', 'application/json');
    init.body = JSON.stringify(parsedBody ? parsedBody.data : request.body);
  }

  return { ok: true, status: 0, data: init };
}

async function sendApiRequest(
  path: string,
  init: RequestInit,
  fetcher: Fetcher = fetch,
): Promise<ApiResult<Response>> {
  try {
    return { ok: true, status: 0, data: await apiFetch(path, init, fetcher) };
  } catch {
    return {
      ok: false,
      error: {
        kind: 'network',
        message: 'Network request failed.',
      },
    };
  }
}

function httpFailure(status: number): ApiResult<never> {
  return {
    ok: false,
    status,
    error: {
      kind: 'http',
      status,
      message: `API request failed with status ${status}.`,
    },
  };
}
