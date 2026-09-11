import Link from "next/link";
import { notFound } from "next/navigation";

import { EpisodeBrief } from "@/components/podcast/episode-brief";
import { EpisodeWorkspace } from "@/components/podcast/episode-workspace";
import { STATUS_LABEL, findEpisode, formatLength, listEpisodes } from "@/lib/podcast";

export function generateStaticParams() {
  return listEpisodes().map((episode) => ({ slug: episode.id }));
}

export default async function EpisodePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const episode = findEpisode(slug);
  if (!episode) notFound();

  return (
    <main className="episode-shell">
      <header className="episode-header">
        <Link href="/" className="back-link">
          ← 音檔庫
        </Link>
        <div className="episode-header-main">
          <span className={`status-chip status-${episode.status}`}>{STATUS_LABEL[episode.status]}</span>
          <h1 className="episode-title-large">{episode.title}</h1>
          <p className="meta-line">
            {formatLength(episode.durationSeconds)}
            {episode.chapters?.length ? ` · ${episode.chapters.length} 章` : ""}
            {episode.cues?.length ? ` · ${episode.cues.length} 張互動卡` : ""}
            {episode.segments?.length ? ` · 逐字稿 ${episode.segments.length} 行` : ""}
          </p>
          {episode.statusNote ? <p className="status-note">{episode.statusNote}</p> : null}
        </div>
      </header>

      <EpisodeWorkspace episode={episode} />

      <EpisodeBrief episode={episode} />
    </main>
  );
}
