const encoder = new TextEncoder();

export interface AtomicWriteOptions {
  /** Test seam for the best-effort durability barrier after the rename commits the new value. */
  syncDirectory?: (directory: string) => Promise<void>;
}

async function syncDirectory(directory: string): Promise<void> {
  const directoryFile = await Deno.open(directory, { read: true });
  try {
    await directoryFile.sync();
  } finally {
    directoryFile.close();
  }
}

export async function atomicWriteJson(
  path: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const slash = path.lastIndexOf("/");
  if (slash < 1) throw new Error("absolute metadata path required");
  const directory = path.slice(0, slash);
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(temporary, { createNew: true, write: true, mode: 0o600 });
    await file.write(encoder.encode(JSON.stringify(value)));
    await file.sync();
    file.close();
    file = undefined;
    // Everything which can make the write fail is completed before rename. Rename is the
    // commitment point: callers must never interpret a later durability-barrier failure as a
    // rollback while the new file is already visible.
    await Deno.chmod(temporary, 0o600);
    await Deno.rename(temporary, path);
    try {
      await (options.syncDirectory ?? syncDirectory)(directory);
    } catch {
      // The renamed value is committed and readable. Directory fsync is best effort because
      // reporting failure here would create an ambiguous, falsely rolled-back authority change.
    }
  } catch (error) {
    try {
      file?.close();
    } catch { /* already closed */ }
    try {
      await Deno.remove(temporary);
    } catch { /* absent */ }
    throw error;
  }
}

export async function readJsonFile(path: string, maxBytes: number): Promise<unknown | undefined> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile || info.size > maxBytes) throw new Error("metadata invalid");
    const bytes = new Uint8Array(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = await file.read(bytes.subarray(offset));
      if (count === null) break;
      offset += count;
    }
    if (offset !== bytes.length) throw new Error("metadata invalid");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("metadata invalid");
  } finally {
    file.close();
  }
}
