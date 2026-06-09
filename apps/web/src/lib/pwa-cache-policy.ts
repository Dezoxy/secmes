export const pwaPrecacheFileExtensions = [
  'css',
  'html',
  'ico',
  'js',
  'png',
  'svg',
  'webmanifest',
] as const;

export const pwaPrecacheGlobPatterns = [`**/*.{${pwaPrecacheFileExtensions.join(',')}}`] as const;

export const pwaNavigateFallbackDenylist = [
  /^\/auth\/callback(?:[/?#]|$)/,
  /^\/api(?:[/?#]|$)/,
  /^\/ws(?:[/?#]|$)/,
] as const;

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

export function isPresignedAttachmentUrl(url: URL): boolean {
  for (const param of presignedUrlParams) {
    if (url.searchParams.has(param)) return true;
  }
  return false;
}

export function isPwaNavigationFallbackAllowed(pathnameWithSearch: string): boolean {
  return !pwaNavigateFallbackDenylist.some((pattern) => pattern.test(pathnameWithSearch));
}

export function isPwaStaticPrecacheCandidate(pathname: string): boolean {
  const extension = pathname.split('.').pop();
  return pwaPrecacheFileExtensions.some((allowed) => extension === allowed);
}

export function shouldUsePwaRuntimeCache(request: Request, url: URL): boolean {
  if (request.headers.has('Authorization')) return false;
  if (!isPwaNavigationFallbackAllowed(`${url.pathname}${url.search}`)) return false;
  if (isPresignedAttachmentUrl(url)) return false;
  return false;
}
