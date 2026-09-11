import { NextRequest } from "next/server";
import { z } from "zod";

import {
  CUE_KIND_LABEL,
  findChapterAt,
  findEpisode,
  formatClock,
  retrieveSegments,
  transcriptWindow,
  type Episode,
} from "@/lib/podcast";

const RequestSchema = z.object({
  episodeId: z.string().min(1),
  message: z.string().min(1).max(2000),
  currentSecond: z.number().min(0).max(12 * 3600).optional(),
  cueId: z.string().max(40).optional(),
  mode: z.enum(["answer", "grade", "hint", "explain"]).default("answer"),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(4000) }))
    .max(20)
    .default([]),
});

const SYSTEM_INSTRUCTION = `你是「邊聽邊學」的學習陪跑員，陪使用者一邊聽 Podcast 一邊把內容吃透。

你的任務不是複述節目，而是：
1. 確認使用者真的聽懂剛剛那一段。
2. 補上節目沒講、但理解這個主題需要的背景、對照數據或常見誤解。
3. 指出節目講得不夠、跳過或可能有問題的地方。

規則：
- 一律使用繁體中文，語氣像一個準備充分、會追問的學習夥伴，不要客套、不要條列一堆廢話。
- 引用節目內容時一定標時間戳，格式 [MM:SS]，使用者可以點回去聽。
- 節目裡有講的寫「節目在 [MM:SS] 提到…」；你額外補充的寫「節目沒提到：…」。兩者不要混在一起。
- 提供的逐字稿沒覆蓋到、或你不確定的事，直接說不確定，絕對不要編造節目沒說過的話。
- 使用者正在聽節目，回覆控制在 250 字內，先給結論再給理由。
- 結尾用一句話給下一步：一個可以接著想的問題，或建議聽哪一段。`;

export async function POST(request: NextRequest) {
  let parsed;
  try {
    parsed = RequestSchema.safeParse(await request.json());
  } catch {
    return jsonError("請求格式錯誤", 400);
  }
  if (!parsed.success) return jsonError("請求缺少 episodeId 或 message", 400);

  const payload = parsed.data;
  const episode = findEpisode(payload.episodeId);
  if (!episode) return jsonError("找不到這一集", 404);

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    return jsonError(
      "還沒設定 GEMINI_API_KEY，所以無法回答。請在專案根目錄的 .env.local 填入金鑰後重啟 npm run dev。",
      503,
    );
  }

  const model = process.env.GEMINI_CHAT_MODEL || "gemini-2.5-flash";
  // Pro 不能關 thinking；其他型號關掉可以省 token、回得更快。
  const canDisableThinking = !/pro/i.test(model);
  const prompt = buildPrompt(episode, payload);

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          ...payload.history.map((row) => ({
            role: row.role === "assistant" ? "model" : "user",
            parts: [{ text: row.content }],
          })),
          { role: "user", parts: [{ text: prompt }] },
        ],
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        generationConfig: {
          temperature: 0.45,
          maxOutputTokens: 2048,
          ...(canDisableThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      }),
    },
  );

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return jsonError(`Gemini 回應錯誤 ${upstream.status}：${detail.slice(0, 200)}`, 502);
  }

  return new Response(toTextDeltaStream(upstream.body), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/** 把 Gemini 的 SSE 轉成前端只需要處理的 {delta} / {done} 事件。 */
function toTextDeltaStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream({
    async start(controller) {
      const reader = body.getReader();
      const send = (data: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n");
          buffer = blocks.pop() ?? "";
          for (const line of blocks) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const raw = trimmed.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;
            try {
              const chunk = JSON.parse(raw) as {
                candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
              };
              const text = (chunk.candidates?.[0]?.content?.parts || [])
                .map((part) => part.text || "")
                .join("");
              if (text) send({ delta: text });
            } catch {
              /* 忽略切半的 chunk */
            }
          }
        }
        send({ done: true });
      } catch (error) {
        send({ error: error instanceof Error ? error.message : "串流中斷" });
      } finally {
        controller.close();
        reader.releaseLock();
      }
    },
  });
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

type Payload = z.infer<typeof RequestSchema>;

function buildPrompt(episode: Episode, payload: Payload) {
  const second = Math.round(payload.currentSecond ?? 0);
  const chapter = findChapterAt(episode, second);
  const heard = transcriptWindow(episode, second);
  const related = retrieveSegments(episode, payload.message, 6).filter(
    (segment) => !heard.some((row) => row.startSec === segment.startSec),
  );
  const cue = (episode.cues || []).find((row) => row.id === payload.cueId);

  const blocks: string[] = [];
  blocks.push(`【節目】${episode.title}（總長 ${formatClock(episode.durationSeconds)}）`);
  blocks.push(`【使用者目前聽到】${formatClock(second)}${chapter ? `，第 ${chapter.id.replace("ch-", "")} 章「${chapter.title}」` : ""}`);
  if (episode.summary) blocks.push(`【本集摘要】${episode.summary}`);
  if (chapter) {
    blocks.push(
      `【這一章在講什麼】${chapter.gist}${chapter.keyPoints.length ? `\n重點：${chapter.keyPoints.map((point) => `・${point}`).join("\n")}` : ""}`,
    );
  }
  if (heard.length) {
    blocks.push(`【剛剛聽到的逐字稿】\n${formatSegments(heard)}`);
  } else if (!episode.segments?.length) {
    blocks.push("【逐字稿】這集還沒產生逐字稿，只能依摘要與章節回答，請明確告訴使用者這個限制。");
  }
  if (related.length) {
    blocks.push(`【整集中與問題相關的其他段落】\n${formatSegments(related)}`);
  }
  if (cue) {
    blocks.push(
      [
        `【互動卡情境】（${CUE_KIND_LABEL[cue.kind]}）`,
        `剛剛的提問：${cue.prompt}`,
        `節目內容支持的答案要點：${cue.idealAnswer}`,
        cue.supplement ? `可補充的節目外知識：${cue.supplement}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const modeInstruction: Record<Payload["mode"], string> = {
    answer: "請回答使用者的問題。",
    grade:
      "使用者正在回答上面那張互動卡。請先判斷「答對了／方向對但不完整／不太對」並用一句話說理由，接著補上他漏掉的要點（引用時間戳），再給一段節目沒提到的補充，最後一句話請他繼續聽。",
    hint: "使用者要提示但不要答案。請給一個能把他推近答案的提示（指出該注意哪一段、哪個線索），不要直接講出答案。",
    explain:
      "使用者要看解答。請完整說明節目在這段的答案（引用時間戳），再補一段節目沒提到但重要的背景，最後指出這裡還有什麼值得懷疑或查證。",
  };

  blocks.push(`【使用者的話】${payload.message}`);
  blocks.push(`【這次要怎麼回】${modeInstruction[payload.mode]}`);
  return blocks.join("\n\n");
}

function formatSegments(segments: Array<{ startSec: number; speaker?: string; text: string }>) {
  return segments
    .map((segment) => `[${formatClock(segment.startSec)}]${segment.speaker ? ` ${segment.speaker}：` : " "}${segment.text}`)
    .join("\n");
}
