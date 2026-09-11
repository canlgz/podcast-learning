"use client";

import { useEffect, useRef, useState } from "react";

import { ChatText } from "@/components/podcast/chat-text";
import { CueCard, type CueState } from "@/components/podcast/cue-card";
import { formatClock, type Cue } from "@/lib/podcast";

export type CueAction = "answer" | "hint" | "explain" | "skip" | "resume";

export type ChatItem =
  | { kind: "text"; id: string; role: "user" | "assistant"; text: string; streaming?: boolean }
  | { kind: "cue"; id: string; cue: Cue; state: CueState };

type LearningChatProps = {
  items: ChatItem[];
  loading: boolean;
  error: string;
  starters: string[];
  pausedCueId: string | null;
  currentSecond: number;
  cueCount: { passed: number; total: number };
  focusSignal: number;
  answeringCue: Cue | null;
  onSend: (text: string) => void;
  onSeek: (second: number) => void;
  onCueAction: (cueId: string, action: CueAction) => void;
};

export function LearningChat({
  items,
  loading,
  error,
  starters,
  pausedCueId,
  currentSecond,
  cueCount,
  focusSignal,
  answeringCue,
  onSend,
  onSeek,
  onCueAction,
}: LearningChatProps) {
  const [input, setInput] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [pinToBottom, setPinToBottom] = useState(true);

  useEffect(() => {
    if (!pinToBottom || !logRef.current) return;
    logRef.current.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [items, pinToBottom]);

  useEffect(() => {
    if (focusSignal > 0) inputRef.current?.focus();
  }, [focusSignal]);

  function submit() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setPinToBottom(true);
    onSend(text);
  }

  return (
    <aside className="chat-card">
      <header className="chat-header">
        <div className="chat-header-row">
          <h3 className="panel-title">學習對話</h3>
          <span className="chat-meta">
            {formatClock(currentSecond)}
            {cueCount.total > 0 ? ` · 互動 ${cueCount.passed}/${cueCount.total}` : ""}
          </span>
        </div>
        <p className="panel-note">
          播到重點時我會主動跳出來問你；任何時候也可以直接問我節目沒講清楚的地方。
        </p>
      </header>

      <div
        className="chat-log"
        ref={logRef}
        aria-live="polite"
        onScroll={(event) => {
          const element = event.currentTarget;
          setPinToBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 80);
        }}
      >
        {items.map((item) =>
          item.kind === "cue" ? (
            <CueCard
              key={item.id}
              cue={item.cue}
              state={item.state}
              paused={pausedCueId === item.cue.id}
              onAnswer={() => onCueAction(item.cue.id, "answer")}
              onHint={() => onCueAction(item.cue.id, "hint")}
              onExplain={() => onCueAction(item.cue.id, "explain")}
              onSkip={() => onCueAction(item.cue.id, "skip")}
              onResume={() => onCueAction(item.cue.id, "resume")}
              onSeek={onSeek}
            />
          ) : (
            <div key={item.id} className={`chat-bubble ${item.role}`}>
              <span className="chat-role">{item.role === "user" ? "你" : "學習陪跑員"}</span>
              <ChatText text={item.text} onSeek={onSeek} />
              {item.streaming && !item.text ? <span className="typing">正在想…</span> : null}
            </div>
          ),
        )}
      </div>

      {starters.length && items.length <= 1 ? (
        <div className="starter-row">
          {starters.map((starter) => (
            <button key={starter} type="button" className="starter-pill" onClick={() => onSend(starter)}>
              {starter}
            </button>
          ))}
        </div>
      ) : null}

      {error ? <p className="chat-error">{error}</p> : null}

      <form
        className="chat-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {answeringCue ? (
          <p className="answering-hint">
            正在回答：{answeringCue.prompt}
          </p>
        ) : null}
        <textarea
          ref={inputRef}
          className="chat-input"
          value={input}
          rows={2}
          placeholder={answeringCue ? "寫下你的答案，我幫你看哪裡漏了…" : "問我這集的任何事，或你聽不懂的地方…"}
          onChange={(event) => setInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="chat-form-foot">
          <span className="chat-hint">⌘/Ctrl + Enter 送出</span>
          <button type="submit" className="send-button" disabled={loading || !input.trim()}>
            {loading ? "回應中…" : "送出"}
          </button>
        </div>
      </form>
    </aside>
  );
}
