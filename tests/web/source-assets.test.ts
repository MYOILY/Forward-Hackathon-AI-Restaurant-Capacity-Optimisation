import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSourceAsset } from "../../web/src/source-assets";

const CHUNK_BYTES = 1024 * 1024;
const assetUrl = new URL(
  "http://127.0.0.1:5173/api/sources/example/assets/media/source.mp4",
);

function rangeResponse(
  bytes: Uint8Array,
  start: number,
  end: number,
  total: number,
  etag: string | null = '"source-v1"',
): Response {
  const headers = new Headers({
    "Content-Range": `bytes ${start}-${end}/${total}`,
    "Content-Type": "video/mp4",
  });
  if (etag !== null) headers.set("ETag", etag);
  return new Response(new Blob([new Uint8Array(bytes)]), {
    status: 206,
    headers,
  });
}

function byteFixture(length: number): Uint8Array {
  return Uint8Array.from(
    { length },
    (_, index) => (index * 17 + Math.floor(index / CHUNK_BYTES)) % 256,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("bounded source asset transfers", () => {
  it("assembles exact bytes with bounded sequential requests, If-Range and original media type", async () => {
    const bytes = byteFixture(CHUNK_BYTES * 2 + 37);
    const signal = new AbortController().signal;
    let completed = 0;
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      const [start, end] = new Headers(init.headers)
        .get("Range")!
        .slice(6)
        .split("-")
        .map(Number);
      expect(start).toBe(completed);
      expect(end - start + 1).toBeLessThanOrEqual(CHUNK_BYTES);
      const response = rangeResponse(
        bytes.slice(start, end + 1),
        start,
        end,
        bytes.length,
      );
      const read = response.arrayBuffer.bind(response);
      response.arrayBuffer = async () => {
        const result = await read();
        completed = end + 1;
        return result;
      };
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const blob = await fetchSourceAsset(assetUrl, signal);

    expect(blob?.type).toBe("video/mp4");
    expect(
      Buffer.from(await blob!.arrayBuffer()).equals(Buffer.from(bytes)),
    ).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map(([, init]) => init)).toEqual([
      {
        cache: "no-store",
        signal,
        headers: { Range: `bytes=0-${CHUNK_BYTES - 1}` },
      },
      {
        cache: "no-store",
        signal,
        headers: {
          Range: `bytes=${CHUNK_BYTES}-${CHUNK_BYTES * 2 - 1}`,
          "If-Range": '"source-v1"',
        },
      },
      {
        cache: "no-store",
        signal,
        headers: {
          Range: `bytes=${CHUNK_BYTES * 2}-${bytes.length - 1}`,
          "If-Range": '"source-v1"',
        },
      },
    ]);
    expect(fetchMock.mock.calls.every(([url]) => url === assetUrl)).toBe(true);
  });

  it("accepts a server that ignores the initial Range and returns an ordinary 200", async () => {
    const content = '{"video":"ready"}';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(content, {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const blob = await fetchSourceAsset(assetUrl);
    expect(await blob!.text()).toBe(content);
    expect(blob?.type).toBe("application/json");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("accepts an empty ordinary 200 asset", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("")));
    expect((await fetchSourceAsset(assetUrl))?.size).toBe(0);
  });

  it.each([null, 'W/"source-v1"'])(
    "supports consistent optional or weak ETags without sending invalid If-Range: %s",
    async (etag) => {
      const bytes = byteFixture(CHUNK_BYTES + 3);
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          rangeResponse(
            bytes.slice(0, CHUNK_BYTES),
            0,
            CHUNK_BYTES - 1,
            bytes.length,
            etag,
          ),
        )
        .mockResolvedValueOnce(
          rangeResponse(
            bytes.slice(CHUNK_BYTES),
            CHUNK_BYTES,
            bytes.length - 1,
            bytes.length,
            etag,
          ),
        );
      vi.stubGlobal("fetch", fetchMock);
      const blob = await fetchSourceAsset(assetUrl);
      expect(
        Buffer.from(await blob!.arrayBuffer()).equals(Buffer.from(bytes)),
      ).toBe(true);
      expect(
        new Headers(fetchMock.mock.calls[1][1].headers).has("If-Range"),
      ).toBe(false);
    },
  );

  it.each([404, 403, 500])(
    "returns null for initial HTTP %s",
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(null, { status }));
      vi.stubGlobal("fetch", fetchMock);
      expect(await fetchSourceAsset(assetUrl)).toBeNull();
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each([
    null,
    "bytes 0-2/*",
    "bytes 0-2/0",
    "bytes -1-2/3",
    "bytes 1-2/3",
    "bytes 0-3/3",
    "bytes 0-1/3",
    "items 0-2/3",
    "bytes 0-2/9007199254740992",
    `bytes 0-${CHUNK_BYTES}/${CHUNK_BYTES + 1}`,
  ])(
    "rejects missing, malformed or nonmatching initial Content-Range: %s",
    async (contentRange) => {
      const headers = new Headers();
      if (contentRange !== null) headers.set("Content-Range", contentRange);
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(new Response("abc", { status: 206, headers })),
      );
      await expect(fetchSourceAsset(assetUrl)).rejects.toThrow(/Content-Range/);
    },
  );

  it.each(["ab", "abcd"])(
    "rejects truncated or oversized bytes relative to Content-Range: %s",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(body, {
            status: 206,
            headers: { "Content-Range": "bytes 0-2/3" },
          }),
        ),
      );
      await expect(fetchSourceAsset(assetUrl)).rejects.toThrow(
        /truncated or oversized/,
      );
    },
  );

  it.each([-1, 1])(
    "rejects overlapping or skipped continuation bytes (offset %s)",
    async (delta) => {
      const total = CHUNK_BYTES + 3;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          rangeResponse(new Uint8Array(CHUNK_BYTES), 0, CHUNK_BYTES - 1, total),
        )
        .mockResolvedValueOnce(
          rangeResponse(
            new Uint8Array(3),
            CHUNK_BYTES + delta,
            total - 1,
            total,
          ),
        );
      vi.stubGlobal("fetch", fetchMock);
      await expect(fetchSourceAsset(assetUrl)).rejects.toThrow(/Content-Range/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("rejects truncated continuation bytes", async () => {
    const total = CHUNK_BYTES + 3;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          rangeResponse(new Uint8Array(CHUNK_BYTES), 0, CHUNK_BYTES - 1, total),
        )
        .mockResolvedValueOnce(
          rangeResponse(new Uint8Array(2), CHUNK_BYTES, total - 1, total),
        ),
    );
    await expect(fetchSourceAsset(assetUrl)).rejects.toThrow(
      /truncated or oversized/,
    );
  });

  it("rejects total size changes during a transfer", async () => {
    const total = CHUNK_BYTES * 2 + 3;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          rangeResponse(new Uint8Array(CHUNK_BYTES), 0, CHUNK_BYTES - 1, total),
        )
        .mockResolvedValueOnce(
          rangeResponse(
            new Uint8Array(CHUNK_BYTES),
            CHUNK_BYTES,
            CHUNK_BYTES * 2 - 1,
            total + 1,
          ),
        ),
    );
    await expect(fetchSourceAsset(assetUrl)).rejects.toThrow(
      /file size changed/,
    );
  });

  it.each([
    ['"source-v1"', '"source-v2"'],
    ['"source-v1"', null],
    [null, '"source-v2"'],
  ])(
    "rejects changed, removed or introduced ETags: %s → %s",
    async (firstEtag, secondEtag) => {
      const total = CHUNK_BYTES + 3;
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(
            rangeResponse(
              new Uint8Array(CHUNK_BYTES),
              0,
              CHUNK_BYTES - 1,
              total,
              firstEtag,
            ),
          )
          .mockResolvedValueOnce(
            rangeResponse(
              new Uint8Array(3),
              CHUNK_BYTES,
              total - 1,
              total,
              secondEtag,
            ),
          ),
      );
      await expect(fetchSourceAsset(assetUrl)).rejects.toThrow(/ETag changed/);
    },
  );

  it.each([200, 404, 416, 500])(
    "never assembles HTTP %s into a partial transfer",
    async (status) => {
      const total = CHUNK_BYTES + 3;
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(
            rangeResponse(
              new Uint8Array(CHUNK_BYTES),
              0,
              CHUNK_BYTES - 1,
              total,
            ),
          )
          .mockResolvedValueOnce(new Response("replacement", { status })),
      );
      await expect(fetchSourceAsset(assetUrl)).rejects.toThrow(
        new RegExp(
          `expected HTTP 206 at byte ${CHUNK_BYTES}, received ${status}`,
        ),
      );
    },
  );

  it("preserves an already aborted signal reason without sending a request", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Opening was cancelled", "AbortError");
    controller.abort(reason);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSourceAsset(assetUrl, controller.signal)).rejects.toBe(
      reason,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves cancellation of an in-flight continuation request", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Opening was cancelled", "AbortError");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        rangeResponse(
          new Uint8Array(CHUNK_BYTES),
          0,
          CHUNK_BYTES - 1,
          CHUNK_BYTES + 3,
        ),
      )
      .mockImplementationOnce(async (_url: URL, init: RequestInit) => {
        expect(init.signal).toBe(controller.signal);
        controller.abort(reason);
        throw init.signal!.reason;
      });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchSourceAsset(assetUrl, controller.signal)).rejects.toBe(
      reason,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([200, 206])(
    "does not return data if cancelled while reading an HTTP %s body",
    async (status) => {
      const controller = new AbortController();
      const reason = new DOMException("Opening was cancelled", "AbortError");
      const response =
        status === 200
          ? new Response("abc")
          : rangeResponse(new Uint8Array(3), 0, 2, 3);
      if (status === 200)
        response.blob = async () => {
          controller.abort(reason);
          return new Blob(["abc"]);
        };
      else
        response.arrayBuffer = async () => {
          controller.abort(reason);
          return new ArrayBuffer(3);
        };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(fetchSourceAsset(assetUrl, controller.signal)).rejects.toBe(
        reason,
      );
    },
  );
});
