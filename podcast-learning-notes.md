# Podcast 互動學習工具

把一個資料夾裡的音檔，變成「邊聽邊被 AI 追問」的學習頁。

## 它實際上在做什麼

```
來源資料夾（.mp3/.m4a/.wav…）
        │  npm run podcast:sync
        ▼
┌──────────────────────────────────────────────┐
│ scripts/podcast/build-catalog.mjs            │
│                                              │
│ 0. 掃檔 → 算長度（不需 ffmpeg）→ hardlink 到   │
│    public/media（不佔額外空間）                │
│ 1. Pass A 章節地圖   ← 丟整段音檔給 Gemini     │
│ 2. Pass B 逐字稿     ← 帶時間戳，會自動續寫到結尾 │
│ 3. Pass C 互動腳本   ← 只吃文字，最便宜         │
│    「第幾分幾秒該問什麼、節目漏了什麼」           │
└──────────────────────────────────────────────┘
        │  data/episodes.generated.json
        ▼
網站（Next.js）
  /                   音檔庫
  /episodes/<id>      播放器 + 章節軸 + 逐字稿 + 對話機器人
  /api/chat           串流回答，回答只准引用這集的內容
  /api/episodes       目前目錄狀態（給排程或外部檢查用）
```

三個 pass 的結果都會快取在 `.cache/podcast/<檔案指紋>/`，重跑同一個檔案不會再次計費；
換了檔案或加了 `--force` 才會重新呼叫 API。

## 使用者在網頁上會遇到的互動

1. 按播放。
2. 播到 Pass C 標記的時間點，右側對話區會**主動跳出互動卡**（預設同時暫停播放）：
   - `聽懂了嗎` 確認剛講過的事實／數字
   - `追問原因` 逼你講出機制
   - `換成你的情境` 把結論套到自己的場景
   - `節目沒講的` 補節目略過的背景
   - `反面思考` 代價、反例、不同立場
3. 每張卡可以選「我來回答」（AI 會評你的答案、補漏掉的點）、「給我提示」、「直接講解」、「先繼續聽」。
4. 任何時候都能直接打字問。回答裡的 `[12:34]` 可以點，會跳回音檔那一秒。
5. 頁面下方固定顯示「聽完要帶走」、「節目沒講清楚的」、「先看懂這些名詞」。

## 開始使用

```bash
# 1. 設定金鑰（https://aistudio.google.com/apikey 免費可拿）
cp .env.example .env.local   # 已存在就直接編輯
#   GEMINI_API_KEY=你的金鑰
#   PODCAST_SOURCE_DIR=/你的/音檔資料夾

# 2. 分析音檔（第一次會花幾分鐘）
npm run podcast:sync

# 3. 開站
npm run dev     # http://localhost:5173
```

之後每次丟新音檔進資料夾，重跑 `npm run podcast:sync` 即可；已分析過的集數會跳過。

## 指令

| 指令 | 用途 |
| --- | --- |
| `npm run podcast:sync` | 掃描並分析新音檔（已完成的跳過） |
| `npm run podcast:dry` | 只列出會處理什麼，不呼叫 API、不寫檔 |
| `npm run podcast:cheap` | 略過逐字稿，只做章節＋互動卡（最省錢） |
| `npm run podcast:rebuild` | 忽略快取全部重跑（會重新計費） |
| `npm run podcast:sync:watch` | 常駐監看資料夾，有新檔就自動分析 |

直接呼叫腳本可用更細的選項：

```bash
node scripts/podcast/build-catalog.mjs \
  --source "/path/to/folder" \
  --only 4737 \          # 只處理檔名含關鍵字的
  --limit 3 \            # 這次最多處理 3 個新檔
  --model gemini-3.5-flash-lite \     # 章節與互動卡用的模型
  --transcribe-model gemini-3.8-flash \  # 逐字稿另外指定模型
  --max-rounds 8 \        # 長節目逐字稿續寫上限
  --out /tmp/test.json \  # 輸出到別的檔案（測試用，不動正式目錄）
  --media /tmp/media      # 音檔連結到別的目錄
```

## 模型選擇（2026-09 實測）

Google 的模型世代換得很快，**新申請的金鑰拿不到 `gemini-2.5-*`**（API 會回 404 並說
「no longer available to new users」）。這個專案實測過的結果：

| 模型 | 可用性 | 適合做什麼 |
| --- | --- | --- |
| `gemini-3.8-flash` | ✅ 可用 | **本專案預設**。音訊理解、JSON 結構化輸出、時間戳都正常 |
| `gemini-3.7-flash` / `gemini-3.6-flash` | ✅ 同價位 | 3.8 遇到尖峰 503 時的備援 |
| `gemini-3.5-flash` | ✅ 但較貴 | 輸入 $1.50 / 輸出 $9.00 |
| `gemini-3.5-flash-lite` | ✅ 最便宜 | $0.30 / $2.50，要極省成本時用 |
| `gemini-3.1-pro-preview` | ⚠️ 需付費帳戶 | 價目表上**沒有公布價格**，帳單不可預測，不建議當主力 |
| `gemini-3.5-transcribe` | ⚠️ 不適用 | 見下方說明 |
| `gemini-2.5-pro` / `gemini-2.5-flash` | ❌ 新金鑰不可用 | 只有既有帳號還能呼叫 |

### 為什麼不用 `gemini-3.5-transcribe`

它是專門的轉錄模型，轉出來的文字品質很好，但三個特性讓它不適合這個產品：

1. 結果放在 `parts[].audioTranscription.text`，不是一般的 `parts[].text`（程式已相容這個欄位）。
2. **不支援 JSON mode**，也不理會 prompt 指示 → **不會輸出時間戳**。本工具的跳播、互動卡時機、引用全靠時間戳。
3. 預設輸出簡體中文。

如果哪天需要極高的轉錄字準度，可行的做法是「transcribe 模型出文字 + flash 對齊時間軸」兩段式，但目前單用
`gemini-3.8-flash` 已能同時給出繁體、講者標籤與時間戳。

## 成本

費用主要來自音訊輸入（Pass A、B 各讀一次音檔，約 25 tokens／秒）與逐字稿的輸出 token。
`gemini-3.8-flash` 的單價是輸入 $0.75、輸出 $3.75（每 1M tokens，2026 年底前）。

實測一集 **31 分 52 秒** 的節目：音訊輸入約 48,000 tokens／次，整集三個 pass 合計
**約 US$0.2**。每集跑完都會印出實際 token 與估算費用，也記在
`data/episodes.generated.json` 的 `stats.costUsd`。

想更省：

- `GEMINI_MODEL=gemini-3.5-flash-lite`（便宜約 2.5 倍）
- `npm run podcast:cheap` 不做逐字稿（對話改用章節摘要作基礎，會少掉精準引用）
- 重跑時不要加 `--force`：三個 pass 與上傳結果都有快取，不會重複計費

## 狀態標示

| 狀態 | 意思 |
| --- | --- |
| `ready` | 逐字稿覆蓋 ≥90%，互動卡就緒 |
| `partial` | 逐字稿沒跑完整集（重跑 `--max-rounds` 調高可補） |
| `outline-only` | 用 `--skip-transcript` 跑的，只有章節與互動卡 |
| `pending` | 還沒分析（通常是沒設金鑰） |
| `failed` | 分析失敗，`statusNote` 會寫原因 |

## 已知限制

- 時間戳由模型聽出來，長節目後段可能有幾秒偏移；逐字稿每一行都可點播，容易自行校正。
- 逐字稿偶爾會寫錯專有名詞（實測出現過把主持人「劉傑中」寫成「劉捷中」）。章節地圖那一關通常是對的，可互相對照。
- 互動卡的「節目沒提到」補充來自模型自身知識，**沒有經過查證**。介面上已標明出處是補充而非節目內容，但重要數據建議自行確認。
- 逐字稿是一次性產生後快取，不是即時轉錄。
- 對話歷程存在瀏覽器記憶體裡，重新整理就消失（要保留需接資料庫）。
- `public/media` 是來源檔的 hardlink，不佔額外空間，但跨磁碟時會退回複製。

## 還可以往下做

- 把對話與答題紀錄寫入 D1（`db/` 已有 drizzle 設定），做學習歷程回顧。
- 互動卡答題結果做成複習清單，隔天重問答錯的。
- 多集之間的概念連結（同一個名詞在不同集怎麼被講）。
- 用 cron 或 launchd 取代 `--watch`，讓同步變常駐服務。
