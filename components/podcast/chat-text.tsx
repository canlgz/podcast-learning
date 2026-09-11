"use client";

import { Fragment } from "react";

type Token =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "time"; value: string; seconds: number };

/** 同時處理 **粗體** 與 [12:34] 時間戳；模型回覆帶少量 markdown 是常態。 */
function tokenize(input: string): Token[] {
  const pattern = /\*\*([^*]+)\*\*|\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;
  const tokens: Token[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input)) !== null) {
    if (match.index > lastIndex) tokens.push({ type: "text", value: input.slice(lastIndex, match.index) });
    if (match[1] != null) {
      tokens.push({ type: "bold", value: match[1] });
    } else {
      const label = match[2];
      const parts = label.split(":").map(Number);
      const seconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
      tokens.push({ type: "time", value: label, seconds });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < input.length) tokens.push({ type: "text", value: input.slice(lastIndex) });
  return tokens;
}

export function ChatText({ text, onSeek }: { text: string; onSeek?: (second: number) => void }) {
  return (
    <span className="chat-text-body">
      {tokenize(text).map((token, index) => (
        <Fragment key={index}>
          {token.type === "text" ? (
            token.value
          ) : token.type === "bold" ? (
            <strong>{token.value}</strong>
          ) : (
            <button
              type="button"
              className="inline-timecode"
              onClick={() => onSeek?.(token.seconds)}
              title={`跳到 ${token.value}`}
            >
              {token.value}
            </button>
          )}
        </Fragment>
      ))}
    </span>
  );
}
