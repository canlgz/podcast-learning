import { episodeCatalog } from "@/lib/podcast";

/** 給外部工具／排程檢查目前目錄狀態用。 */
export function GET() {
  const episodes = episodeCatalog.episodes.map((episode) => ({
    id: episode.id,
    title: episode.title,
    status: episode.status,
    durationSeconds: episode.durationSeconds,
    chapterCount: episode.chapters?.length || 0,
    cueCount: episode.cues?.length || 0,
    segmentCount: episode.segments?.length || 0,
    builtAt: episode.stats?.builtAt,
  }));
  return Response.json({
    schemaVersion: episodeCatalog.schemaVersion,
    generatedAt: episodeCatalog.generatedAt,
    sourceDirectory: episodeCatalog.sourceDirectory,
    count: episodes.length,
    episodes,
  });
}
