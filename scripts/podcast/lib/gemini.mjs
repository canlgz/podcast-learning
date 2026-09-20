import fs from "node:fs/promises";
import path from "node:path";

const API_ROOT = "https://generativelanguage.googleapis.com";
const API_VERSION = "v1beta";

/**
 * 估算用單價（USD / 1M tokens），取自 2026-09 官方價目表（付費方案標準層）。
 * 3.x flash 系列未另列音訊價，視為與文字同價。可用 env 覆寫：
 *   GEMINI_PRICE_IN_TEXT / GEMINI_PRICE_IN_AUDIO / GEMINI_PRICE_OUT
 */
const PRICING = {
  "gemini-3.8-flash": { text: 0.75, audio: 0.75, out: 3.75 },
  "gemini-3.7-flash": { text: 0.75, audio: 0.75, out: 3.75 },
  "gemini-3.6-flash": { text: 0.75, audio: 0.75, out: 3.75 },
  "gemini-3.5-flash": { text: 1.5, audio: 1.5, out: 9.0 },
  "gemini-3.5-flash-lite": { text: 0.3, audio: 0.3, out: 2.5 },
  "gemini-3.5-transcribe": { text: 2.0, audio: 2.0, out: 12.0 },
  "gemini-3-flash": { text: 0.5, audio: 1.0, out: 3.0 },
  // 舊世代，只有既有帳號能用
  "gemini-2.5-flash": { text: 0.3, audio: 1.0, out: 2.5 },
  "gemini-2.5-flash-lite": { text: 0.1, audio: 0.3, out: 0.4 },
  "gemini-2.5-pro": { text: 1.25, audio: 1.25, out: 10.0 },
};
const FALLBACK_PRICING = { text: 0.75, audio: 0.75, out: 3.75 };
const unpricedModels = new Set();

function priceFor(model) {
  const base = PRICING[model];
  if (!base && !unpricedModels.has(model)) {
    unpricedModels.add(model);
    console.log(`   ! ${model} 不在內建價目表，費用以 flash 價位估算，實際請看 Google Cloud 帳單`);
  }
  return {
    text: Number(process.env.GEMINI_PRICE_IN_TEXT || (base || FALLBACK_PRICING).text),
    audio: Number(process.env.GEMINI_PRICE_IN_AUDIO || (base || FALLBACK_PRICING).audio),
    out: Number(process.env.GEMINI_PRICE_OUT || (base || FALLBACK_PRICING).out),
  };
}

export function isPriced(model) {
  return Boolean(PRICING[model]);
}

export const MIME_BY_EXT = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".aiff": "audio/aiff",
};

export function mimeForFile(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || "audio/mpeg";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 尖峰時段 Gemini 會回 503「high demand」，通常幾分鐘後才恢復，
 * 所以重試預算用「總時間」算，不是固定次數。可用 env 覆寫。
 */
const RETRY_BUDGET_MS = Number(process.env.GEMINI_RETRY_BUDGET_MS || 300000);
const MAX_BACKOFF_MS = Number(process.env.GEMINI_MAX_BACKOFF_MS || 45000);

/** 主模型滿載／配額用盡／金鑰拿不到時，依序讓這些模型頂上。 */
export const DEFAULT_FALLBACK_MODELS = (
  process.env.GEMINI_FALLBACK_MODELS || "gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash-lite"
)
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

class GeminiHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function isRetryable(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** 值得換一個模型再試：滿載（5xx）、配額用盡（429）、這把金鑰拿不到（404）。 */
function shouldSwapModel(error) {
  const status = error?.status;
  return status === 404 || status === 429 || status >= 500;
}

/** Google 偶爾會給 Retry-After，有就聽它的。 */
function retryAfterMs(response) {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(MAX_BACKOFF_MS, Math.max(0, seconds * 1000));
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.min(MAX_BACKOFF_MS, Math.max(0, at - Date.now())) : null;
}

async function fetchWithRetry(url, init, { label = "request", attempts = 8, budgetMs = RETRY_BUDGET_MS } = {}) {
  const deadline = Date.now() + budgetMs;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let waitMs = null;
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;
      const detail = await response.text();
      const failure = new GeminiHttpError(
        `${label} 失敗 HTTP ${response.status}: ${detail.slice(0, 600)}`,
        response.status,
      );
      if (!isRetryable(response.status)) throw failure;
      lastError = failure;
      waitMs = retryAfterMs(response);
    } catch (error) {
      if (error instanceof GeminiHttpError && !isRetryable(error.status)) throw error;
      lastError = error;
    }
    if (attempt === attempts) break;
    const backoff = waitMs ?? Math.round(Math.min(MAX_BACKOFF_MS, 2000 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5));
    if (Date.now() + backoff > deadline) {
      console.log(`   ↻ ${label} 重試預算 ${Math.round(budgetMs / 1000)}s 用完`);
      break;
    }
    const reason = lastError?.status ? `HTTP ${lastError.status}` : "連線失敗";
    console.log(`   ↻ ${label} 第 ${attempt} 次失敗（${reason}），${(backoff / 1000).toFixed(1)}s 後重試`);
    await sleep(backoff);
  }
  throw lastError;
}

export class GeminiClient {
  constructor({ apiKey, model = "gemini-2.5-flash", fallbackModels = DEFAULT_FALLBACK_MODELS, verbose = true }) {
    this.apiKey = apiKey;
    this.model = model;
    this.fallbackModels = fallbackModels;
    // 某個模型頂上之後就記住，後面的 pass 直接用它，不用每次都先去撞牆。
    this.modelSwaps = new Map();
    this.verbose = verbose;
    this.usage = { textInTokens: 0, audioInTokens: 0, outTokens: 0, calls: 0, costUsd: 0 };
  }

  /** 這次要依序嘗試的模型：上次頂上的 → 原本指定的 → 備援清單。 */
  modelChain(requested) {
    return [...new Set([this.modelSwaps.get(requested), requested, ...this.fallbackModels].filter(Boolean))];
  }

  /** 以 resumable upload 上傳音檔到 Files API（支援大檔，48 小時內有效）。 */
  async uploadFile(filePath, displayName) {
    const bytes = await fs.readFile(filePath);
    const mimeType = mimeForFile(filePath);

    const start = await fetchWithRetry(
      `${API_ROOT}/upload/${API_VERSION}/files?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: "POST",
        headers: {
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
          "X-Goog-Upload-Header-Content-Type": mimeType,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ file: { display_name: displayName || path.basename(filePath) } }),
      },
      { label: "files:start" },
    );

    const uploadUrl = start.headers.get("x-goog-upload-url");
    if (!uploadUrl) throw new Error("Files API 未回傳上傳網址");

    const finalize = await fetchWithRetry(
      uploadUrl,
      {
        method: "POST",
        headers: {
          "Content-Length": String(bytes.byteLength),
          "X-Goog-Upload-Offset": "0",
          "X-Goog-Upload-Command": "upload, finalize",
        },
        body: bytes,
      },
      { label: "files:upload", attempts: 3 },
    );

    const payload = await finalize.json();
    const file = payload.file || payload;
    if (!file?.name) throw new Error(`Files API 回應異常：${JSON.stringify(payload).slice(0, 300)}`);
    return this.waitUntilActive(file);
  }

  async waitUntilActive(file, timeoutMs = 10 * 60 * 1000) {
    const deadline = Date.now() + timeoutMs;
    let current = file;
    while (current.state && current.state !== "ACTIVE") {
      if (current.state === "FAILED") {
        throw new Error(`音檔在 Google 端處理失敗：${JSON.stringify(current.error || {})}`);
      }
      if (Date.now() > deadline) throw new Error("等待音檔處理逾時");
      await sleep(3000);
      const res = await fetchWithRetry(
        `${API_ROOT}/${API_VERSION}/${current.name}?key=${encodeURIComponent(this.apiKey)}`,
        { method: "GET" },
        { label: "files:get" },
      );
      current = await res.json();
    }
    return current;
  }

  /** 查一個已上傳檔案還在不在（回傳 null 表示已過期或不存在）。 */
  async describeFile(name) {
    try {
      const res = await fetch(`${API_ROOT}/${API_VERSION}/${name}?key=${encodeURIComponent(this.apiKey)}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async deleteFile(name) {
    if (!name) return;
    try {
      await fetch(`${API_ROOT}/${API_VERSION}/${name}?key=${encodeURIComponent(this.apiKey)}`, {
        method: "DELETE",
      });
    } catch {
      // 48 小時後會自動清除，刪不掉不影響流程。
    }
  }

  recordUsage(usageMetadata, { hasAudio, model }) {
    const price = priceFor(model || this.model);
    const promptTokens = usageMetadata?.promptTokenCount || 0;
    const outTokens =
      (usageMetadata?.candidatesTokenCount || 0) + (usageMetadata?.thoughtsTokenCount || 0);

    // promptTokensDetails 會分開列出 AUDIO / TEXT，沒有時就整包視為音訊或文字。
    const details = usageMetadata?.promptTokensDetails || [];
    let audioTokens = 0;
    let textTokens = 0;
    for (const row of details) {
      if (String(row.modality).toUpperCase() === "AUDIO") audioTokens += row.tokenCount || 0;
      else textTokens += row.tokenCount || 0;
    }
    if (!details.length) {
      if (hasAudio) audioTokens = promptTokens;
      else textTokens = promptTokens;
    }

    this.usage.calls += 1;
    this.usage.audioInTokens += audioTokens;
    this.usage.textInTokens += textTokens;
    this.usage.outTokens += outTokens;
    this.usage.costUsd +=
      (audioTokens / 1e6) * price.audio + (textTokens / 1e6) * price.text + (outTokens / 1e6) * price.out;
    return { audioTokens, textTokens, outTokens };
  }

  /**
   * 呼叫 generateContent。回傳 { text, json, finishReason, usage }。
   * schema 有值時使用 structured output（responseMimeType: application/json）。
   */
  async generate({
    prompt,
    fileUri,
    fileMimeType,
    schema,
    temperature = 0.2,
    maxOutputTokens = 8192,
    thinkingBudget = 0,
    systemInstruction,
    model: modelOverride,
    label = "generate",
  }) {
    const requested = modelOverride || this.model;

    const callOnce = async (model) => {
      // 2.5 Pro 不接受關閉 thinking（thinkingBudget 0），最低要 128。
      const effectiveBudget =
        thinkingBudget != null && /pro|transcribe/i.test(model) ? Math.max(128, thinkingBudget) : thinkingBudget;

      const parts = [{ text: prompt }];
      if (fileUri) parts.push({ file_data: { mime_type: fileMimeType || "audio/mpeg", file_uri: fileUri } });

      const body = {
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature,
          maxOutputTokens,
          ...(schema ? { responseMimeType: "application/json", responseSchema: schema } : {}),
          ...(effectiveBudget != null ? { thinkingConfig: { thinkingBudget: effectiveBudget } } : {}),
        },
        ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      };

      const url = `${API_ROOT}/${API_VERSION}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
      const tag = model === requested ? label : `${label} → ${model}`;
      const send = () =>
        fetchWithRetry(
          url,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
          { label: tag },
        );

      try {
        return await send();
      } catch (error) {
        // 少數模型不吃 thinkingConfig，退一步重試一次。
        if (thinkingBudget != null && /thinking/i.test(error.message || "")) {
          delete body.generationConfig.thinkingConfig;
          return await send();
        }
        throw error;
      }
    };

    // 重試完還是不行，就換下一個模型頂上，而不是讓整集作廢。
    const chain = this.modelChain(requested);
    let response = null;
    let model = requested;
    for (let index = 0; index < chain.length; index += 1) {
      model = chain[index];
      try {
        response = await callOnce(model);
        break;
      } catch (error) {
        if (index === chain.length - 1 || !shouldSwapModel(error)) throw error;
        console.log(`   ⇄ ${model} 目前不可用（HTTP ${error.status}），改用 ${chain[index + 1]} 繼續`);
      }
    }
    if (model !== requested) this.modelSwaps.set(requested, model);

    const payload = await response.json();
    const candidate = payload.candidates?.[0];
    // 一般模型把文字放 part.text；專用轉錄模型放 part.audioTranscription.text。
    const text = (candidate?.content?.parts || [])
      .map((part) => part.text || part.audioTranscription?.text || "")
      .join("")
      .trim();
    const usage = this.recordUsage(payload.usageMetadata, { hasAudio: Boolean(fileUri), model });
    const finishReason = candidate?.finishReason || payload.promptFeedback?.blockReason || "UNKNOWN";

    let json = null;
    if (schema && text) {
      json = parseLooseJson(text);
    }

    if (this.verbose) {
      const costNote = `in ${usage.audioTokens + usage.textTokens} / out ${usage.outTokens} tokens`;
      console.log(`   · ${model === requested ? label : `${label} → ${model}`}: ${finishReason} (${costNote})`);
    }

    return { text, json, finishReason, usage, model, raw: payload };
  }

  usageReport() {
    return {
      calls: this.usage.calls,
      audioInTokens: this.usage.audioInTokens,
      textInTokens: this.usage.textInTokens,
      outTokens: this.usage.outTokens,
      costUsd: Math.round(this.usage.costUsd * 10000) / 10000,
    };
  }
}

/** structured output 偶爾會被截斷或包在 markdown 裡，盡量救回來。 */
export function parseLooseJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // 截斷時逐步砍尾巴，嘗試補回括號。
    const start = trimmed.search(/[[{]/);
    if (start === -1) return null;
    const body = trimmed.slice(start);
    for (let cut = body.length; cut > 40; cut -= Math.max(1, Math.floor(cut / 200))) {
      const slice = body.slice(0, cut);
      for (const tail of ['"]}', '"}]}', '"}]', "]}", "}]", "]", "}", ""]) {
        try {
          return JSON.parse(slice + tail);
        } catch {
          /* keep shrinking */
        }
      }
    }
    return null;
  }
}
