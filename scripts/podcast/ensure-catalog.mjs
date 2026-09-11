#!/usr/bin/env node
/**
 * 網站會靜態 import data/episodes.generated.json，檔案不存在就無法啟動。
 * 剛 clone 下來還沒跑過分析時，先補一個空目錄，讓 npm run dev / build 能動。
 */
import fs from "node:fs";
import path from "node:path";

const target = path.join(process.cwd(), "data/episodes.generated.json");
if (!fs.existsSync(target)) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    `${JSON.stringify({ schemaVersion: "2.0", generatedAt: null, sourceDirectory: "", episodes: [] }, null, 2)}\n`,
    "utf8",
  );
  console.log("已建立空的 data/episodes.generated.json；執行 npm run podcast:sync 產生內容。");
}
