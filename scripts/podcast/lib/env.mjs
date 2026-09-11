import fs from "node:fs";
import path from "node:path";

const ENV_FILES = [".env.local", ".env"];

function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Unwrap a single layer of quotes; unquoted values may contain spaces.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Loads .env.local / .env into process.env without clobbering real env vars. */
export function loadEnv(cwd = process.cwd()) {
  for (const name of ENV_FILES) {
    const file = path.join(cwd, name);
    if (!fs.existsSync(file)) continue;
    const parsed = parseEnvFile(fs.readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = value;
      }
    }
  }
  return process.env;
}

export function requireApiKey() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || "";
  if (!key.trim()) {
    throw new Error(
      "缺少 GEMINI_API_KEY。請到 https://aistudio.google.com/apikey 取得金鑰，寫進專案根目錄的 .env.local：\n" +
        "GEMINI_API_KEY=你的金鑰",
    );
  }
  return key.trim();
}
