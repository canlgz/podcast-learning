import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const CACHE_ROOT = path.join(process.cwd(), ".cache/podcast");

export async function fileFingerprint(filePath) {
  const stat = await fs.stat(filePath);
  return createHash("sha1")
    .update(`${path.basename(filePath)}:${stat.size}:${Math.floor(stat.mtimeMs / 1000)}`)
    .digest("hex")
    .slice(0, 16);
}

function cachePath(fingerprint, pass, version) {
  return path.join(CACHE_ROOT, fingerprint, `${pass}.v${version}.json`);
}

/** 每個 AI pass 的結果都落地，重跑同一個檔案不會再燒錢。 */
export async function readCache(fingerprint, pass, version) {
  try {
    return JSON.parse(await fs.readFile(cachePath(fingerprint, pass, version), "utf8"));
  } catch {
    return null;
  }
}

export async function writeCache(fingerprint, pass, version, data) {
  const file = cachePath(fingerprint, pass, version);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

export async function clearCache(fingerprint) {
  await fs.rm(path.join(CACHE_ROOT, fingerprint), { recursive: true, force: true });
}
