// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteFile, readFile, storageErrorMessage, writeFile } from "../lib/opfs";

function fakeStorage(writable = true) {
  const files = new Map<string, Blob>();
  const stream = {
    write: vi.fn(async (_blob: Blob) => {}),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
  const createWritable = vi.fn(async () => stream);
  const dir = {
    getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException("Missing file", "NotFoundError");
        files.set(name, new Blob());
      }
      stream.write.mockImplementation(async (blob) => { files.set(name, blob); });
      return {
        getFile: async () => files.get(name)!,
        ...(writable ? { createWritable } : {}),
      };
    }),
    removeEntry: vi.fn(async (name: string) => { files.delete(name); }),
  };
  const getDirectoryHandle = vi.fn(async () => dir);
  vi.stubGlobal("navigator", {
    storage: { getDirectory: vi.fn(async () => ({ getDirectoryHandle })) },
  });
  return { files, dir, stream, createWritable };
}

function fakeCaches() {
  const entries = new Map<string, Response>();
  const cache = {
    put: vi.fn(async (key: string, response: Response) => { entries.set(key, response.clone()); }),
    match: vi.fn(async (key: string) => entries.get(key)?.clone()),
    delete: vi.fn(async (key: string) => entries.delete(key)),
  };
  const open = vi.fn(async () => cache);
  vi.stubGlobal("caches", { open });
  return { entries, cache, open };
}

beforeEach(() => {
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("location", { origin: "https://band.test" });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("offline files", () => {
  it("removes an empty OPFS file and treats it as a cache miss", async () => {
    const { files, dir } = fakeStorage();
    files.set("hash.pdf", new Blob());
    fakeCaches();

    expect(await readFile("files", "hash", ".pdf")).toBeNull();
    expect(dir.removeEntry).toHaveBeenCalledWith("hash.pdf");
    expect(files.has("hash.pdf")).toBe(false);
  });

  it.each(["createWritable", "write", "close"] as const)(
    "removes the partial OPFS file when %s fails and preserves the error", async (stage) => {
      const { files, dir, stream, createWritable } = fakeStorage();
      const { cache } = fakeCaches();
      const error = new DOMException("Full", "QuotaExceededError");
      if (stage === "createWritable") createWritable.mockRejectedValueOnce(error);
      else stream[stage].mockRejectedValueOnce(error);

      await expect(writeFile("files", "hash", ".pdf", new Blob(["pdf"]))).rejects.toBe(error);
      expect(dir.removeEntry).toHaveBeenCalledWith("hash.pdf");
      expect(files.has("hash.pdf")).toBe(false);
      expect(await readFile("files", "hash", ".pdf")).toBeNull();
      expect(cache.put).not.toHaveBeenCalled();
      if (stage !== "createWritable") expect(stream.abort).toHaveBeenCalled();
    },
  );

  it("writes and reads OPFS when createWritable is supported", async () => {
    const { stream } = fakeStorage();
    const { cache } = fakeCaches();
    const blob = new Blob(["pdf"], { type: "application/pdf" });

    await writeFile("files", "hash", ".pdf", blob);
    expect(await readFile("files", "hash", ".pdf")).toBe(blob);
    expect(stream.close).toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it("uses Cache Storage without createWritable, preserving content hashes and file types", async () => {
    const { files } = fakeStorage(false);
    const { open, cache } = fakeCaches();
    await writeFile("files", "hash-a", ".pdf", new Blob(["pdf"], { type: "application/pdf" }));
    await writeFile("audio", "hash-a", ".mp3", new Blob(["audio"], { type: "audio/mpeg" }));
    await writeFile("files", "hash-b", ".pdf", new Blob(["new pdf"]));

    expect(files.size).toBe(0);
    expect(open).toHaveBeenCalled();
    expect(cache.put.mock.calls.map(([key]) => key)).toEqual([
      "https://band.test/app/offline/files/hash-a.pdf",
      "https://band.test/app/offline/audio/hash-a.mp3",
      "https://band.test/app/offline/files/hash-b.pdf",
    ]);
    const pdf = await readFile("files", "hash-a", ".pdf");
    expect(await pdf?.text()).toBe("pdf");
    expect(pdf?.type).toBe("application/pdf");
    expect(await (await readFile("audio", "hash-a", ".mp3"))?.text()).toBe("audio");
    expect(await (await readFile("files", "hash-b", ".pdf"))?.text()).toBe("new pdf");
  });

  it("uses Cache Storage when OPFS is absent", async () => {
    vi.stubGlobal("navigator", { storage: {} });
    fakeCaches();
    await writeFile("files", "hash", ".pdf", new Blob(["pdf"]));
    expect(await (await readFile("files", "hash", ".pdf"))?.text()).toBe("pdf");
  });

  it("ignores an old empty OPFS file when a fallback copy is available", async () => {
    const { files } = fakeStorage(false);
    fakeCaches();
    await writeFile("files", "hash", ".pdf", new Blob(["pdf"]));
    files.set("hash.pdf", new Blob());

    expect(await (await readFile("files", "hash", ".pdf"))?.text()).toBe("pdf");
    expect(files.has("hash.pdf")).toBe(false);
  });

  it("removes an empty Cache Storage response and treats it as a miss", async () => {
    fakeStorage(false);
    const { entries, cache } = fakeCaches();
    const key = "https://band.test/app/offline/files/hash.pdf";
    entries.set(key, new Response(new Blob()));

    expect(await readFile("files", "hash", ".pdf")).toBeNull();
    expect(cache.delete).toHaveBeenCalledWith(key);
    expect(entries.has(key)).toBe(false);
  });

  it("deletes both copies so corrupt-file recovery cannot return the fallback", async () => {
    const { files } = fakeStorage(false);
    const { entries } = fakeCaches();
    await writeFile("files", "hash", ".pdf", new Blob(["pdf"]));
    files.set("hash.pdf", new Blob(["old pdf"]));

    await deleteFile("files", "hash", ".pdf");
    expect(files.size).toBe(0);
    expect(entries.size).toBe(0);
    expect(await readFile("files", "hash", ".pdf")).toBeNull();
  });

  it("reports full storage when the fallback write exceeds its quota", async () => {
    fakeStorage(false);
    const { cache } = fakeCaches();
    const error = new DOMException("Full", "QuotaExceededError");
    cache.put.mockRejectedValueOnce(error);

    await expect(writeFile("files", "hash", ".pdf", new Blob(["pdf"]))).rejects.toBe(error);
    expect(storageErrorMessage(error)).toBe("Storage is full. Free up space and try again.");
    expect(await readFile("files", "hash", ".pdf")).toBeNull();
  });

  it("reports unsupported storage on HTTPS when neither backend can write", async () => {
    const { files } = fakeStorage(false);
    vi.stubGlobal("caches", undefined);

    const error = await writeFile("files", "hash", ".pdf", new Blob(["pdf"])).catch((e) => e);
    expect(error?.name).toBe("NotSupportedError");
    expect(storageErrorMessage(error)).toBe("This browser cannot store files for offline use.");
    expect(files.size).toBe(0);
  });

  it.each(["SecurityError", "NotAllowedError"])(
    "does not blame HTTPS when the browser denies storage with %s", (name) => {
      expect(storageErrorMessage(new DOMException("Blocked", name)))
        .toBe("This browser cannot store files for offline use.");
    },
  );

  it("asks for a secure connection only in an insecure context", () => {
    vi.stubGlobal("isSecureContext", false);
    expect(storageErrorMessage(new DOMException("Unavailable", "NotSupportedError")))
      .toBe("Offline storage needs a secure connection (HTTPS or localhost).");
  });
});
