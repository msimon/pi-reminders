// Atomic file write.
//
// Pattern copied from pi-hashline-readmap/src/fs-write.ts:52-95. That module is
// not an exported subpath, so this is a copy rather than a dependency.
//
// Write to a temp file opened `wx`, preserve the target's permission bits, then
// `rename` over the target. Rename is atomic within a filesystem, so a reader in
// another pi window never observes a half-written state file.

import { randomUUID } from "node:crypto";
import { mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function writeFileAtomically(
  targetPath: string,
  content: string,
): Promise<void> {
  let existingStats: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    existingStats = await stat(targetPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }

  // Hard links: update the inode in place so every link sees the new content.
  // A rename would detach the other links from the new content.
  if (existingStats && existingStats.nlink > 1) {
    await writeFile(targetPath, content, "utf-8");
    return;
  }

  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.tmp-${randomUUID()}`);
  const tempHandle = await open(tempPath, "wx", 0o600);
  try {
    try {
      await tempHandle.writeFile(content, "utf-8");
      if (existingStats) {
        // Overwrite: keep the target's prior permission bits.
        await tempHandle.chmod(existingStats.mode & 0o7777);
      } else {
        // New file: land at the OS/umask default, not the temp's 0o600.
        const umask = process.umask();
        process.umask(umask); // restore immediately; we only wanted to read it
        await tempHandle.chmod(0o666 & ~umask);
      }
    } finally {
      await tempHandle.close();
    }
    await rename(tempPath, targetPath);
  } catch (error: unknown) {
    // Best-effort cleanup so write/chmod/rename failures leave no orphan temp.
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}
