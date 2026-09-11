import { formatClock, type Episode } from "@/lib/podcast";

/** 聽完要帶走什麼、節目漏了什麼、名詞先看懂——純靜態，不需要 JS。 */
export function EpisodeBrief({ episode }: { episode: Episode }) {
  const takeaways = episode.takeaways || [];
  const gaps = episode.gaps || [];
  const keyTerms = episode.keyTerms || [];
  if (!takeaways.length && !gaps.length && !keyTerms.length) return null;

  return (
    <section className="brief-grid">
      {takeaways.length ? (
        <article className="brief-card">
          <h3 className="panel-title">聽完要帶走</h3>
          <ul className="brief-list">
            {takeaways.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>
      ) : null}

      {gaps.length ? (
        <article className="brief-card brief-card-warn">
          <h3 className="panel-title">節目沒講清楚的</h3>
          <ul className="brief-list">
            {gaps.map((gap) => (
              <li key={gap.title}>
                <strong>{gap.title}</strong>
                <span className="brief-detail">{gap.detail}</span>
                {gap.howToVerify ? <span className="brief-verify">怎麼查：{gap.howToVerify}</span> : null}
              </li>
            ))}
          </ul>
        </article>
      ) : null}

      {keyTerms.length ? (
        <article className="brief-card">
          <h3 className="panel-title">先看懂這些名詞</h3>
          <dl className="term-list">
            {keyTerms.map((term) => (
              <div key={term.term} className="term-row">
                <dt>
                  {term.term}
                  {term.atSec != null ? <span className="term-time">{formatClock(term.atSec)}</span> : null}
                </dt>
                <dd>{term.explain}</dd>
              </div>
            ))}
          </dl>
        </article>
      ) : null}
    </section>
  );
}
