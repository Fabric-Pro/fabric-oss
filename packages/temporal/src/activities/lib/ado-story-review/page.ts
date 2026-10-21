/**
 * The page a story review publishes. A workflow writes it with nobody watching,
 * so it is drawn with every script removed (`isUnattendedFrame`): the layout is
 * HTML and one inline stylesheet, with colours for light and dark, and nothing
 * fetched. Every value from Azure DevOps or the model is escaped here or by the
 * caller before it reaches the markup.
 */

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (character) => {
		switch (character) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			case "'":
				return "&#39;";
			default:
				return character;
		}
	});
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fafaf9;--card:#fff;--muted:#f5f5f4;--border:#e7e5e4;--text:#1c1917;--soft:#57534e;--faint:#78716c;--accent:#9f2a3a;--ok:#047857;--ok-bg:#ecfdf5;--warn:#b45309;--warn-bg:#fffbeb;--bad:#b91c1c;--bad-bg:#fef2f2}
@media (prefers-color-scheme:dark){:root{--bg:#18181b;--card:#1c1c1e;--muted:#27272a;--border:#3f3f46;--text:#f4f4f5;--soft:#d4d4d8;--faint:#a1a1aa;--accent:#c4556a;--ok:#34d399;--ok-bg:#064e3b55;--warn:#fbbf24;--warn-bg:#78350f55;--bad:#f87171;--bad-bg:#7f1d1d55}}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px 40px;background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.label{font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--faint);border-left:2px solid var(--accent);padding-left:8px;margin:0 0 8px}
h1{font:400 30px/1.2 "EB Garamond",Georgia,serif;margin:0 0 8px}
h2{font-size:16px;font-weight:600;margin:0}
h3{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:16px 0 6px}
.lede{color:var(--soft);margin:0 0 20px;max-width:72ch}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:0 0 24px}
.tile{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
.tile b{display:block;font-size:24px;font-weight:600;line-height:1.1}
.tile span{font-size:12px;color:var(--faint)}
.tile.ok b{color:var(--ok)}.tile.warn b{color:var(--warn)}.tile.bad b{color:var(--bad)}
section{margin:0 0 24px}
.panel{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
ul{margin:0;padding-left:18px}li{margin:2px 0}
.changes li{color:var(--soft)}
.cards{display:grid;gap:12px}
.card{background:var(--card);border:1px solid var(--border);border-left:4px solid var(--border);border-radius:12px;padding:16px 18px}
.card.ready{border-left-color:var(--ok)}.card.needs_work{border-left-color:var(--warn)}.card.blocked{border-left-color:var(--bad)}
.card-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 16px}
.meta{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 10px}
.chip{font-size:12px;color:var(--soft);background:var(--muted);border-radius:999px;padding:2px 9px}
.badge{font-size:12px;font-weight:600;border-radius:999px;padding:2px 10px;white-space:nowrap}
.badge.ready{color:var(--ok);background:var(--ok-bg)}.badge.needs_work{color:var(--warn);background:var(--warn-bg)}.badge.blocked{color:var(--bad);background:var(--bad-bg)}
.summary{margin:0 0 8px}
.issues li{margin:4px 0}
details{margin-top:10px;border-top:1px solid var(--border);padding-top:8px}
summary{cursor:pointer;color:var(--faint);font-size:12px}
details ul{margin-top:6px;color:var(--soft)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:600;color:var(--faint);font-size:11px;letter-spacing:.08em;text-transform:uppercase;border-bottom:1px solid var(--border);padding:6px 8px}
td{border-bottom:1px solid var(--border);padding:7px 8px;vertical-align:top}
tr:last-child td{border-bottom:0}
.scroll{overflow-x:auto}
.empty{color:var(--faint);margin:0}
`;

export type ReviewVerdict = "ready" | "needs_work" | "blocked";

const VERDICT_LABELS: Record<ReviewVerdict, string> = {
	ready: "Ready",
	needs_work: "Needs work",
	blocked: "Blocked",
};

export interface ReviewTile {
	label: string;
	value: number;
	tone?: "ok" | "warn" | "bad";
}

export function verdictBadge(verdict: ReviewVerdict): string {
	return `<span class="badge ${verdict}">${VERDICT_LABELS[verdict]}</span>`;
}

export function verdictTiles(verdicts: readonly ReviewVerdict[]): ReviewTile[] {
	const count = (verdict: ReviewVerdict) =>
		verdicts.filter((value) => value === verdict).length;
	return [
		{ label: "Ready", value: count("ready"), tone: "ok" },
		{ label: "Needs work", value: count("needs_work"), tone: "warn" },
		{ label: "Blocked", value: count("blocked"), tone: "bad" },
	];
}

/** One story: its link (already escaped), verdict, facts, summary and gaps. */
export function storyCard(input: {
	titleHtml: string;
	verdict: ReviewVerdict;
	facts: readonly string[];
	summary: string;
	issues: readonly string[];
	moreHtml?: string;
}): string {
	const issues = input.issues.length
		? `<h3>Gaps</h3><ul class="issues">${input.issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul>`
		: "";
	return `<article class="card ${input.verdict}"><div class="card-head"><h2>${input.titleHtml}</h2>${verdictBadge(input.verdict)}</div><div class="meta">${input.facts.map((fact) => `<span class="chip">${escapeHtml(fact)}</span>`).join("")}</div><p class="summary">${escapeHtml(input.summary)}</p>${issues}${input.moreHtml ?? ""}</article>`;
}

/** A whole review page. `sectionsHtml` is markup the caller already escaped. */
export function reviewPage(input: {
	title: string;
	headline: string;
	tiles: readonly ReviewTile[];
	/** What changed since the last capture; null when there is none to compare with. */
	changes: readonly string[] | null;
	sectionsHtml: string;
}): string {
	const tiles = input.tiles
		.map(
			(tile) =>
				`<div class="tile${tile.tone ? ` ${tile.tone}` : ""}"><b>${tile.value}</b><span>${escapeHtml(tile.label)}</span></div>`,
		)
		.join("");
	const changes =
		input.changes === null
			? `<p class="empty">No earlier capture to compare with yet.</p>`
			: input.changes.length
				? `<ul class="changes">${input.changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul>`
				: `<p class="empty">No changes since the last capture.</p>`;
	return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(input.title)}</title><style>${STYLE}</style></head><body><main><p class="label">Story review</p><h1>${escapeHtml(input.title)}</h1><p class="lede">${escapeHtml(input.headline)}</p><div class="tiles">${tiles}</div><section><p class="label">What changed</p><div class="panel">${changes}</div></section>${input.sectionsHtml}</main></body></html>`;
}
