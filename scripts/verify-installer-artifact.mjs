import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const distDir = path.resolve("dist-desktop");
const entries = await fs.readdir(distDir, { withFileTypes: true });
const installers = [];
for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith(".exe") || entry.name.includes("unpacked")) {
    continue;
  }
  const filePath = path.join(distDir, entry.name);
  const stat = await fs.stat(filePath);
  const handle = await fs.open(filePath, "r");
  const header = Buffer.alloc(2);
  try {
    await handle.read(header, 0, 2, 0);
  } finally {
    await handle.close();
  }
  if (header.toString("ascii") === "MZ" && stat.size > 1_000_000) {
    installers.push({
      name: entry.name,
      path: filePath,
      bytes: stat.size
    });
  }
}

assert.ok(installers.length > 0, "No NSIS installer artifact was found in dist-desktop.");

console.log(
  JSON.stringify(
    {
      ok: true,
      installers
    },
    null,
    2
  )
);
