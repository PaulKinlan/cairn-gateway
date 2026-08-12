const encoder = new TextEncoder();

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
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
    await Deno.chmod(temporary, 0o600);
    await Deno.rename(temporary, path);
    await Deno.chmod(path, 0o600);
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
