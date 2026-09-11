/**
 * 三段式內容分析：
 *   A. outline    — 整集章節地圖 / 摘要 / 關鍵詞（吃音檔）
 *   B. transcript — 帶時間戳的逐字稿（吃音檔，會自動續寫）
 *   C. interact   — 時間軸互動腳本：何時該問什麼、要補什麼（吃文字，最便宜）
 */

export const CUE_KINDS = ["recall", "why", "apply", "gap", "contrast"];

export function parseTimeToSeconds(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(0, Number(text));
  const parts = text.split(":").map((part) => Number(part.replace(/[^\d.]/g, "")));
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

export function formatClock(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const mm = String(h > 0 ? m : m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function trimText(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/* ------------------------------------------------------------------ Pass A */

export const OUTLINE_PASS = {
  name: "outline",
  version: 2,
  schema: {
    type: "OBJECT",
    properties: {
      language: { type: "STRING", description: "節目主要語言，如 zh-Hant" },
      suggestedTitle: { type: "STRING" },
      oneLiner: { type: "STRING", description: "一句話說明這集在談什麼，40 字內" },
      summary: { type: "STRING", description: "3 到 5 句的本集摘要" },
      audience: { type: "STRING", description: "這集最適合誰聽，30 字內" },
      speakers: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { label: { type: "STRING" }, role: { type: "STRING" } },
          required: ["label"],
        },
      },
      chapters: {
        type: "ARRAY",
        description: "依內容轉折切章，每章 2 到 6 分鐘",
        items: {
          type: "OBJECT",
          properties: {
            startTime: { type: "STRING", description: "MM:SS" },
            endTime: { type: "STRING", description: "MM:SS" },
            title: { type: "STRING", description: "章節標題，16 字內" },
            gist: { type: "STRING", description: "這章講什麼，2 句內" },
            keyPoints: { type: "ARRAY", items: { type: "STRING" } },
          },
          required: ["startTime", "endTime", "title", "gist"],
        },
      },
      takeaways: { type: "ARRAY", items: { type: "STRING" }, description: "聽完應該帶走的 3 到 6 件事" },
      keyTerms: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            term: { type: "STRING" },
            explain: { type: "STRING", description: "用白話解釋，60 字內" },
            firstTime: { type: "STRING", description: "第一次出現的 MM:SS" },
          },
          required: ["term", "explain"],
        },
      },
    },
    required: ["summary", "chapters", "takeaways"],
  },
  prompt({ title, durationLabel }) {
    return `你是一位專業的內容編輯，正在為一個「邊聽邊學」的學習工具整理這集 Podcast。

音檔資訊：
- 檔名標題：${title}
- 總長度：${durationLabel}

請完整聽過整段音檔（包含最後一段，不要只聽開頭），然後輸出這集的章節地圖。

要求：
1. chapters 要覆蓋整集，從 00:00 到結尾，章節之間不要有大段空白。依「話題轉折」切，不是平均切。
2. 每章 2 到 6 分鐘；總長 ${durationLabel} 大約切成 6 到 14 章。
3. 時間一律用 MM:SS（超過一小時用 H:MM:SS），必須是音檔中真實對應的時間。
4. keyPoints 寫節目真的講過的具體內容（數字、做法、案例名稱），不要寫空泛的形容。
5. keyTerms 收錄聽眾可能不懂的專有名詞、機構名、政策名。
6. 全部使用繁體中文。`;
  },
  normalize(json, { durationSeconds }) {
    const rawChapters = Array.isArray(json?.chapters) ? json.chapters : [];
    const chapters = rawChapters
      .map((row) => ({
        startSec: parseTimeToSeconds(row.startTime),
        endSec: parseTimeToSeconds(row.endTime),
        title: trimText(row.title, 40),
        gist: trimText(row.gist, 200),
        keyPoints: (Array.isArray(row.keyPoints) ? row.keyPoints : []).map((p) => trimText(p, 160)).filter(Boolean).slice(0, 6),
      }))
      .filter((row) => row.startSec != null && row.title)
      .sort((a, b) => a.startSec - b.startSec);

    // 補齊 / 修正章節邊界，讓時間軸連續且落在音檔長度內。
    const limit = durationSeconds > 0 ? Math.round(durationSeconds) : null;
    chapters.forEach((chapter, index) => {
      const next = chapters[index + 1];
      if (chapter.endSec == null || (next && chapter.endSec > next.startSec)) {
        chapter.endSec = next ? next.startSec : limit ?? chapter.startSec + 180;
      }
      if (limit) {
        chapter.startSec = Math.min(chapter.startSec, limit);
        chapter.endSec = Math.min(chapter.endSec ?? limit, limit);
      }
      chapter.id = `ch-${String(index + 1).padStart(2, "0")}`;
    });

    return {
      language: trimText(json?.language, 12) || "zh-Hant",
      suggestedTitle: trimText(json?.suggestedTitle, 90),
      oneLiner: trimText(json?.oneLiner, 90),
      summary: trimText(json?.summary, 600),
      audience: trimText(json?.audience, 80),
      speakers: (Array.isArray(json?.speakers) ? json.speakers : [])
        .map((row) => ({ label: trimText(row.label, 24), role: trimText(row.role, 40) }))
        .filter((row) => row.label)
        .slice(0, 8),
      chapters: chapters.filter((row) => row.endSec > row.startSec),
      takeaways: (Array.isArray(json?.takeaways) ? json.takeaways : []).map((row) => trimText(row, 160)).filter(Boolean).slice(0, 6),
      keyTerms: (Array.isArray(json?.keyTerms) ? json.keyTerms : [])
        .map((row) => ({
          term: trimText(row.term, 40),
          explain: trimText(row.explain, 200),
          atSec: parseTimeToSeconds(row.firstTime),
        }))
        .filter((row) => row.term && row.explain)
        .slice(0, 20),
    };
  },
};

/* ------------------------------------------------------------------ Pass B */

export const TRANSCRIPT_PASS = {
  name: "transcript",
  version: 2,
  schema: {
    type: "OBJECT",
    properties: {
      lines: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            time: { type: "STRING", description: "這句開始的 MM:SS" },
            speaker: { type: "STRING", description: "講者標籤，如 主持人 / 來賓A；聽不出來就留空" },
            text: { type: "STRING" },
          },
          required: ["time", "text"],
        },
      },
      reachedEnd: { type: "BOOLEAN", description: "是否已轉錄到音檔結尾" },
    },
    required: ["lines"],
  },
  prompt({ durationLabel, fromSec, chapterHint }) {
    const startLabel = formatClock(fromSec || 0);
    return `請把這段音檔轉成帶時間戳的逐字稿。

音檔總長：${durationLabel}
這次從 ${startLabel} 開始轉錄${fromSec ? `（${startLabel} 之前已經處理過，不要重複輸出）` : ""}。
${chapterHint ? `內容脈絡參考（章節）：\n${chapterHint}\n` : ""}
要求：
1. 每 8 到 18 秒輸出一行（方便聽眾點某一行跳播），time 用 MM:SS，必須對應音檔真實時間、且單調遞增。不要把一大段合併成一行。
2. text 用繁體中文，忠實記錄說話內容；修掉「呃、那個、就是」這類無意義的口頭贅詞，但不要改寫語意、不要摘要、不要省略。
3. 有多位講者就標 speaker；同一人連續講話可合併成一行。
4. 人名、機構名、政策名請用正確用字（例如主持人姓名、單位全稱），不確定時保留原音但不要自創詞。
5. 盡量一路轉錄到音檔結尾；真的到結尾時把 reachedEnd 設為 true。
6. 只輸出逐字稿內容，不要加任何說明或評論。`;
  },
  /** 專用轉錄模型（如 gemini-3.5-transcribe）不支援 JSON mode，改用純文字行格式。 */
  promptText({ durationLabel, fromSec, chapterHint }) {
    const startLabel = formatClock(fromSec || 0);
    return `請把這段音檔逐字轉錄成帶時間戳的文字稿。

音檔總長：${durationLabel}
這次從 ${startLabel} 開始${fromSec ? `（${startLabel} 之前已處理過，不要重複）` : ""}。
${chapterHint ? `內容脈絡參考：\n${chapterHint}\n` : ""}
輸出格式：每行一句，嚴格照這個格式，不要加任何其他說明、標題或空行。

[MM:SS] 講者：說話內容
[MM:SS] 講者：說話內容

規則：
1. 時間戳必須對應音檔真實時間並遞增；超過一小時用 [H:MM:SS]。
2. 聽不出講者是誰就省略「講者：」，直接寫內容。
3. 用繁體中文，忠實記錄；修掉「呃、那個」這類贅詞，但不要摘要、不要改寫、不要省略段落。
4. 每行約 10 到 25 秒的內容，一路轉錄到音檔結尾。`;
  },

  /** 解析 `[MM:SS] 講者：內容` 行；容忍模型偶爾漏掉方括號或講者。 */
  normalizeText(text, { durationSeconds, fromSec = 0 }) {
    const limit = durationSeconds > 0 ? Math.round(durationSeconds) + 5 : null;
    const linePattern = /^\s*[[(]?(\d{1,2}:\d{2}(?::\d{2})?)[\])]?\s*(?:([^：:\n]{1,14})[：:])?\s*(.+?)\s*$/;
    const lines = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^```/.test(line)) continue;
      const match = linePattern.exec(line);
      if (!match) continue;
      const startSec = parseTimeToSeconds(match[1]);
      if (startSec == null) continue;
      if (startSec < Math.max(0, fromSec - 15)) continue;
      if (limit && startSec > limit) continue;
      lines.push({
        startSec,
        speaker: trimText(match[2], 20),
        text: trimText(match[3], 600),
      });
    }
    lines.sort((a, b) => a.startSec - b.startSec);
    return { lines, reachedEnd: false };
  },

  normalize(json, { durationSeconds, fromSec = 0 }) {
    const limit = durationSeconds > 0 ? Math.round(durationSeconds) + 5 : null;
    const lines = (Array.isArray(json?.lines) ? json.lines : [])
      .map((row) => ({
        startSec: parseTimeToSeconds(row.time),
        speaker: trimText(row.speaker, 20),
        text: trimText(row.text, 600),
      }))
      .filter((row) => row.startSec != null && row.text && row.startSec >= Math.max(0, fromSec - 15))
      .filter((row) => (limit ? row.startSec <= limit : true))
      .sort((a, b) => a.startSec - b.startSec);
    return { lines, reachedEnd: Boolean(json?.reachedEnd) };
  },
};

/** 合併多輪轉錄結果，去掉重疊與重複句子，補上 endSec。 */
export function mergeTranscriptLines(batches, durationSeconds) {
  const all = batches.flat().sort((a, b) => a.startSec - b.startSec);
  const merged = [];
  for (const line of all) {
    const previous = merged[merged.length - 1];
    if (previous) {
      const sameText = previous.text === line.text;
      const nearDuplicate = Math.abs(previous.startSec - line.startSec) <= 2 && (sameText || line.text.startsWith(previous.text.slice(0, 12)));
      if (sameText || nearDuplicate) continue;
    }
    merged.push({ ...line });
  }
  const limit = durationSeconds > 0 ? Math.round(durationSeconds) : null;
  return merged.map((line, index) => {
    const next = merged[index + 1];
    const fallbackEnd = line.startSec + Math.max(4, Math.ceil(line.text.length / 6));
    const end = next ? Math.min(next.startSec, fallbackEnd + 20) : limit ?? fallbackEnd;
    return { ...line, endSec: Math.max(line.startSec + 1, end) };
  });
}

/* ------------------------------------------------------------------ Pass C */

export const INTERACT_PASS = {
  name: "interact",
  version: 2,
  schema: {
    type: "OBJECT",
    properties: {
      cues: {
        type: "ARRAY",
        description: "依播放時間排序的互動卡，聽到該時間點就跳出來問聽眾",
        items: {
          type: "OBJECT",
          properties: {
            time: { type: "STRING", description: "跳出時機 MM:SS（該重點剛講完之後）" },
            kind: { type: "STRING", enum: CUE_KINDS },
            headline: { type: "STRING", description: "卡片標題，12 字內" },
            context: { type: "STRING", description: "節目剛剛講到什麼，1 句 40 字內" },
            prompt: { type: "STRING", description: "丟給聽眾的問題，40 字內，要能立刻回答" },
            hint: { type: "STRING", description: "聽眾答不出來時的提示，50 字內" },
            idealAnswer: { type: "STRING", description: "節目內容支持的答案要點，100 字內" },
            supplement: { type: "STRING", description: "節目沒講到但值得補的知識或脈絡，120 字內；沒有就留空" },
          },
          required: ["time", "kind", "headline", "prompt", "idealAnswer"],
        },
      },
      gaps: {
        type: "ARRAY",
        description: "節目講得不夠、沒交代清楚、或聽完仍會有疑問的地方",
        items: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING", description: "20 字內" },
            detail: { type: "STRING", description: "缺什麼、為什麼重要，120 字內" },
            howToVerify: { type: "STRING", description: "可以怎麼查證或延伸，80 字內" },
          },
          required: ["title", "detail"],
        },
      },
      starters: {
        type: "ARRAY",
        description: "開場就能按的 3 個提問（不綁時間）",
        items: { type: "STRING" },
      },
    },
    required: ["cues", "gaps"],
  },
  prompt({ title, durationLabel, chapterBlock, transcriptBlock, cueTarget }) {
    return `你在設計一個「邊聽 Podcast 邊跟 AI 對話」的學習工具。使用者會一邊播放音檔，一邊在畫面上收到互動卡。

節目：${title}
長度：${durationLabel}

章節地圖：
${chapterBlock}

逐字稿（含時間戳）：
${transcriptBlock}

請設計 ${cueTarget} 張互動卡（cues），規則：
1. time 要落在「那個重點剛講完」的位置，不要提前劇透後面才會講的內容。平均分佈在整集，每 2 到 4 分鐘一張。
2. 問題必須能用節目剛講過的內容回答，或是順著剛講的內容往外推一步。禁止空泛題（例如「你有什麼感想」、「核心問題是什麼」）。
3. kind 的用法：
   - recall：確認剛講過的關鍵事實或數字有沒有聽進去
   - why：追問背後的原因或機制
   - apply：要聽眾套用到自己的情境
   - gap：節目沒講清楚、需要補充的地方
   - contrast：反面、代價、或不同立場的思考
   至少各出現一次，recall 不要超過總數一半。
4. context 要具體引用節目講到的事（含數字或名稱），讓使用者知道現在在哪一段。
5. supplement 是這個工具的重點：補上節目「沒講但聽眾會需要」的背景、對照數據、常見誤解或後續發展。寫實質內容，不要寫「可以自行搜尋」。
6. gaps 給 3 到 5 條，針對這集實際的資訊缺口。
7. 全部使用繁體中文，語氣像一個準備充分、會追問的學習夥伴，不要客套話。`;
  },
  normalize(json, { durationSeconds, chapters = [] }) {
    const limit = durationSeconds > 0 ? Math.round(durationSeconds) : null;
    const cues = (Array.isArray(json?.cues) ? json.cues : [])
      .map((row) => {
        const atSec = parseTimeToSeconds(row.time);
        if (atSec == null) return null;
        const chapter = chapters.find((ch) => atSec >= ch.startSec && atSec <= ch.endSec) || null;
        return {
          atSec: limit ? Math.min(atSec, Math.max(0, limit - 5)) : atSec,
          kind: CUE_KINDS.includes(row.kind) ? row.kind : "recall",
          headline: trimText(row.headline, 30),
          context: trimText(row.context, 120),
          prompt: trimText(row.prompt, 140),
          hint: trimText(row.hint, 160),
          idealAnswer: trimText(row.idealAnswer, 300),
          supplement: trimText(row.supplement, 400),
          chapterId: chapter?.id || null,
        };
      })
      .filter((row) => row && row.prompt && row.headline)
      .sort((a, b) => a.atSec - b.atSec)
      .map((row, index) => ({ id: `cue-${String(index + 1).padStart(2, "0")}`, ...row }));

    return {
      cues,
      gaps: (Array.isArray(json?.gaps) ? json.gaps : [])
        .map((row) => ({
          title: trimText(row.title, 60),
          detail: trimText(row.detail, 400),
          howToVerify: trimText(row.howToVerify, 200),
        }))
        .filter((row) => row.title && row.detail)
        .slice(0, 6),
      starters: (Array.isArray(json?.starters) ? json.starters : [])
        .map((row) => trimText(row, 80))
        .filter(Boolean)
        .slice(0, 4),
    };
  },
};
