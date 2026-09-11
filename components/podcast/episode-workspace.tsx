"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChapterRail } from "@/components/podcast/chapter-rail";
import { LearningChat, type ChatItem, type CueAction } from "@/components/podcast/learning-chat";
import { TranscriptPanel } from "@/components/podcast/transcript-panel";
import type { CueState } from "@/components/podcast/cue-card";
import { cueProgress, findChapterAt, formatClock, type Cue, type Episode } from "@/lib/podcast";

/** 播放時間超過提示點多久之內才觸發，避免快轉時一次噴出一堆卡片。 */
const CUE_TRIGGER_WINDOW_SEC = 25;
const SPEEDS = [0.8, 1, 1.25, 1.5, 1.75, 2];

export function EpisodeWorkspace({ episode }: { episode: Episode }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentSecond, setCurrentSecond] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [cuesEnabled, setCuesEnabled] = useState(true);
  const [autoPause, setAutoPause] = useState(true);

  const [items, setItems] = useState<ChatItem[]>(() => [
    {
      kind: "text",
      id: "intro",
      role: "assistant",
      text: episode.summary
        ? `這集的主軸是：${episode.summary}\n\n按下播放就可以開始。我會在關鍵處跳出來問你問題，也會補上節目沒講到的部分。`
        : "按下播放就可以開始。這集還沒做完內容分析，我只能做有限的回答。",
    },
  ]);
  const itemsRef = useRef<ChatItem[]>([]);
  /** 所有對話變更都走這裡：ref 同步更新，送出請求時才能讀到最新歷史。 */
  const commit = useCallback((updater: (prev: ChatItem[]) => ChatItem[]) => {
    itemsRef.current = updater(itemsRef.current);
    setItems(itemsRef.current);
  }, []);

  const [cueStates, setCueStates] = useState<Record<string, CueState>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [answeringCueId, setAnsweringCueId] = useState<string | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const firedRef = useRef<Set<string>>(new Set());
  if (itemsRef.current.length === 0) itemsRef.current = items;
  const autoPausedRef = useRef(false);

  const cues = useMemo(() => episode.cues || [], [episode.cues]);
  const answeringCue = useMemo(() => cues.find((cue) => cue.id === answeringCueId) || null, [cues, answeringCueId]);
  const chapter = findChapterAt(episode, currentSecond);

  /* ------------------------------------------------------------ 播放器控制 */

  const seek = useCallback((second: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, second);
    setCurrentSecond(Math.max(0, second));
    void audio.play().catch(() => undefined);
  }, []);

  const nudge = useCallback((delta: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, audio.currentTime + delta);
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => setCurrentSecond(audio.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
    };
  }, []);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  // 支援 ?t=251 這種深連結，可以直接分享「從某一秒開始聽」。
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const requested = Number(new URLSearchParams(window.location.search).get("t"));
    if (!Number.isFinite(requested) || requested <= 0) return;

    const jump = () => {
      audio.currentTime = requested;
      setCurrentSecond(requested);
    };
    if (audio.readyState >= 1) jump();
    else audio.addEventListener("loadedmetadata", jump, { once: true });
    return () => audio.removeEventListener("loadedmetadata", jump);
  }, []);

  /* ------------------------------------------------------- 時間軸互動卡排程 */

  useEffect(() => {
    if (!cuesEnabled) return;
    const due = cues.find(
      (cue) =>
        !firedRef.current.has(cue.id) &&
        currentSecond >= cue.atSec &&
        currentSecond - cue.atSec <= CUE_TRIGGER_WINDOW_SEC,
    );
    if (!due) return;

    firedRef.current.add(due.id);
    setCueStates((prev) => ({ ...prev, [due.id]: { revealed: "none", status: "open" } }));
    commit((prev) => [
      ...prev,
      { kind: "cue", id: `cue-item-${due.id}`, cue: due, state: { revealed: "none", status: "open" } },
    ]);
    if (autoPause && audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
      autoPausedRef.current = true;
    }
  }, [currentSecond, cues, cuesEnabled, autoPause, commit]);

  const patchCueState = useCallback((cueId: string, patch: Partial<CueState>) => {
    setCueStates((prev) => {
      const next = { ...(prev[cueId] || { revealed: "none", status: "open" }), ...patch };
      return { ...prev, [cueId]: next };
    });
    commit((prev) =>
      prev.map((item) =>
        item.kind === "cue" && item.cue.id === cueId ? { ...item, state: { ...item.state, ...patch } } : item,
      ),
    );
  }, [commit]);

  const resumePlayback = useCallback(() => {
    autoPausedRef.current = false;
    void audioRef.current?.play().catch(() => undefined);
  }, []);

  /* --------------------------------------------------------------- 對話送出 */

  const buildHistory = useCallback(
    (list: ChatItem[]) =>
      list
        .filter((item) => item.kind !== "text" || item.text.trim().length > 0)
        .slice(-9)
        .map((item) =>
          item.kind === "cue"
            ? { role: "assistant" as const, content: `［互動卡 ${formatClock(item.cue.atSec)}］${item.cue.prompt}` }
            : { role: item.role, content: item.text },
        )
        .filter((row) => row.content.trim().length > 0),
    [],
  );

  const send = useCallback(
    async (text: string, options?: { mode?: "answer" | "grade"; cueId?: string }) => {
      if (loading) return;
      const mode = options?.mode || "answer";
      const cueId = options?.cueId;
      setError("");
      setLoading(true);

      const userItem: ChatItem = { kind: "text", id: `u-${Date.now()}`, role: "user", text };
      const assistantId = `a-${Date.now()}`;
      const history = buildHistory(itemsRef.current);
      commit((prev) => [
        ...prev,
        userItem,
        { kind: "text", id: assistantId, role: "assistant", text: "", streaming: true },
      ]);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            episodeId: episode.id,
            message: text,
            currentSecond: Math.round(audioRef.current?.currentTime ?? currentSecond),
            cueId,
            mode,
            history,
          }),
        });

        if (!response.ok || !response.body) {
          const detail = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(detail?.error || `伺服器回應 ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let answer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = JSON.parse(trimmed.slice(5).trim()) as { delta?: string; done?: boolean; error?: string };
            if (payload.error) throw new Error(payload.error);
            if (payload.delta) {
              answer += payload.delta;
              commit((prev) =>
                prev.map((item) =>
                  item.kind === "text" && item.id === assistantId ? { ...item, text: answer } : item,
                ),
              );
            }
          }
        }

        commit((prev) =>
          prev.map((item) =>
            item.kind === "text" && item.id === assistantId
              ? { ...item, text: answer || "（沒有收到內容，請再試一次）", streaming: false }
              : item,
          ),
        );
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "連線失敗";
        setError(message);
        commit((prev) => prev.filter((item) => !(item.kind === "text" && item.id === assistantId)));
      } finally {
        setLoading(false);
      }
    },
    [buildHistory, commit, currentSecond, episode.id, loading],
  );

  const handleSend = useCallback(
    (text: string) => {
      if (answeringCueId) {
        const cueId = answeringCueId;
        setAnsweringCueId(null);
        patchCueState(cueId, { status: "answered", revealed: "answer" });
        if (autoPausedRef.current) resumePlayback();
        void send(text, { mode: "grade", cueId });
        return;
      }
      void send(text);
    },
    [answeringCueId, patchCueState, resumePlayback, send],
  );

  const handleCueAction = useCallback(
    (cueId: string, action: CueAction) => {
      if (action === "answer") {
        setAnsweringCueId(cueId);
        setFocusSignal((value) => value + 1);
        return;
      }
      if (action === "hint") {
        patchCueState(cueId, { revealed: "hint" });
        return;
      }
      if (action === "explain") {
        patchCueState(cueId, { revealed: "answer", status: "answered" });
        return;
      }
      if (action === "skip") {
        patchCueState(cueId, { status: "skipped" });
        if (answeringCueId === cueId) setAnsweringCueId(null);
        resumePlayback();
        return;
      }
      resumePlayback();
    },
    [answeringCueId, patchCueState, resumePlayback],
  );

  const starters = useMemo(() => {
    const fromCatalog = episode.starters || [];
    if (fromCatalog.length) return fromCatalog.slice(0, 3);
    if (!episode.summary) return [];
    return ["這集最值得記住的三件事是什麼？", "節目裡哪個說法最站不住腳？", "這集沒講到但我該知道的是什麼？"];
  }, [episode.starters, episode.summary]);

  // 只有最新跳出、仍未處理的那張卡需要顯示「繼續播放」，避免每張卡都重複提示。
  const openCues = cues.filter((cue) => cueStates[cue.id]?.status === "open");
  const pausedCueId = !playing && openCues.length > 0 ? openCues[openCues.length - 1].id : null;

  return (
    <div className="workspace">
      <div className="workspace-main">
        <section className="player-card">
          <div className="player-top">
            <div>
              <p className="player-now">
                {chapter ? `正在聽：${chapter.title}` : "尚未開始"}
                {chapter ? <span className="player-range">（{formatClock(chapter.startSec)}–{formatClock(chapter.endSec)}）</span> : null}
              </p>
              <p className="panel-note">
                {formatClock(currentSecond)} / {formatClock(episode.durationSeconds)}
              </p>
            </div>
            <div className="player-switches">
              <label className="switch">
                <input type="checkbox" checked={cuesEnabled} onChange={(event) => setCuesEnabled(event.currentTarget.checked)} />
                主動互動卡
              </label>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={autoPause}
                  disabled={!cuesEnabled}
                  onChange={(event) => setAutoPause(event.currentTarget.checked)}
                />
                跳出時自動暫停
              </label>
            </div>
          </div>

          <audio ref={audioRef} controls preload="metadata" className="player-audio" src={episode.audioUrl}>
            你的瀏覽器不支援音檔播放。
          </audio>

          <div className="player-controls">
            <button type="button" className="ghost-button" onClick={() => nudge(-15)}>
              ⟲ 15 秒
            </button>
            <button type="button" className="ghost-button" onClick={() => nudge(15)}>
              15 秒 ⟳
            </button>
            <label className="speed-control">
              速度
              <select value={speed} onChange={(event) => setSpeed(Number(event.currentTarget.value))}>
                {SPEEDS.map((value) => (
                  <option key={value} value={value}>
                    {value}×
                  </option>
                ))}
              </select>
            </label>
            {playing ? <span className="playing-dot">播放中</span> : null}
          </div>
        </section>

        {cues.length === 0 ? (
          <p className="panel-empty">
            這集還沒有互動腳本。執行 <code>npm run podcast:sync</code> 產生內容分析後，播放時就會自動跳出引導問題。
          </p>
        ) : null}

        <ChapterRail
          chapters={episode.chapters || []}
          cues={cues}
          durationSeconds={episode.durationSeconds}
          currentSecond={currentSecond}
          onSeek={seek}
        />

        <TranscriptPanel episode={episode} currentSecond={currentSecond} onSeek={seek} />
      </div>

      <LearningChat
        items={items}
        loading={loading}
        error={error}
        starters={starters}
        pausedCueId={pausedCueId}
        currentSecond={currentSecond}
        cueCount={cueProgress(episode, currentSecond)}
        focusSignal={focusSignal}
        answeringCue={answeringCue as Cue | null}
        onSend={handleSend}
        onSeek={seek}
        onCueAction={handleCueAction}
      />
    </div>
  );
}
