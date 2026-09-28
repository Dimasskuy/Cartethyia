import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

function homeDirectory(): string {
  return process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".";
}

export function getGrokInstallIdPath(homeDir = homeDirectory()): string {
  return join(homeDir, ".cartethyia", "grok-install-id");
}

export async function getGrokInstallId(path = getGrokInstallIdPath()): Promise<string> {
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing.length > 0) return existing;
  } catch (error: unknown) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    )
      throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const id = randomUUID();
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${id}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return id;
  } catch (error: unknown) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "EEXIST"
    )
      throw error;
    return (await readFile(path, "utf8")).trim();
  }
}
