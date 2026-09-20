#!/usr/bin/env node
/**
 * 把來源資料夾裡的音檔，變成網站可用的「可對話學習單元」。
 *
 *   node scripts/podcast/build-catalog.mjs [--source DIR] [options]
 *
 * 選項：
 *   --source DIR        音檔來源資料夾（預設讀 PODCAST_SOURCE_DIR）
 *   --only KEYWORD      只處理檔名含關鍵字的音檔
 *   --limit N           最多處理 N 個新音檔
 *   --force             忽略快取，整個重跑（會重新計費）
 *   --skip-transcript   只做章節地圖＋互動腳本（最省錢，逐字稿留空）
 *   --max-rounds N      逐字稿續寫上限（預設 6）
 *   --model NAME        章節／互動腳本用的模型（預設 GEMINI_MODEL）
 *   --transcribe-model NAME  逐字稿用的模型（預設 GEMINI_TRANSCRIBE_MODEL，未設則同 --model）
 *   --fallback-models A,B    主模型滿載（503）或不可用時的備援順序
 *   --dry               只列出會處理什麼，不呼叫 API、不寫檔
 *   --watch             處理完後持續監看資料夾
 *   --keep-removed      來源檔消失時仍保留舊資料
 *   --out FILE          輸出的 catalog 路徑（預設 data/episodes.generated.json）
 *   --media DIR         音檔連結目錄（預設 public/media）
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { loadEnv, requireApiKey } from "./lib/env.mjs";
import { GeminiClient, mimeForFile } from "./lib/gemini.mjs";
import { readAudioDurationSeconds } from "./lib/audio-meta.mjs";
import { fileFingerprint, readCache, writeCache } from "./lib/cache.mjs";
import {
  INTERACT_PASS,
  OUTLINE_PASS,
  TRANSCRIPT_PASS,
  formatClock,
  mergeTranscriptLines,
} from "./lib/passes.mjs";

loadEnv();

const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".wav", ".aac", ".flac", ".ogg", ".opus", ".mp4"]);
const DEFAULT_OUTPUT_FILE = path.join(process.cwd(), "data/episodes.generated.json");
const DEFAULT_MEDIA_DIR = path.join(process.cwd(), "public/media");
const SCHEMA_VERSION = "2.0";

function getArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const hasArg = (name) => process.argv.includes(name);

const options = {
  source: getArg("--source", process.env.PODCAST_SOURCE_DIR || ""),
  only: getArg("--only"),
  limit: Number(getArg("--limit", "0")) || 0,
  force: hasArg("--force"),
  skipTranscript: hasArg("--skip-transcript"),
  maxRounds: Number(getArg("--max-rounds", "6")) || 6,
  model: getArg("--model", process.env.GEMINI_MODEL || "gemini-3.8-flash"),
  transcribeModel: getArg(
    "--transcribe-model",
    process.env.GEMINI_TRANSCRIBE_MODEL || getArg("--model", process.env.GEMINI_MODEL || "gemini-3.8-flash"),
  ),
  fallbackModels: getArg("--fallback-models"),
  dry: hasArg("--dry"),
  watch: hasArg("--watch"),
  keepRemoved: hasArg("--keep-removed"),
  out: getArg("--out"),
  media: getArg("--media"),
};

const OUTPUT_FILE = options.out ? path.resolve(options.out) : DEFAULT_OUTPUT_FILE;
const MEDIA_DIR = options.media ? path.resolve(options.media) : DEFAULT_MEDIA_DIR;

/* ------------------------------------------------------------------ helpers */

function shortHash(input) {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 8);
}

function cleanTitle(basename) {
  return basename
    .replace(/^\s*\d{1,5}[.\-_)\s]+/, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksUndescriptive(title) {
  return title.length < 6 || /^(audio|recording|rec|track|untitled|new file|voice)\b/i.test(title);
}

function toSlug(title, id) {
  const base = title
    .normalize("NFKC")
    .replace(/[^\p{Script=Han}\w\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase()
    .slice(0, 48);
  return base || id;
}

async function walkAudioFiles(dir, depth = 0) {
  const found = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`讀不到來源資料夾 ${dir}：${error.message}`);
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 2) found.push(...(await walkAudioFiles(full, depth + 1)));
      continue;
    }
    if (AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(full);
  }
  return found.sort();
}

/** 用 hardlink 讓網站取得音檔：同磁碟上不佔額外空間，跨磁碟才退回複製。 */
async function linkMedia(sourcePath, targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const sourceStat = await fs.stat(sourcePath);
  try {
    const targetStat = await fs.stat(targetPath);
    if (targetStat.ino === sourceStat.ino && targetStat.dev === sourceStat.dev) return "linked";
    if (targetStat.size === sourceStat.size && Math.abs(targetStat.mtimeMs - sourceStat.mtimeMs) < 2000) return "copied";
    await fs.rm(targetPath, { force: true });
  } catch {
    /* 目標還不存在 */
  }
  try {
    await fs.link(sourcePath, targetPath);
    return "linked";
  } catch {
    await fs.copyFile(sourcePath, targetPath);
    return "copied";
  }
}

function chapterBlockOf(outline) {
  return outline.chapters
    .map((ch) => `- ${formatClock(ch.startSec)}–${formatClock(ch.endSec)} ${ch.title}：${ch.gist}${ch.keyPoints.length ? `（重點：${ch.keyPoints.join("；")}）` : ""}`)
    .join("\n");
}

function transcriptBlockOf(segments, maxChars = 42000) {
  const lines = segments.map((row) => `[${formatClock(row.startSec)}]${row.speaker ? ` ${row.speaker}：` : " "}${row.text}`);
  let block = lines.join("\n");
  if (block.length > maxChars) {
    // 太長時平均抽樣，保留整集時間分布。
    const keepEvery = Math.ceil(block.length / maxChars);
    block = lines.filter((_, index) => index % keepEvery === 0).join("\n");
  }
  return block;
}

/* -------------------------------------------------------------- AI pipeline */

async function runPasses({ client, filePath, fingerprint, title, durationSeconds, notes }) {
  const durationLabel = formatClock(durationSeconds);
  const mimeType = mimeForFile(filePath);
  // 主模型滿載時 client 會自動換備援，記下來寫進 stats。
  const modelsUsed = new Set();

  // 上傳到 Files API 的檔案在 Google 端保存 48 小時，快取下來讓重跑不用再傳一次 76MB。
  let uploaded = null;
  const ensureUpload = async () => {
    if (uploaded) return uploaded;

    const cached = await readCache(fingerprint, "upload", 1);
    if (cached?.name && cached?.expiresAt && Date.parse(cached.expiresAt) - Date.now() > 10 * 60 * 1000) {
      const stillThere = await client.describeFile(cached.name);
      if (stillThere?.state === "ACTIVE") {
        console.log(`   ↺ 重用 48 小時內已上傳的音檔：${cached.name}`);
        uploaded = stillThere;
        return uploaded;
      }
    }

    const sizeMb = Math.round((await fs.stat(filePath)).size / 1048576);
    console.log(`   ↑ 上傳音檔到 Gemini Files API（${sizeMb}MB）…`);
    const startedAt = Date.now();
    uploaded = await client.uploadFile(filePath, title);
    console.log(`   ✓ 已就緒：${uploaded.name}（${Math.round((Date.now() - startedAt) / 1000)}s）`);
    await writeCache(fingerprint, "upload", 1, {
      name: uploaded.name,
      uri: uploaded.uri,
      expiresAt: uploaded.expirationTime || new Date(Date.now() + 40 * 3600 * 1000).toISOString(),
    });
    return uploaded;
  };

  // ---- Pass A：章節地圖
  let outline = options.force ? null : await readCache(fingerprint, OUTLINE_PASS.name, OUTLINE_PASS.version);
  if (!outline) {
    const file = await ensureUpload();
    const result = await client.generate({
      prompt: OUTLINE_PASS.prompt({ title, durationLabel }),
      fileUri: file.uri,
      fileMimeType: mimeType,
      schema: OUTLINE_PASS.schema,
      maxOutputTokens: 16384,
      thinkingBudget: 1024,
      temperature: 0.2,
      model: options.model,
      label: `pass A 章節地圖（${options.model}）`,
    });
    modelsUsed.add(result.model);
    if (!result.json) throw new Error(`章節地圖解析失敗（finishReason=${result.finishReason}）`);
    outline = OUTLINE_PASS.normalize(result.json, { durationSeconds });
    if (!outline.chapters.length) throw new Error("章節地圖為空");
    await writeCache(fingerprint, OUTLINE_PASS.name, OUTLINE_PASS.version, outline);
  } else {
    console.log("   · pass A 章節地圖：使用快取");
  }
  console.log(`   → ${outline.chapters.length} 章、${outline.keyTerms.length} 個關鍵詞`);

  // ---- Pass B：逐字稿（自動續寫到結尾；中斷過就從快取接著跑）
  const transcriptCacheKey = `${TRANSCRIPT_PASS.version}-${options.transcribeModel}`;
  const cachedTranscript = options.force
    ? null
    : await readCache(fingerprint, TRANSCRIPT_PASS.name, transcriptCacheKey);
  let transcript;

  if (options.skipTranscript) {
    transcript = cachedTranscript || { segments: [], coverageSec: 0, complete: false, skipped: true };
    console.log("   · pass B 逐字稿：依 --skip-transcript 跳過");
  } else if (cachedTranscript?.complete) {
    transcript = cachedTranscript;
    console.log("   · pass B 逐字稿：使用快取");
  } else {
    const file = await ensureUpload();
    const chapterHint = chapterBlockOf(outline);
    // 上次沒跑完的部分直接沿用，不用重聽已經轉好的段落。
    const priorSegments = cachedTranscript?.segments || [];
    const batches = priorSegments.length ? [priorSegments] : [];
    let fromSec = priorSegments.length ? priorSegments[priorSegments.length - 1].startSec : 0;
    let complete = false;

    if (priorSegments.length) {
      console.log(`   ↻ pass B 逐字稿：接續上次的 ${formatClock(fromSec)}（已有 ${priorSegments.length} 行）`);
    }

    // 專用轉錄模型（gemini-3.5-transcribe）不支援 JSON mode，也不吃 thinkingConfig。
    const isDedicatedTranscriber = /transcribe/i.test(options.transcribeModel);
    let jsonMode = !isDedicatedTranscriber;

    const runRound = async (round, startSec) => {
      const shared = {
        fileUri: file.uri,
        fileMimeType: mimeType,
        maxOutputTokens: 65536,
        thinkingBudget: isDedicatedTranscriber ? null : 0,
        temperature: 0.1,
        model: options.transcribeModel,
        label: `pass B 逐字稿 #${round}（從 ${formatClock(startSec)}，${options.transcribeModel}${jsonMode ? "" : " 文字模式"}）`,
      };

      if (jsonMode) {
        try {
          const structured = await client.generate({
            ...shared,
            prompt: TRANSCRIPT_PASS.prompt({ durationLabel, fromSec: startSec, chapterHint }),
            schema: TRANSCRIPT_PASS.schema,
          });
          modelsUsed.add(structured.model);
          return {
            batch: TRANSCRIPT_PASS.normalize(structured.json || {}, { durationSeconds, fromSec: startSec }),
            finishReason: structured.finishReason,
          };
        } catch (error) {
          if (!/JSON mode is not enabled|response_?mime_?type|responseSchema/i.test(error.message)) throw error;
          console.log("   · 這個模型不支援 JSON mode，改用純文字逐字稿格式");
          jsonMode = false;
        }
      }

      const plain = await client.generate({
        ...shared,
        prompt: TRANSCRIPT_PASS.promptText({ durationLabel, fromSec: startSec, chapterHint }),
      });
      modelsUsed.add(plain.model);
      return {
        batch: TRANSCRIPT_PASS.normalizeText(plain.text, { durationSeconds, fromSec: startSec }),
        finishReason: plain.finishReason,
      };
    };

    // 每輪都先落地，某一輪掛掉時前面轉好的段落不會白跑。
    const saveProgress = async (done) => {
      const merged = mergeTranscriptLines(batches, durationSeconds);
      const snapshot = {
        segments: merged,
        // 用最後一行的「開始時間」算覆蓋率：endSec 會被補成整集長度，拿來算會永遠是 100%。
        coverageSec: merged.length ? merged[merged.length - 1].startSec : 0,
        complete: done,
      };
      await writeCache(fingerprint, TRANSCRIPT_PASS.name, transcriptCacheKey, snapshot);
      return snapshot;
    };

    for (let round = 1; round <= options.maxRounds; round += 1) {
      let batch;
      let finishReason;
      try {
        ({ batch, finishReason } = await runRound(round, fromSec));
      } catch (error) {
        // 模型滿載之類的錯誤不該讓整集作廢：保留已完成的部分，下次重跑接著補。
        const reason = error.message.split("\n")[0];
        notes.push(`逐字稿第 ${round} 輪失敗：${reason}`);
        console.log(`   ! pass B 第 ${round} 輪失敗，保留已完成的部分：${reason}`);
        break;
      }

      if (!batch.lines.length) {
        notes.push(`逐字稿第 ${round} 輪沒有新內容（finishReason=${finishReason}）`);
        break;
      }
      batches.push(batch.lines);
      const lastSec = batch.lines[batch.lines.length - 1].startSec;
      console.log(`     ↳ ${batch.lines.length} 行，覆蓋到 ${formatClock(lastSec)}`);
      await saveProgress(false);

      // 容許值隨節目長度縮放：短音檔不能用 45 秒當門檻，否則會誤判已到結尾。
      const tailTolerance = Math.min(45, Math.max(12, durationSeconds * 0.03));
      const reachedTail = durationSeconds > 0 && lastSec >= durationSeconds - tailTolerance;
      if (batch.reachedEnd || reachedTail) {
        complete = true;
        break;
      }
      if (lastSec <= fromSec + 5) {
        notes.push(`逐字稿在 ${formatClock(lastSec)} 停滯，提早結束`);
        break;
      }
      fromSec = lastSec;
      if (round === options.maxRounds) notes.push(`逐字稿達到續寫上限 ${options.maxRounds} 輪`);
    }

    transcript = await saveProgress(complete);
  }
  const transcriptChars = transcript.segments.reduce((sum, row) => sum + row.text.length, 0);
  console.log(`   → 逐字稿 ${transcript.segments.length} 行 / ${transcriptChars} 字，覆蓋到 ${formatClock(transcript.coverageSec)}`);

  // ---- Pass C：互動腳本（純文字，最便宜）
  // 互動卡的品質取決於逐字稿完整度，所以把完整度寫進快取 key：
  // 逐字稿之後被補齊時會自然 miss、重新產一份對得上的互動卡。
  const transcriptCoverage = durationSeconds > 0 ? Math.min(1, transcript.coverageSec / durationSeconds) : 0;
  const interactCacheKey = !transcript.segments.length
    ? `${INTERACT_PASS.version}-outline-only`
    : transcript.complete || transcriptCoverage >= 0.9
      ? `${INTERACT_PASS.version}`
      : `${INTERACT_PASS.version}-p${Math.round(transcriptCoverage * 10)}`;
  let interact = options.force ? null : await readCache(fingerprint, INTERACT_PASS.name, interactCacheKey);
  if (!interact) {
    const cueTarget = Math.min(16, Math.max(5, Math.round(durationSeconds / 180) || 6));
    const result = await client.generate({
      prompt: INTERACT_PASS.prompt({
        title,
        durationLabel,
        chapterBlock: chapterBlockOf(outline),
        transcriptBlock: transcript.segments.length
          ? transcriptBlockOf(transcript.segments)
          : "（逐字稿尚未產生，請依章節地圖設計，問題要貼緊章節重點）",
        cueTarget,
      }),
      schema: INTERACT_PASS.schema,
      maxOutputTokens: 32768,
      thinkingBudget: 2048,
      temperature: 0.5,
      model: options.model,
      label: `pass C 互動腳本（${options.model}）`,
    });
    modelsUsed.add(result.model);
    if (!result.json) throw new Error(`互動腳本解析失敗（finishReason=${result.finishReason}）`);
    interact = INTERACT_PASS.normalize(result.json, { durationSeconds, chapters: outline.chapters });
    if (!interact.cues.length) throw new Error("互動腳本為空");
    await writeCache(fingerprint, INTERACT_PASS.name, interactCacheKey, interact);
  } else {
    console.log("   · pass C 互動腳本：使用快取");
  }
  console.log(`   → ${interact.cues.length} 張互動卡、${interact.gaps.length} 個資訊缺口`);

  const swapped = [...modelsUsed].filter(
    (name) => name && name !== options.model && name !== options.transcribeModel,
  );
  if (swapped.length) notes.push(`主模型不可用，改用備援模型：${swapped.join("、")}`);

  return { outline, transcript, interact, transcriptChars, modelsUsed: [...modelsUsed] };
}

/* ------------------------------------------------------------ orchestration */

async function buildOnce() {
  if (!options.source) {
    throw new Error("請用 --source 指定音檔資料夾，或在 .env.local 設定 PODCAST_SOURCE_DIR");
  }
  const sourceDir = path.resolve(options.source);
  const files = await walkAudioFiles(sourceDir);
  const selected = options.only
    ? files.filter((file) => path.basename(file).toLowerCase().includes(options.only.toLowerCase()))
    : files;

  console.log(`來源：${sourceDir}`);
  console.log(`找到 ${files.length} 個音檔${options.only ? `，關鍵字「${options.only}」命中 ${selected.length} 個` : ""}`);

  let previous = { episodes: [] };
  try {
    previous = JSON.parse(await fs.readFile(OUTPUT_FILE, "utf8"));
  } catch {
    /* 第一次執行 */
  }
  const previousById = new Map((previous.episodes || []).map((episode) => [episode.id, episode]));

  const client = new GeminiClient({
    model: options.model,
    apiKey: options.dry ? "dry" : safeApiKey(),
    ...(options.fallbackModels
      ? { fallbackModels: options.fallbackModels.split(",").map((name) => name.trim()).filter(Boolean) }
      : {}),
  });
  const episodes = [];
  let processed = 0;

  for (const filePath of selected) {
    const basename = path.basename(filePath, path.extname(filePath));
    const id = `ep-${shortHash(path.relative(sourceDir, filePath))}`;
    const fingerprint = await fileFingerprint(filePath);
    const stat = await fs.stat(filePath);
    const sourceTitle = cleanTitle(basename) || basename;
    const durationSeconds = Math.round(await readAudioDurationSeconds(filePath));
    const mediaName = `${id}${path.extname(filePath).toLowerCase()}`;
    const existing = previousById.get(id);
    const unchanged = existing && existing.fingerprint === fingerprint && existing.status === "ready" && !options.force;

    console.log(`\n▶ ${sourceTitle}`);
    console.log(`  id=${id} 長度=${formatClock(durationSeconds)} 大小=${Math.round(stat.size / 1048576)}MB`);

    if (options.dry) {
      console.log(unchanged ? "  （已是最新，會跳過）" : "  （會進行分析）");
      continue;
    }

    const linkMode = await linkMedia(filePath, path.join(MEDIA_DIR, mediaName));
    const base = {
      id,
      slug: toSlug(sourceTitle, id),
      title: sourceTitle,
      sourceTitle,
      audioUrl: `/media/${mediaName}`,
      durationSeconds,
      fileSizeBytes: stat.size,
      sourceFile: filePath,
      fingerprint,
      mediaMode: linkMode,
    };

    if (unchanged) {
      console.log("  ✓ 內容未變動，沿用既有分析結果");
      episodes.push({ ...existing, ...base, status: existing.status });
      continue;
    }

    if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GEMINI_API_KEY) {
      console.log("  ! 尚未設定 GEMINI_API_KEY，先登錄為待分析");
      episodes.push({
        ...base,
        status: "pending",
        statusNote: "尚未設定 GEMINI_API_KEY，還沒做內容分析。",
        summary: "",
        chapters: [],
        segments: [],
        cues: [],
        gaps: [],
        takeaways: [],
        keyTerms: [],
        starters: [],
        stats: { builtAt: new Date().toISOString(), notes: [] },
      });
      continue;
    }

    if (options.limit && processed >= options.limit) {
      console.log(`  · 已達 --limit ${options.limit}，保留舊資料`);
      episodes.push(existing ? { ...existing, ...base } : { ...base, status: "pending", summary: "", chapters: [], segments: [], cues: [], gaps: [], takeaways: [], keyTerms: [], starters: [], stats: {} });
      continue;
    }

    const notes = [];
    const startedAt = Date.now();
    const usageBefore = client.usageReport();
    try {
      const { outline, transcript, interact, transcriptChars, modelsUsed } = await runPasses({
        client,
        filePath,
        fingerprint,
        title: sourceTitle,
        durationSeconds,
        notes,
      });

      const usageAfter = client.usageReport();
      const coverage = durationSeconds > 0 ? Math.min(1, transcript.coverageSec / durationSeconds) : 0;
      const status = transcript.skipped
        ? "outline-only"
        : transcript.complete || coverage >= 0.9
          ? "ready"
          : "partial";

      episodes.push({
        ...base,
        title: looksUndescriptive(sourceTitle) && outline.suggestedTitle ? outline.suggestedTitle : sourceTitle,
        status,
        statusNote: status === "partial" ? `逐字稿只覆蓋到 ${formatClock(transcript.coverageSec)}，可重跑補齊。` : "",
        language: outline.language,
        oneLiner: outline.oneLiner,
        summary: outline.summary,
        audience: outline.audience,
        speakers: outline.speakers,
        takeaways: outline.takeaways,
        keyTerms: outline.keyTerms,
        chapters: outline.chapters,
        segments: transcript.segments,
        cues: interact.cues,
        gaps: interact.gaps,
        starters: interact.starters,
        stats: {
          builtAt: new Date().toISOString(),
          model: options.model,
          transcribeModel: options.transcribeModel,
          actualModels: modelsUsed,
          elapsedSec: Math.round((Date.now() - startedAt) / 1000),
          chapterCount: outline.chapters.length,
          segmentCount: transcript.segments.length,
          cueCount: interact.cues.length,
          transcriptChars,
          transcriptCoverage: Math.round(coverage * 100) / 100,
          tokens: {
            audioIn: usageAfter.audioInTokens - usageBefore.audioInTokens,
            textIn: usageAfter.textInTokens - usageBefore.textInTokens,
            out: usageAfter.outTokens - usageBefore.outTokens,
          },
          costUsd: Math.round((usageAfter.costUsd - usageBefore.costUsd) * 10000) / 10000,
          notes,
        },
      });
      processed += 1;
      const cost = Math.round((usageAfter.costUsd - usageBefore.costUsd) * 10000) / 10000;
      console.log(`  ✓ 完成（${status}）耗時 ${Math.round((Date.now() - startedAt) / 1000)}s，估算花費 US$${cost}`);
    } catch (error) {
      console.error(`  ✗ 分析失敗：${error.message}`);
      episodes.push(
        existing
          ? { ...existing, ...base, statusNote: `最近一次重跑失敗：${error.message}` }
          : {
              ...base,
              status: "failed",
              statusNote: error.message,
              summary: "",
              chapters: [],
              segments: [],
              cues: [],
              gaps: [],
              takeaways: [],
              keyTerms: [],
              starters: [],
              stats: { builtAt: new Date().toISOString(), notes },
            },
      );
    }
  }

  if (options.dry) {
    console.log("\n--dry 模式結束，未呼叫 API、未寫檔。");
    return;
  }

  // 沒被選到處理的舊集數要保留（例如用了 --only）。
  const presentIds = new Set(episodes.map((episode) => episode.id));
  const keptIds = new Set(
    (await walkAudioFiles(sourceDir)).map((file) => `ep-${shortHash(path.relative(sourceDir, file))}`),
  );
  for (const episode of previous.episodes || []) {
    if (presentIds.has(episode.id)) continue;
    if (options.keepRemoved || keptIds.has(episode.id)) episodes.push(episode);
  }
  episodes.sort((a, b) => a.title.localeCompare(b.title, "zh-Hant"));

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(
    OUTPUT_FILE,
    `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(), sourceDirectory: sourceDir, episodes }, null, 2)}\n`,
    "utf8",
  );
  await pruneMedia(new Set(episodes.map((episode) => path.basename(episode.audioUrl))));

  const usage = client.usageReport();
  console.log(`\n已寫入 ${path.relative(process.cwd(), OUTPUT_FILE)}：${episodes.length} 集`);
  if (usage.calls > 0) {
    console.log(
      `本次 API 呼叫 ${usage.calls} 次｜音訊輸入 ${usage.audioInTokens} / 文字輸入 ${usage.textInTokens} / 輸出 ${usage.outTokens} tokens｜估算費用 US$${usage.costUsd}`,
    );
  }
}

async function pruneMedia(validNames) {
  let entries = [];
  try {
    entries = await fs.readdir(MEDIA_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".") || validNames.has(name)) continue;
    if (!AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
    await fs.rm(path.join(MEDIA_DIR, name), { force: true });
    console.log(`  · 清掉孤兒音檔 public/media/${name}`);
  }
}

function safeApiKey() {
  try {
    return requireApiKey();
  } catch {
    return "";
  }
}

async function main() {
  await buildOnce();
  if (!options.watch) return;
  const interval = Number(process.env.PODCAST_WATCH_INTERVAL_MS || 120000);
  console.log(`\n--watch 已啟動，每 ${Math.round(interval / 1000)} 秒掃描一次（Ctrl+C 結束）`);
  setInterval(() => {
    buildOnce().catch((error) => console.error("watch 失敗：", error.message));
  }, interval);
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
