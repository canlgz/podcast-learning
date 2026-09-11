"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { formatClock, type Episode } from "@/lib/podcast";

type TranscriptPanelProps = {
  episode: Episode;
  currentSecond: number;
  onSeek: (second: number) => void;
};

export function TranscriptPanel({ episode, currentSecond, onSeek }: TranscriptPanelProps) {
  const segments = useMemo(() => episode.segments || [], [episode.segments]);
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLOListElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);

  const rows = useMemo(() => {
    if (!query.trim()) return segments;
    const needle = query.trim().toLowerCase();
    return segments.filter((segment) => segment.text.toLowerCase().includes(needle));
  }, [segments, query]);

  const activeIndex = useMemo(() => {
    let index = -1;
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i].startSec <= currentSecond) index = i;
      else break;
    }
    return index;
  }, [rows, currentSecond]);

  useEffect(() => {
    if (!follow || query.trim() || !activeRef.current || !listRef.current) return;
    const list = listRef.current;
    const item = activeRef.current;
    const offset = item.offsetTop - list.offsetTop - list.clientHeight / 3;
    list.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });
  }, [activeIndex, follow, query]);

  if (!segments.length) {
    return (
      <section className="panel">
        <h3 className="panel-title">逐字稿</h3>
        <p className="panel-empty">
          這集還沒有逐字稿。在終端機執行{" "}
          <code>npm run podcast:sync</code> 產生後重新整理即可。
        </p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h3 className="panel-title">逐字稿</h3>
        <p className="panel-note">{segments.length} 行 · 點任一行跳播</p>
      </div>

      <div className="transcript-tools">
        <input
          className="transcript-search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="搜尋這集講過的字句"
          type="search"
        />
        <label className="follow-toggle">
          <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.currentTarget.checked)} />
          跟著播放滾動
        </label>
      </div>

      {rows.length === 0 ? (
        <p className="panel-empty">找不到「{query}」。</p>
      ) : (
        <ol className="segment-list" ref={listRef}>
          {rows.map((segment, index) => {
            const isActive = index === activeIndex && !query.trim();
            return (
              <li
                key={`${segment.startSec}-${index}`}
                ref={isActive ? activeRef : null}
                className={isActive ? "segment-row segment-row-active" : "segment-row"}
              >
                <button type="button" className="segment-button" onClick={() => onSeek(segment.startSec)}>
                  <span className="segment-time">{formatClock(segment.startSec)}</span>
                  <span className="segment-text">
                    {segment.speaker ? <strong className="segment-speaker">{segment.speaker}：</strong> : null}
                    {segment.text}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
