import catalog from "@/data/episodes.generated.json";

export type EpisodeStatus = "ready" | "partial" | "outline-only" | "pending" | "failed";

export type CueKind = "recall" | "why" | "apply" | "gap" | "contrast";

export type Chapter = {
  id: string;
  startSec: number;
  endSec: number;
  title: string;
  gist: string;
  keyPoints: string[];
};

export type TranscriptSegment = {
  startSec: number;
  endSec: number;
  speaker?: string;
  text: string;
};

export type Cue = {
  id: string;
  atSec: number;
  kind: CueKind;
  headline: string;
  context: string;
  prompt: string;
  hint: string;
  idealAnswer: string;
  supplement: string;
  chapterId: string | null;
};

export type Gap = { title: string; detail: string; howToVerify: string };
export type KeyTerm = { term: string; explain: string; atSec: number | null };
export type Speaker = { label: string; role: string };

export type Episode = {
  id: string;
  slug: string;
  title: string;
  sourceTitle: string;
  audioUrl: string;
  durationSeconds: number;
  fileSizeBytes: number;
  status: EpisodeStatus;
  statusNote?: string;
  language?: string;
  oneLiner?: string;
  summary?: string;
  audience?: string;
  speakers?: Speaker[];
  takeaways?: string[];
  keyTerms?: KeyTerm[];
  chapters?: Chapter[];
  segments?: TranscriptSegment[];
  cues?: Cue[];
  gaps?: Gap[];
  starters?: string[];
  sourceFile?: string;
  fingerprint?: string;
  stats?: {
    builtAt?: string;
    model?: string;
    chapterCount?: number;
    segmentCount?: number;
    cueCount?: number;
    transcriptChars?: number;
    transcriptCoverage?: number;
    costUsd?: number;
    notes?: string[];
  };
};

export type Catalog = {
  schemaVersion: string;
  generatedAt: string;
  sourceDirectory?: string;
  episodes: Episode[];
};

export const episodeCatalog = catalog as unknown as Catalog;

export const CUE_KIND_LABEL: Record<CueKind, string> = {
  recall: "聽懂了嗎",
  why: "追問原因",
  apply: "換成你的情境",
  gap: "節目沒講的",
  contrast: "反面思考",
};

export const STATUS_LABEL: Record<EpisodeStatus, string> = {
  ready: "可互動",
  partial: "部分完成",
  "outline-only": "只有章節",
  pending: "待分析",
  failed: "分析失敗",
};

export function listEpisodes(): Episode[] {
  return episodeCatalog.episodes || [];
}

export function findEpisode(token: string): Episode | undefined {
  const episodes = listEpisodes();
  const decoded = safeDecode(token);
  return (
    episodes.find((episode) => episode.id === token || episode.id === decoded) ||
    episodes.find((episode) => episode.slug === token || episode.slug === decoded)
  );
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatLength(totalSeconds: number): string {
  if (!totalSeconds) return "長度未知";
  const minutes = Math.round(totalSeconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分` : `${minutes} 分鐘`;
}

export function hasInteractiveContent(episode: Episode): boolean {
  return (episode.cues?.length || 0) > 0 || (episode.chapters?.length || 0) > 0;
}

export function findChapterAt(episode: Episode, second: number): Chapter | undefined {
  const chapters = episode.chapters || [];
  return (
    chapters.find((chapter) => second >= chapter.startSec && second < chapter.endSec) ||
    [...chapters].reverse().find((chapter) => second >= chapter.startSec)
  );
}

export function findSegmentAt(episode: Episode, second: number): TranscriptSegment | undefined {
  const segments = episode.segments || [];
  return (
    segments.find((segment) => second >= segment.startSec && second < segment.endSec) ||
    [...segments].reverse().find((segment) => second >= segment.startSec)
  );
}

/** 取目前播放位置前後的逐字稿，往後只取一點點，避免提前劇透。 */
export function transcriptWindow(episode: Episode, second: number, beforeSec = 150, afterSec = 20) {
  const segments = episode.segments || [];
  return segments.filter(
    (segment) => segment.endSec >= second - beforeSec && segment.startSec <= second + afterSec,
  );
}

/** 中文沒有空白分詞，用 2-gram 做輕量關鍵詞檢索，找出整集裡最相關的段落。 */
export function retrieveSegments(episode: Episode, query: string, limit = 6): TranscriptSegment[] {
  const segments = episode.segments || [];
  if (!segments.length || !query.trim()) return [];

  const normalized = query.replace(/[\s\p{P}]+/gu, "");
  const grams = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i += 1) grams.add(normalized.slice(i, i + 2));
  const asciiWords = query.toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  if (!grams.size && !asciiWords.length) return [];

  const scored = segments.map((segment) => {
    const haystack = segment.text;
    const lower = haystack.toLowerCase();
    let score = 0;
    for (const gram of grams) if (haystack.includes(gram)) score += 1;
    for (const word of asciiWords) if (lower.includes(word)) score += 2;
    return { segment, score: score / Math.sqrt(Math.max(8, haystack.length)) };
  });

  return scored
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.segment)
    .sort((a, b) => a.startSec - b.startSec);
}

export function cueProgress(episode: Episode, second: number) {
  const cues = episode.cues || [];
  const passed = cues.filter((cue) => cue.atSec <= second).length;
  return { passed, total: cues.length };
}
