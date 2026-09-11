"use client";

import { formatClock, type Chapter, type Cue } from "@/lib/podcast";

type ChapterRailProps = {
  chapters: Chapter[];
  cues: Cue[];
  durationSeconds: number;
  currentSecond: number;
  onSeek: (second: number) => void;
};

export function ChapterRail({ chapters, cues, durationSeconds, currentSecond, onSeek }: ChapterRailProps) {
  if (!chapters.length) return null;
  const total = durationSeconds || chapters[chapters.length - 1].endSec || 1;
  const activeIndex = chapters.findIndex(
    (chapter) => currentSecond >= chapter.startSec && currentSecond < chapter.endSec,
  );

  return (
    <section className="rail-wrap">
      <div className="rail-head">
        <h3 className="panel-title">章節地圖</h3>
        <p className="panel-note">{chapters.length} 章 · 點任一段可跳播</p>
      </div>

      <div className="rail-bar" role="group" aria-label="章節時間軸">
        {chapters.map((chapter, index) => {
          const width = Math.max(2, ((chapter.endSec - chapter.startSec) / total) * 100);
          return (
            <button
              key={chapter.id}
              type="button"
              className={`rail-chunk ${index === activeIndex ? "rail-chunk-active" : ""}`}
              style={{ width: `${width}%` }}
              onClick={() => onSeek(chapter.startSec)}
              title={`${formatClock(chapter.startSec)} ${chapter.title}`}
            >
              <span className="rail-chunk-label">{index + 1}</span>
            </button>
          );
        })}
        <span className="rail-progress" style={{ left: `${Math.min(100, (currentSecond / total) * 100)}%` }} />
        {cues.map((cue) => (
          <span
            key={cue.id}
            className="rail-cue-dot"
            style={{ left: `${Math.min(100, (cue.atSec / total) * 100)}%` }}
            title={`${formatClock(cue.atSec)} ${cue.headline}`}
          />
        ))}
      </div>

      <ol className="chapter-list">
        {chapters.map((chapter, index) => (
          <li key={chapter.id} className={index === activeIndex ? "chapter-item chapter-item-active" : "chapter-item"}>
            <button type="button" className="chapter-button" onClick={() => onSeek(chapter.startSec)}>
              <span className="chapter-time">{formatClock(chapter.startSec)}</span>
              <span className="chapter-body">
                <span className="chapter-title">{chapter.title}</span>
                <span className="chapter-gist">{chapter.gist}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
