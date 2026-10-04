async function root(): Promise<FileSystemDirectoryHandle> {
  return await navigator.storage.getDirectory();
}

async function ensureDir(parent: FileSystemDirectoryHandle, name: string) {
  return parent.getDirectoryHandle(name, { create: true });
}

// Same content-hash names as OPFS, in a cache separate from the app shell.
function cacheKey(category: "files" | "audio", id: string, ext: string): string {
  return new URL(`/app/offline/${category}/${encodeURIComponent(`${id}${ext}`)}`, location.origin).href;
}

async function fileCache(): Promise<Cache> {
  if (typeof caches === "undefined") {
    throw new DOMException("File storage is unavailable", "NotSupportedError");
  }
  return caches.open("bandstand-files-v1");
}

export function storageErrorMessage(error: unknown): string {
  if (globalThis.isSecureContext === false) {
    return "Offline storage needs a secure connection (HTTPS or localhost).";
  }
  const name = (error as { name?: string })?.name;
  if (name === "QuotaExceededError") return "Storage is full. Free up space and try again.";
  if (name === "NotSupportedError" || name === "SecurityError" || name === "NotAllowedError") {
    return "This browser cannot store files for offline use.";
  }
  return "Could not save files for offline use. Try again.";
}

export async function writeFile(category: "files" | "audio", id: string,
                                  ext: string, blob: Blob): Promise<void> {
  if (typeof navigator.storage?.getDirectory === "function") {
    const r = await root();
    const dir = await ensureDir(r, category);
    const name = `${id}${ext}`;
    const handle = await dir.getFileHandle(name, { create: true });
    if (typeof handle.createWritable === "function") {
      let writable: FileSystemWritableFileStream | undefined;
      try {
        writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (error) {
        await writable?.abort().catch(() => {});
        await dir.removeEntry(name).catch(() => {});
        throw error;
      }
    }
    // Safari 17/18 can create the handle but cannot write through it.
    await dir.removeEntry(name).catch(() => {});
  }
  const cache = await fileCache();
  await cache.put(cacheKey(category, id, ext), new Response(blob));
}

export async function readFile(category: "files" | "audio", id: string,
                                 ext: string): Promise<Blob | null> {
  try {
    const r = await root();
    const dir = await ensureDir(r, category);
    const handle = await dir.getFileHandle(`${id}${ext}`);
    const blob = await handle.getFile();
    if (blob.size > 0) return blob;
    await dir.removeEntry(`${id}${ext}`);
  } catch { /* OPFS unavailable or missing; try Cache Storage. */ }
  try {
    const cache = await fileCache();
    const key = cacheKey(category, id, ext);
    const response = await cache.match(key);
    if (!response) return null;
    const blob = await response.blob();
    if (blob.size > 0) return blob;
    await cache.delete(key);
  } catch {
    // Storage is best-effort; a miss lets the caller fetch the file.
  }
  return null;
}

export async function deleteFile(category: "files" | "audio", id: string,
                                   ext: string): Promise<void> {
  try {
    const r = await root();
    const dir = await ensureDir(r, category);
    await dir.removeEntry(`${id}${ext}`);
  } catch { /* ignore */ }
  try {
    const cache = await fileCache();
    await cache.delete(cacheKey(category, id, ext));
  } catch { /* ignore */ }
}

export async function quota(): Promise<{ used: number; total: number }> {
  const e = await navigator.storage.estimate();
  return { used: e.usage ?? 0, total: e.quota ?? 0 };
}
