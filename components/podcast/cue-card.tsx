"use client";

import { CUE_KIND_LABEL, formatClock, type Cue } from "@/lib/podcast";

export type CueState = {
  revealed: "none" | "hint" | "answer";
  status: "open" | "answered" | "skipped";
};

type CueCardProps = {
  cue: Cue;
  state: CueState;
  paused: boolean;
  onAnswer: () => void;
  onHint: () => void;
  onExplain: () => void;
  onSkip: () => void;
  onResume: () => void;
  onSeek: (second: number) => void;
};

export function CueCard({ cue, state, paused, onAnswer, onHint, onExplain, onSkip, onResume, onSeek }: CueCardProps) {
  return (
    <article className={`cue-card cue-${cue.kind} ${state.status === "skipped" ? "cue-dimmed" : ""}`}>
      <header className="cue-head">
        <span className={`cue-kind kind-${cue.kind}`}>{CUE_KIND_LABEL[cue.kind]}</span>
        <button type="button" className="cue-time" onClick={() => onSeek(cue.atSec)} title="重聽這一段">
          {formatClock(cue.atSec)}
        </button>
      </header>

      <h4 className="cue-headline">{cue.headline}</h4>
      {cue.context ? <p className="cue-context">{cue.context}</p> : null}
      <p className="cue-prompt">{cue.prompt}</p>

      {state.revealed !== "none" && cue.hint ? <p className="cue-hint">提示：{cue.hint}</p> : null}
      {state.revealed === "answer" ? (
        <div className="cue-answer">
          <p>
            <strong>節目裡的答案：</strong>
            {cue.idealAnswer}
          </p>
          {cue.supplement ? (
            <p className="cue-supplement">
              <strong>節目沒提到：</strong>
              {cue.supplement}
            </p>
          ) : null}
        </div>
      ) : null}

      {state.status === "open" ? (
        <div className="cue-actions">
          <button type="button" className="cue-btn cue-btn-primary" onClick={onAnswer}>
            我來回答
          </button>
          {cue.hint && state.revealed === "none" ? (
            <button type="button" className="cue-btn" onClick={onHint}>
              給我提示
            </button>
          ) : null}
          <button type="button" className="cue-btn" onClick={onExplain}>
            直接講解
          </button>
          <button type="button" className="cue-btn cue-btn-ghost" onClick={onSkip}>
            先繼續聽
          </button>
        </div>
      ) : null}

      {paused && state.status === "open" ? (
        <p className="cue-paused">
          已暫停播放。
          <button type="button" className="cue-link" onClick={onResume}>
            繼續播放
          </button>
        </p>
      ) : null}
    </article>
  );
}
