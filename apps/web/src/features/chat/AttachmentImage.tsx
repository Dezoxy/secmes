import { useEffect, useState } from 'react';

import { downloadAttachment } from '../../lib/attachments';
import type { AttachmentRef } from '../../lib/message-envelope';

// Session cache of decrypted-attachment object URLs, keyed by objectKey, so re-renders / re-opening the
// thread don't re-download. Object URLs live until reload (the ciphertext in blob storage is the source of
// truth, re-fetched on demand); the cache just dedups within the session.
const objectUrlCache = new Map<string, string>();

interface AttachmentImageProps {
  refData: AttachmentRef;
  onClick?: (url: string) => void;
}

/**
 * A received E2E image: request a one-time download grant, fetch the CIPHERTEXT, decrypt it locally, and
 * render the result. The server never sees the bytes or the content key; GCM fails closed on a tampered or
 * swapped blob (we render a fallback rather than garbage).
 */
export function AttachmentImage({ refData, onClick }: AttachmentImageProps) {
  const [url, setUrl] = useState<string | null>(
    () => objectUrlCache.get(refData.objectKey) ?? null,
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (url || failed) return;
    let cancelled = false;
    void (async () => {
      try {
        const bytes = await downloadAttachment(refData);
        const objectUrl = URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: refData.mime }),
        );
        objectUrlCache.set(refData.objectKey, objectUrl);
        if (!cancelled) setUrl(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    // Keep the cached object URL alive for the session (reused across re-renders); don't revoke here.
    return () => {
      cancelled = true;
    };
  }, [refData, url, failed]);

  if (failed) {
    return (
      <div className="flex h-32 w-[260px] max-w-full items-center justify-center rounded-lg bg-[#12121a] text-xs text-white/60">
        Couldn&apos;t load attachment
      </div>
    );
  }
  if (!url) {
    return (
      <div className="flex h-32 w-[260px] max-w-full animate-pulse items-center justify-center rounded-lg bg-[#1a1a26] text-xs text-white/60">
        Decrypting…
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onClick?.(url)}
      className="group/img relative block cursor-pointer overflow-hidden rounded-lg"
    >
      <img
        src={url}
        alt={refData.name}
        className="max-h-64 w-full max-w-[260px] rounded-lg object-cover transition-transform duration-300 group-hover/img:scale-105"
      />
      <div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover/img:bg-black/20" />
    </button>
  );
}
