const SOURCE_ASSET_CHUNK_BYTES = 1024 * 1024;

function invalidAsset(detail: string): Error {
  return new Error(`Unable to load source asset: ${detail}.`);
}

/** Keep source file transfers below the embedded browser's response body limit. */
export async function fetchSourceAsset(
  url: URL,
  signal?: AbortSignal,
): Promise<Blob | null> {
  const chunks: ArrayBuffer[] = [];
  let offset = 0;
  let total: number | undefined;
  let etag: string | null = null;
  let contentType = "";

  while (total === undefined || offset < total) {
    signal?.throwIfAborted();
    const requestedEnd = Math.min(
      offset + SOURCE_ASSET_CHUNK_BYTES - 1,
      total === undefined ? Infinity : total - 1,
    );
    const headers: Record<string, string> = {
      Range: `bytes=${offset}-${requestedEnd}`,
    };
    // If-Range only accepts a strong ETag. Weak tags are still checked for changes.
    if (offset > 0 && etag && !etag.startsWith("W/"))
      headers["If-Range"] = etag;
    const response = await fetch(url, { cache: "no-store", signal, headers });
    signal?.throwIfAborted();
    if (offset === 0 && !response.ok) return null;
    if (offset === 0 && response.status === 200) {
      const blob = await response.blob();
      signal?.throwIfAborted();
      return blob;
    }
    if (response.status !== 206)
      throw invalidAsset(
        `expected HTTP 206 at byte ${offset}, received ${response.status}`,
      );

    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
      response.headers.get("Content-Range") ?? "",
    );
    if (!match) throw invalidAsset("missing or malformed Content-Range");
    const [start, end, responseTotal] = match.slice(1).map(Number);
    if (
      ![start, end, responseTotal].every(Number.isSafeInteger) ||
      responseTotal <= 0 ||
      start !== offset ||
      end < start ||
      end !== Math.min(requestedEnd, responseTotal - 1)
    ) {
      throw invalidAsset(`unexpected Content-Range at byte ${offset}`);
    }
    if (total !== undefined && responseTotal !== total)
      throw invalidAsset("file size changed during download");
    const responseEtag = response.headers.get("ETag");
    if (offset === 0) {
      total = responseTotal;
      etag = responseEtag;
      contentType = response.headers.get("Content-Type") ?? "";
    } else if (responseEtag !== etag) {
      throw invalidAsset("file ETag changed during download");
    }
    const chunk = await response.arrayBuffer();
    signal?.throwIfAborted();
    if (chunk.byteLength !== end - start + 1)
      throw invalidAsset(`truncated or oversized response at byte ${offset}`);
    chunks.push(chunk);
    offset = end + 1;
  }
  signal?.throwIfAborted();
  return new Blob(chunks, { type: contentType });
}
