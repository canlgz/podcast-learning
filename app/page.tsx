import Link from "next/link";

import { STATUS_LABEL, episodeCatalog, formatLength, listEpisodes } from "@/lib/podcast";

export default function Home() {
  const episodes = listEpisodes();
  const ready = episodes.filter((episode) => episode.status === "ready" || episode.status === "partial");

  return (
    <main className="podcast-shell">
      <section className="hero-panel">
        <p className="eyebrow">Podcast 互動學習工具</p>
        <h1 className="hero-title">邊聽邊被追問，把聽過的變成懂了的</h1>
        <p className="hero-description">
          把音檔丟進資料夾，工具會自動轉逐字稿、切章節，並設計好「聽到第幾分鐘該問你什麼」。
          播放時對話機器人會主動跳出來追問，並補上節目沒講到的部分。
        </p>
        <dl className="hero-stats">
          <div>
            <dt>音檔</dt>
            <dd>{episodes.length}</dd>
          </div>
          <div>
            <dt>可互動</dt>
            <dd>{ready.length}</dd>
          </div>
          <div>
            <dt>互動卡</dt>
            <dd>{episodes.reduce((sum, episode) => sum + (episode.cues?.length || 0), 0)}</dd>
          </div>
        </dl>
      </section>

      <section className="library-wrap">
        <header className="library-header">
          <h2 className="section-title">你的音檔庫</h2>
          <p className="section-note">
            來源資料夾：<code>{episodeCatalog.sourceDirectory || "尚未設定"}</code>
          </p>
        </header>

        {episodes.length === 0 ? (
          <p className="panel-empty">
            還沒有任何音檔。把 mp3 放進來源資料夾後執行 <code>npm run podcast:sync</code>。
          </p>
        ) : (
          <div className="episode-grid">
            {episodes.map((episode) => {
              const interactive = (episode.cues?.length || 0) > 0;
              return (
                <article key={episode.id} className="episode-card">
                  <div className="episode-meta">
                    <span className={`status-chip status-${episode.status}`}>{STATUS_LABEL[episode.status]}</span>
                    <h3 className="episode-title">{episode.title}</h3>
                    <p className="episode-duration">
                      {formatLength(episode.durationSeconds)}
                      {episode.chapters?.length ? ` · ${episode.chapters.length} 章` : ""}
                      {interactive ? ` · ${episode.cues?.length} 張互動卡` : ""}
                    </p>
                    <p className="episode-description">
                      {episode.oneLiner || episode.summary || episode.statusNote || "尚未分析內容。"}
                    </p>
                  </div>
                  <div className="episode-actions">
                    <Link href={`/episodes/${episode.id}`} className="action-button">
                      {interactive ? "開始邊聽邊學" : "打開播放器"}
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <footer className="shell-footer">
        <p>
          目錄最後更新：{episodeCatalog.generatedAt ? new Date(episodeCatalog.generatedAt).toLocaleString("zh-TW") : "—"}
          ｜新增或更換音檔後執行 <code>npm run podcast:sync</code> 重建。
        </p>
      </footer>
    </main>
  );
}
