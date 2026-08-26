/**
 * Story Sync — Media & Table Transforms
 *
 * Pure helpers for pre-processing Fabric-authored UserStory descriptions
 * before pushing them to a PM tool. The push pipeline lives in
 * `story-sync.ts`; this module is the I/O-free transform layer the activity
 * delegates to.
 *
 * Two classes of content are normalised here:
 *
 * 1. **Story-media images.** Fabric stores image references either as
 *    `<img src="..." data-s3-key="story-media/{project}/{story}/{uuid}.ext">`
 *    (Tiptap paste/upload) or as `![alt](story-media/...)` markdown (the
 *    `## Attachments` section the create-story dialog emits). Both shapes
 *    live in the `UserStory.description` markdown. PM tools cannot reach the
 *    Fabric S3 bucket, so we resolve every key to a long-lived (7-day)
 *    signed download URL and rewrite the description's `src` / markdown URL
 *    to that signed URL just-in-time on push.
 *
 * 2. **HTML tables.** Tiptap has no markdown serializer for tables, so the
 *    description contains raw `<table>` HTML embedded in markdown. Most
 *    PM-tool renderers either strip the unrecognised attributes (class /
 *    style / colspan / rowspan / `<colgroup>`) or escape the whole block to
 *    literal `&lt;table&gt;` text. We convert every embedded table to a
 *    GFM markdown table for tools that render markdown natively (Jira,
 *    ADO via `format: "Markdown"`, GitHub, GitLab, Linear, etc.). The Fizzy
 *    branch keeps its existing Lexxy `<figure class="lexxy-content__table-
 *    wrapper">` conversion (in `story-sync.ts`); this module only adds the
 *    image-in-cell extraction helper used by that converter.
 *
 * Reference: backlog bug "Tables and Images in Fabric Feature Content Are
 * Not Synced to PM Tools — Content Is Lost or Stripped During Push"
 * (DSU 2026-05-21 known limitation).
 */
import { config } from "@repo/config";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";

// =============================================================================
// Constants
// =============================================================================

/**
 * Story-media S3 keys live under this prefix. Mirrors the keyspace used by
 * `createMediaUploadUrlProcedure` (story-media/{projectId}/{storyId}/{uid}.ext).
 */
export const STORY_MEDIA_PREFIX = "story-media/";

/**
 * Long TTL for sync-time signed download URLs. AWS S3 caps presigned URLs at
 * 7 days (604_800 s) — we use the cap. Most PM tools cache attachment images
 * on render anyway, so a 7-day window comfortably covers tool-side caching
 * delays and any subsequent re-syncs within a week.
 */
export const STORY_MEDIA_SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

// =============================================================================
// Key extraction
// =============================================================================

/**
 * Pull a `story-media/...` key out of a single URL/src value. Recognises
 *  - bare key:               `story-media/p/s/uuid.png`
 *  - root-relative:          `/story-media/p/s/uuid.png`
 *  - signed URL on any host: `https://bucket.host/story-media/p/s/uuid.png?Sig=...`
 *
 * The capture stops at `?`, `#`, whitespace, `"`/`'`, or `)` so query
 * strings and trailing markdown / HTML delimiters are excluded. Returns
 * `null` if the URL does not reference a story-media key.
 */
export function extractStoryMediaKeyFromUrl(url: string): string | null {
	if (!url) {
		return null;
	}
	const cleaned = url.trim();
	const m = cleaned.match(/(?:^|\/)(story-media\/[^\s?"'#)]+)/);
	return m ? m[1] : null;
}

/**
 * Find every distinct `story-media/...` key referenced anywhere in a story
 * description. Matches three shapes — `data-s3-key="..."`, `src="..."`, and
 * `](...)` (markdown image / link target) — in a single regex pass so the
 * returned keys are in document order (first-seen wins), even when the same
 * key appears across multiple shapes.
 */
export function extractStoryMediaKeysFromContent(content: string): string[] {
	if (!content) {
		return [];
	}
	const keys = new Set<string>();

	// Single combined regex with three alternatives. The capture-group index
	// tells us which shape matched.
	const re =
		/\bdata-s3-key=["']([^"']+)["']|\bsrc=["']([^"']+)["']|\]\(([^)]+)\)/g;
	for (const m of content.matchAll(re)) {
		const dataKey = m[1];
		const srcVal = m[2];
		const mdUrl = m[3];
		if (dataKey?.startsWith(STORY_MEDIA_PREFIX)) {
			keys.add(dataKey);
		} else if (srcVal) {
			const key = extractStoryMediaKeyFromUrl(srcVal);
			if (key) {
				keys.add(key);
			}
		} else if (mdUrl) {
			const key = extractStoryMediaKeyFromUrl(mdUrl);
			if (key) {
				keys.add(key);
			}
		}
	}

	return Array.from(keys);
}

// =============================================================================
// Signed URL resolution (async — calls @repo/storage)
// =============================================================================

/**
 * Resolve a list of `story-media/...` S3 keys to short-lived signed download
 * URLs suitable for embedding in a PM-tool ticket body. Errors per key are
 * logged and skipped (the caller surfaces unresolved keys as a graceful-
 * fallback notice) — a single bad key never breaks the whole push.
 */
export async function resolveStoryMediaSignedUrls(
	s3Keys: readonly string[],
): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	if (s3Keys.length === 0) {
		return map;
	}

	const provider = getStorageProvider();
	const bucket = config.storage.bucketNames.projectContexts;

	await Promise.all(
		s3Keys.map(async (key) => {
			try {
				const url = await provider.getSignedUrl(key, {
					bucket,
					expiresIn: STORY_MEDIA_SIGNED_URL_TTL_SECONDS,
				});
				if (url) {
					map.set(key, url);
				}
			} catch (err) {
				logger.warn(
					"[Story Sync] Failed to resolve story-media signed URL",
					{
						key,
						error: err instanceof Error ? err.message : String(err),
					},
				);
			}
		}),
	);

	return map;
}

// =============================================================================
// Source rewriting
// =============================================================================

export interface RewriteResult {
	content: string;
	/** Story-media keys that appeared in the input but had no entry in the
	 *  url map (resolution failed or the key was unknown). The caller can
	 *  surface these to the user via a fallback notice (AC4). */
	unresolvedKeys: string[];
}

/**
 * Rewrite every story-media reference in `content` to point at the matching
 * signed URL from `urlMap`. Three shapes are recognised, mirroring
 * `extractStoryMediaKeysFromContent`:
 *
 *  - `<img ... src="<story-media-url>" ...>`
 *  - `<img ... data-s3-key="story-media/..." ...>` — only the `src` attr is
 *    rewritten; the `data-s3-key` attribute is preserved verbatim so a later
 *    round-trip can still identify the canonical key.
 *  - `![alt](<story-media-url>)` markdown image
 *
 * If a key has no entry in `urlMap`, the reference is left untouched and the
 * key is reported in `unresolvedKeys`.
 */
export function rewriteStoryMediaSourcesToSignedUrls(
	content: string,
	urlMap: Map<string, string>,
): RewriteResult {
	if (!content) {
		return { content, unresolvedKeys: [] };
	}

	const unresolved = new Set<string>();
	const seen = new Set<string>();

	// 1) <img src="...story-media/...">  →  rewrite src to the signed URL.
	//    Also handles the data-s3-key-only case: when an <img> has data-s3-key
	//    but its src is empty/stale/relative, we still rewrite src.
	let result = content.replace(/<img\b[^>]*>/gi, (tag) => {
		const dataKeyMatch = tag.match(/\bdata-s3-key=["']([^"']+)["']/i);
		const srcMatch = tag.match(/\bsrc=(["'])([^"']*)\1/i);
		const dataKey = dataKeyMatch?.[1] ?? null;
		const srcKey = srcMatch
			? extractStoryMediaKeyFromUrl(srcMatch[2])
			: null;
		const key = dataKey?.startsWith(STORY_MEDIA_PREFIX)
			? dataKey
			: (srcKey ?? null);
		if (!key) {
			return tag;
		}
		seen.add(key);
		const signed = urlMap.get(key);
		if (!signed) {
			unresolved.add(key);
			return tag;
		}
		const safeSrc = signed.replace(/"/g, "&quot;");
		if (srcMatch) {
			return tag.replace(/\bsrc=(["'])([^"']*)\1/i, `src="${safeSrc}"`);
		}
		return tag.replace(/<img\b/i, `<img src="${safeSrc}"`);
	});

	// 2) Markdown images: ![alt](url)  →  rewrite url to the signed URL.
	//    Conservative regex: stops at the first `)` to avoid swallowing
	//    surrounding markdown. URLs containing literal `)` are not in our
	//    keyspace (S3 keys are restricted to URL-safe characters).
	result = result.replace(
		/!\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?\))/g,
		(_match, alt: string, url: string, tail: string) => {
			const key = extractStoryMediaKeyFromUrl(url);
			if (!key) {
				return _match;
			}
			seen.add(key);
			const signed = urlMap.get(key);
			if (!signed) {
				unresolved.add(key);
				return _match;
			}
			return `![${alt}](${signed}${tail}`;
		},
	);

	// 3) <a data-s3-key="story-media/…" href="…">  →  rewrite href to the
	//    signed URL. These are non-image file attachments pulled from a PM
	//    tool (the ingester emits `<a … data-s3-key download>`); mirrors the
	//    <img> branch so the link points at a fresh download URL on push.
	result = result.replace(/<a\b[^>]*>/gi, (tag) => {
		const dataKeyMatch = tag.match(/\bdata-s3-key=["']([^"']+)["']/i);
		const dataKey = dataKeyMatch?.[1] ?? null;
		const hrefMatch = tag.match(/\bhref=(["'])([^"']*)\1/i);
		const hrefKey = hrefMatch
			? extractStoryMediaKeyFromUrl(hrefMatch[2])
			: null;
		const key = dataKey?.startsWith(STORY_MEDIA_PREFIX)
			? dataKey
			: (hrefKey ?? null);
		if (!key) {
			return tag;
		}
		seen.add(key);
		const signed = urlMap.get(key);
		if (!signed) {
			unresolved.add(key);
			return tag;
		}
		const safeHref = signed.replace(/"/g, "&quot;");
		if (hrefMatch) {
			return tag.replace(
				/\bhref=(["'])([^"']*)\1/i,
				`href="${safeHref}"`,
			);
		}
		return tag.replace(/<a\b/i, `<a href="${safeHref}"`);
	});

	return { content: result, unresolvedKeys: Array.from(unresolved) };
}

// =============================================================================
// Image extraction (used by Fizzy/Lexxy table-cell sanitization)
// =============================================================================

export interface ImageRef {
	src: string;
	alt: string;
	s3Key: string | null;
}

/**
 * Parse a single `<img …>` tag into a typed `ImageRef`. Best-effort attribute
 * extraction — empty alt is normalised to "" and missing data-s3-key to
 * `null` (we fall back to `extractStoryMediaKeyFromUrl(src)` when the data
 * attribute is absent).
 */
export function parseImgTag(tag: string): ImageRef {
	const src = tag.match(/\bsrc=["']([^"']*)["']/i)?.[1] ?? "";
	const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] ?? "";
	const dataKey = tag.match(/\bdata-s3-key=["']([^"']+)["']/i)?.[1] ?? null;
	const s3Key = dataKey?.startsWith(STORY_MEDIA_PREFIX)
		? dataKey
		: extractStoryMediaKeyFromUrl(src);
	return { src, alt, s3Key };
}

/**
 * Pull every `<img>` tag out of an HTML fragment. Returns the fragment with
 * the tags removed plus the list of extracted references in document order.
 *
 * Used by the Fizzy/Lexxy table-cell sanitizer to lift images out of
 * `<td>`/`<th>` cells before the strict cell whitelist runs — Lexxy's
 * sanitizer otherwise drops `<img>` silently, leaving cells empty (the
 * original bug for image-bearing tables).
 */
export function extractImagesFromHtml(html: string): {
	html: string;
	images: ImageRef[];
} {
	const images: ImageRef[] = [];
	const stripped = html.replace(/<img\b[^>]*?\/?>/gi, (tag) => {
		images.push(parseImgTag(tag));
		return "";
	});
	return { html: stripped, images };
}

// =============================================================================
// Image rendering
// =============================================================================

/**
 * Render an extracted image as a Lexxy attachment figure. The wrapper class
 * mirrors the table-wrapper shape — Lexxy's sanitizer is class-permissive on
 * `<figure>` wrappers and the bare `<img>` inside is a safe fallback if the
 * class ever gets stripped.
 */
export function imageToLexxyFigure(image: ImageRef): string {
	if (!image.src) {
		return "";
	}
	const safeSrc = image.src.replace(/"/g, "&quot;");
	const safeAlt = image.alt.replace(/"/g, "&quot;");
	const altAttr = safeAlt ? ` alt="${safeAlt}"` : "";
	return `<figure class="lexxy-content__attachment-wrapper"><img src="${safeSrc}"${altAttr}></figure>`;
}

/**
 * Render an extracted image as inline markdown — `![alt](src)`. Used by the
 * markdown-table renderer to keep in-cell images discoverable inside GFM
 * tables (GitHub / GitLab / Jira / Linear renderers all handle markdown
 * images inside cells).
 */
export function imageToMarkdown(image: ImageRef): string {
	if (!image.src) {
		return "";
	}
	// Strip square brackets from alt — they would break the `[…]` boundary.
	const safeAlt = image.alt.replace(/[[\]]/g, "");
	return `![${safeAlt}](${image.src})`;
}

/**
 * Convert every standalone `<img>` tag in a body to a markdown image
 * `![alt](src)`. Used for markdown-native PM tools (GitHub, GitLab, Linear,
 * ClickUp, Trello): a raw `<img>` is not reliably rendered by their markdown
 * pipelines, but a markdown image is. In-cell table images are already
 * converted to markdown by `convertEmbeddedHtmlTablesToMarkdown`; this handles
 * the standalone references between paragraphs. An `<img>` with no resolvable
 * `src` is dropped (matches `imageToMarkdown`).
 */
export function replaceHtmlImagesWithMarkdown(content: string): string {
	return content.replace(/<img\b[^>]*?\/?>/gi, (tag) =>
		imageToMarkdown(parseImgTag(tag)),
	);
}

// =============================================================================
// HTML table → GFM markdown table conversion
// =============================================================================

/**
 * Convert a single `<table>…</table>` HTML block to a GFM markdown table.
 *
 * Best-effort inline conversion for cell contents:
 *  - `<p>` wrappers stripped (treated as inline within a cell)
 *  - `<br>` → literal `<br>` (GFM cells must be one line; the literal tag
 *    is supported by every major renderer — GitHub, GitLab, Jira, Linear,
 *    ADO)
 *  - `<strong>` / `<b>` → `**…**`
 *  - `<em>` / `<i>` → `*…*`
 *  - `<s>` / `<del>` / `<strike>` → `~~…~~`
 *  - `<code>` → `` `…` ``
 *  - `<a href>` → `[…](href)`
 *  - `<img src alt>` → `![alt](src)`
 *  - all other tags → stripped (text preserved)
 *  - `|` inside cell text → escaped as `\|`
 *  - HTML entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`, `&nbsp;`)
 *    decoded to characters
 *  - internal whitespace collapsed to a single space
 *
 * When the table has no `<th>` row, an empty header row is synthesised so
 * the output still parses as a GFM table.
 *
 * A table with zero rows returns the empty string (the caller drops it).
 */
export function htmlTableToMarkdownTable(
	tableHtml: string,
	cellOptions: CellConversionOptions = {},
): string {
	const rows: { cells: string[]; isHeader: boolean }[] = [];
	const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
	let rowMatch: RegExpExecArray | null = rowRe.exec(tableHtml);
	while (rowMatch !== null) {
		const cellsHtml = rowMatch[1];
		const cells: string[] = [];
		let isHeader = false;
		const cellRe = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi;
		let cellMatch: RegExpExecArray | null = cellRe.exec(cellsHtml);
		while (cellMatch !== null) {
			if (cellMatch[1].toLowerCase() === "th") {
				isHeader = true;
			}
			cells.push(htmlCellToMarkdown(cellMatch[2], cellOptions));
			cellMatch = cellRe.exec(cellsHtml);
		}
		if (cells.length > 0) {
			rows.push({ cells, isHeader });
		}
		rowMatch = rowRe.exec(tableHtml);
	}

	if (rows.length === 0) {
		return "";
	}

	// All rows padded to the widest row's cell count so the output stays
	// rectangular (GFM tolerates ragged rows but renderers vary; pad for
	// safety).
	const colCount = Math.max(...rows.map((r) => r.cells.length));
	for (const row of rows) {
		while (row.cells.length < colCount) {
			row.cells.push("");
		}
	}

	let headerCells: string[];
	let bodyRows: string[][];
	if (rows[0].isHeader) {
		headerCells = rows[0].cells;
		bodyRows = rows.slice(1).map((r) => r.cells);
	} else {
		// Synthesise an empty header row so GFM still parses the table.
		headerCells = new Array(colCount).fill("");
		bodyRows = rows.map((r) => r.cells);
	}

	const separator = new Array(colCount).fill("---");

	const renderRow = (cells: string[]) =>
		`| ${cells.map((c) => (c.length === 0 ? " " : c)).join(" | ")} |`;

	const lines = [
		renderRow(headerCells),
		renderRow(separator),
		...bodyRows.map(renderRow),
	];

	return lines.join("\n");
}

/**
 * Options passed through `convertEmbeddedHtmlTablesToMarkdown` to
 * `htmlCellToMarkdown`. The only knob today is the in-cell line-break
 * shape — most GFM renderers accept `<br>` inline inside a table cell
 * (GitHub, GitLab, Linear, ADO `format: "Markdown"`), but Atlassian's
 * Rovo MCP converts markdown to ADF and ADF's table-cell content model
 * doesn't include inline `<br>`, so the tag escapes to literal `<br>`
 * text instead of producing a break. For Jira targets the caller passes
 * `inCellLineBreakSeparator: " / "` (or another visible separator) and
 * we substitute that for `<br>` during conversion so cells stay
 * readable.
 */
export interface CellConversionOptions {
	/**
	 * Replacement for in-cell line breaks. Defaults to `<br>` which is the
	 * GFM-canonical inline-break tag. Pass ` / ` (or another inline
	 * separator) for renderers that don't honour `<br>` in table cells
	 * (notably Jira via Rovo).
	 */
	inCellLineBreakSeparator?: string;
}

function htmlCellToMarkdown(
	cellHtml: string,
	options: CellConversionOptions = {},
): string {
	const inCellLineBreakSeparator = options.inCellLineBreakSeparator ?? "<br>";
	let s = cellHtml;

	// 1) Strip `<p>` wrappers (cell-level paragraphs become inline content).
	s = s.replace(/<p[^>]*>/gi, "").replace(/<\/p>/gi, " ");

	// 2) Lists become inline bullet sequences. `<ul>` / `<ol>` wrappers are
	//    dropped; each `<li>` is replaced with `<br>• ` (the `<br>` is the
	//    in-cell line-break token — substituted at the end via
	//    `inCellLineBreakSeparator` for renderers that don't honour `<br>`
	//    such as Atlassian Jira via Rovo). The leading `<br>` is trimmed at
	//    the end so a list-only cell doesn't begin with an empty line.
	s = s
		.replace(/<\/?(ul|ol)[^>]*>/gi, "")
		.replace(/<li\b[^>]*>/gi, "<br>• ")
		.replace(/<\/li>/gi, "");

	// 3) `<br>` canonicalised. Renderers (GitHub, GitLab, Linear, ADO
	//    `format: "Markdown"`) all accept `<br>` as an inline line break
	//    inside a GFM table cell. Step 7's tag-strip explicitly allowlists
	//    `<br>` so it survives. For Jira via Rovo, step 11 substitutes the
	//    `<br>` token for whatever `inCellLineBreakSeparator` was passed.
	s = s.replace(/<br\s*\/?>/gi, "<br>");

	// 4) Inline formatting (order matters: bold before italic before code).
	s = s.replace(
		/<(strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi,
		(_m, _t, inner: string) => `**${inner}**`,
	);
	s = s.replace(
		/<(em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi,
		(_m, _t, inner: string) => `*${inner}*`,
	);
	s = s.replace(
		/<(s|del|strike)\b[^>]*>([\s\S]*?)<\/(?:s|del|strike)>/gi,
		(_m, _t, inner: string) => `~~${inner}~~`,
	);
	s = s.replace(
		/<code\b[^>]*>([\s\S]*?)<\/code>/gi,
		(_m, inner: string) => `\`${inner}\``,
	);

	// 5) Anchors → markdown link.
	s = s.replace(
		/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
		(_m, href: string, inner: string) => {
			const safeInner = inner.replace(/\]/g, "\\]");
			return `[${safeInner}](${href})`;
		},
	);

	// 6) Images → markdown image (drop the tag if src is missing).
	s = s.replace(/<img\b[^>]*?\/?>/gi, (tag) => {
		const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1] ?? "";
		const alt =
			tag.match(/\balt=["']([^"']*)["']/i)?.[1].replace(/[[\]]/g, "") ??
			"";
		return src ? `![${alt}](${src})` : "";
	});

	// 7) Strip any remaining tags but preserve text content. `<br>` is
	//    explicitly allowlisted via the negative lookahead — every GFM
	//    renderer accepts it inline inside a table cell, and the previous
	//    behaviour of stripping it caused list items and `<br>`-separated
	//    lines to collapse into one mashed-together word.
	s = s.replace(/<(?!br\s*\/?>)[^>]+>/gi, "");

	// 8) Decode the same safe entity set used by `simpleHtmlToMarkdown` /
	//    `stripHtml`. `&lt;` / `&gt;` are intentionally re-emitted as `<`/`>`
	//    here because cell text is plain text from this point on — not HTML.
	s = s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ");

	// 9) Escape pipe characters that would otherwise break GFM table syntax.
	s = s.replace(/\|/g, "\\|");

	// 10) Collapse all internal whitespace (incl. surviving newlines) to a
	//     single space — GFM cells must be one line. `<br>` has no
	//     whitespace inside, so it survives.
	s = s.replace(/\s+/g, " ").trim();

	// 11) Trim leading `<br>` runs (a list-only cell would otherwise begin
	//     with a line break) and any trailing `<br>` runs the conversion
	//     might have left behind. Then substitute the in-cell line-break
	//     token for the caller-supplied separator (no-op when it's
	//     already `<br>`).
	s = s
		.replace(/^(?:<br>\s*)+/i, "")
		.replace(/(?:\s*<br>)+$/i, "")
		.trim();
	if (inCellLineBreakSeparator !== "<br>") {
		s = s.replace(/<br>/g, inCellLineBreakSeparator);
	}

	return s;
}

/**
 * Convert GFM markdown tables (a `| a | b |` header row, a `| --- | --- |`
 * separator row, then data rows) to `<table>` HTML.
 *
 * Fabric stores a table either as Tiptap `<table>` HTML OR as a GFM markdown
 * table (when the user types one directly in the editor). The HTML-based push
 * converters (`convertEmbeddedHtmlTablesToCleanHtml` for ADO, `extractFizzyTables`
 * for Fizzy) only match `<table>` HTML — so a GFM markdown table slips through
 * and ships as literal `|`/`---` text on ADO/Fizzy (which render HTML, not GFM).
 * Normalising GFM → `<table>` up front lets those converters round-trip it.
 * Existing `<table>` HTML and all non-table content are left untouched.
 */
export function convertMarkdownTablesToHtml(content: string): string {
	if (!content || !content.includes("|")) {
		return content;
	}
	const lines = content.split("\n");
	const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
	const isSeparator = (l: string) =>
		/^\s*\|(?:\s*:?-{1,}:?\s*\|)+\s*$/.test(l);
	const splitCells = (l: string) =>
		l
			.trim()
			.replace(/^\||\|$/g, "")
			.split("|")
			.map((c) => c.trim());
	const esc = (s: string) =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		// A GFM table = a header row immediately followed by a separator row,
		// then zero or more data rows.
		if (
			isRow(lines[i]) &&
			i + 1 < lines.length &&
			isSeparator(lines[i + 1])
		) {
			const header = splitCells(lines[i]);
			i += 2;
			const rows: string[][] = [];
			while (
				i < lines.length &&
				isRow(lines[i]) &&
				!isSeparator(lines[i])
			) {
				rows.push(splitCells(lines[i]));
				i++;
			}
			const thead = `<thead><tr>${header
				.map((c) => `<th>${esc(c)}</th>`)
				.join("")}</tr></thead>`;
			const tbody = `<tbody>${rows
				.map(
					(r) =>
						`<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`,
				)
				.join("")}</tbody>`;
			out.push(`<table>${thead}${tbody}</table>`);
		} else {
			out.push(lines[i]);
			i++;
		}
	}
	return out.join("\n");
}

/**
 * Convert every embedded `<table>…</table>` block in a markdown-with-HTML
 * description to a GFM markdown table. Non-table content is left untouched
 * byte-for-byte. Each converted table is wrapped in blank lines so it lands
 * as its own block in the surrounding markdown.
 */
export function convertEmbeddedHtmlTablesToMarkdown(
	content: string,
	cellOptions: CellConversionOptions = {},
): string {
	if (!content) {
		return content;
	}
	return content.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (tableHtml) => {
		const md = htmlTableToMarkdownTable(tableHtml, cellOptions);
		return md.length > 0 ? `\n\n${md}\n\n` : "";
	});
}

// =============================================================================
// HTML table cleanup (for tools that render HTML natively but reject Tiptap-
// specific attributes — primarily Azure DevOps)
// =============================================================================

/**
 * Strip Tiptap-specific noise from a single `<table>…</table>` HTML block,
 * keeping the underlying table structure intact. Used by the ADO push path
 * (`System.Description`).
 *
 * Why ADO needs this (and not GFM markdown like Jira / GitHub / GitLab /
 * Linear): the ADO MCP server's `wit_update_work_item` tool accepts a JSON
 * Patch whose `value` is sent verbatim to the REST API — there is no
 * `format` field on the patch entry (unlike `wit_create_work_item`, which
 * does accept `format: "Markdown"`). ADO renders `System.Description` as
 * HTML by default, so sending GFM markdown there shows literal `|` / `---`
 * text. Sending cleaned HTML works on both the create and update paths.
 *
 * Transformations:
 *  - `<colgroup>…</colgroup>` blocks dropped (Tiptap-only structural noise)
 *  - `class="…"` attributes dropped from every tag
 *  - `style="…"` attributes dropped from every tag
 *  - default `colspan="1"` / `rowspan="1"` dropped (kept when N > 1)
 *  - `<p>` wrappers inside `<th>` / `<td>` collapsed so cell content stays
 *    inline (ADO's renderer sometimes treats `<p>` inside a cell as a block
 *    break, leaving the cell visually empty)
 *
 * Returns the cleaned table HTML. Tables with no `<tr>` rows are dropped to
 * the empty string so an empty `<table>` doesn't ship.
 */
export function cleanTiptapTableHtml(tableHtml: string): string {
	let s = tableHtml;

	// Drop <colgroup>…</colgroup> (Tiptap emits this; ADO ignores it but
	// stripping reduces parse surface).
	s = s.replace(/<colgroup\b[^>]*>[\s\S]*?<\/colgroup>/gi, "");

	// Drop class / style attributes everywhere they appear inside the table.
	s = s.replace(/\s+class=["'][^"']*["']/gi, "");
	s = s.replace(/\s+style=["'][^"']*["']/gi, "");

	// Drop default colspan="1" / rowspan="1". Keep when N > 1 — those carry
	// real merged-cell information ADO knows how to render.
	s = s.replace(/\s+colspan=["']1["']/gi, "");
	s = s.replace(/\s+rowspan=["']1["']/gi, "");

	// Drop `<p>` wrappers inside `<th>` / `<td>` so the cell content lands
	// directly inside the cell. ADO's renderer interprets `<p>` as a block
	// element and inside a cell that introduces vertical padding the user
	// didn't ask for. Multiple paragraphs in the same cell collapse to one
	// inline line (joined with a single space).
	s = s.replace(
		/(<t[hd]\b[^>]*>)([\s\S]*?)(<\/t[hd]>)/gi,
		(_m, open: string, inner: string, close: string) => {
			const collapsed = inner
				.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, "$1 ")
				.replace(/\s+/g, " ")
				.trim();
			return `${open}${collapsed}${close}`;
		},
	);

	// Reject tables with no rows.
	if (!/<tr\b/i.test(s)) {
		return "";
	}

	return s;
}

/**
 * Convert every embedded `<table>…</table>` block in a description to clean
 * HTML (Tiptap noise stripped). Non-table content is left untouched
 * byte-for-byte. The result is ready to ship as ADO `System.Description`.
 */
export function convertEmbeddedHtmlTablesToCleanHtml(content: string): string {
	if (!content) {
		return content;
	}
	// Normalise GFM markdown tables → <table> first. Fabric may store a typed
	// markdown table, and ADO renders System.Description as HTML — so a raw GFM
	// table would otherwise ship as literal `|`/`---` text.
	const normalized = convertMarkdownTablesToHtml(content);
	return normalized.replace(
		/<table\b[^>]*>[\s\S]*?<\/table>/gi,
		(tableHtml) => {
			const cleaned = cleanTiptapTableHtml(tableHtml);
			return cleaned;
		},
	);
}

/**
 * Detect whether a description was authored in Fabric (vs. pulled verbatim
 * from a PM tool). Used by the non-Fizzy push path to gate HTML→GFM table
 * conversion — pulled descriptions should round-trip byte-for-byte so
 * subsequent push→pull cycles do not flip-flop the stored format.
 *
 * Fabric authoring markers (any one is sufficient):
 *  - Tiptap table class (`class="tiptap-table"`)
 *  - `<colgroup>` block (Tiptap always emits one; PM-tool tables rarely do)
 *  - Tiptap default cell attrs (`colspan="N" rowspan="N"`)
 *  - story-media reference in any shape (data-s3-key, src, markdown image)
 *  - Fabric-authored *markdown* shape: ATX headings, bullet/ordered lists,
 *    bold emphasis, blockquotes, or fenced code blocks.
 *
 * Regression #1471: a plain-markdown story (AI-generated feature stub, or any
 * text ticket with no table / uploaded image) matched none of the structural
 * markers, fell through to the verbatim push path, and shipped raw
 * `##`/`**`/`- ` into ADO's HTML `System.Description` (literal text). The
 * markdown checks below close that gap. They are anchored to line start (and
 * bold requires a matched `**…**` pair) so pulled PM-tool HTML — which uses
 * `<p>`/`<ul>`/`<strong>`, never line-leading markdown — still returns false
 * and round-trips byte-for-byte.
 */
export function looksFabricAuthored(content: string): boolean {
	if (!content) {
		return false;
	}
	return (
		/class=["'][^"']*\btiptap-table\b/i.test(content) ||
		/<colgroup\b/i.test(content) ||
		/\bcolspan=["']\d+["']\s+rowspan=["']\d+["']/i.test(content) ||
		/\bdata-s3-key=["']story-media\//i.test(content) ||
		/!\[[^\]]*\]\(\s*(?:[^)\s]+\/)?story-media\//i.test(content) ||
		/<img\b[^>]*\bsrc=["'][^"']*\/?story-media\//i.test(content) ||
		hasMarkdownMarkers(content)
	);
}

/**
 * Detect Fabric-authored *markdown* shape — ATX headings, bullet/ordered lists,
 * matched bold, blockquotes, or fenced code. A strict subset of
 * `looksFabricAuthored` that deliberately EXCLUDES the structural/media markers
 * (tables, story-media). Used by the ADO push to decide whether to run
 * `markdownToSimpleHtml`:
 *
 *   - A body pulled from ADO is already HTML (`<div>`/`<p>` per line). It can
 *     still trip `looksFabricAuthored` once we ingest its inline images
 *     (data-s3-key="story-media/…"), but it has NO markdown markers — so
 *     running `markdownToSimpleHtml` on it would `escapeHtml` the `<div>` tags
 *     into literal `&lt;div&gt;` text (ADO WI #225 "breaks structure").
 *   - A genuinely Fabric-authored body has `## `/`- `/`**…**` etc. and MUST be
 *     converted so ADO doesn't render the raw markdown markers as text.
 *
 * Anchored to line start (bold requires a matched `**…**` pair) so pulled
 * PM-tool HTML — which uses `<p>`/`<ul>`/`<strong>`, never line-leading
 * markdown — returns false and is preserved byte-for-byte.
 */
export function hasMarkdownMarkers(content: string): boolean {
	if (!content) {
		return false;
	}
	return (
		/^#{1,6}\s+\S/m.test(content) ||
		/^[-*+]\s+\S/m.test(content) ||
		/^\d+\.\s+\S/m.test(content) ||
		/\*\*[^*\n]+\*\*/.test(content) ||
		/^>\s+\S/m.test(content) ||
		/```/.test(content)
	);
}

/**
 * Detect whether a body is HTML (vs markdown) — used by the ADO push to decide
 * preserve-vs-convert. By the time this runs, tables + images are already
 * extracted to sentinel tokens, so the only residual block/inline tags are
 * ADO's per-line `<div>`/`<br>` wrappers and the HTML "View in Fabric" anchor.
 *
 *   - pulled-from-ADO body (`<div>…</div><br>`, `<p><a>…</a></p>`) → true →
 *     PRESERVE (running markdownToSimpleHtml would escape `<div>` to literal
 *     `&lt;div&gt;` text — WI #225).
 *   - Fabric markdown, INCLUDING a Fabric-EDITED-from-pull body (Tiptap →
 *     Turndown turns the `<div>`s into plain text and the media into
 *     `![](…)` / `[](…)` markdown, with no residual tags) → false → CONVERT to
 *     HTML, else the raw `![](…)` / `[](…)` ships as literal text into ADO's
 *     `System.Description` (WI #228).
 *
 * `table`/`img` are intentionally NOT in the tag list (already tokenised, and
 * AI bug templates embed `` `<table>` `` / `` `<img>` `` inline-code samples we
 * must not treat as real HTML).
 */
export function looksLikeHtmlBody(content: string): boolean {
	return /<(?:div|p|br|hr|ul|ol|li|h[1-6]|blockquote|a|strong|em)\b[^>]*>/i.test(
		content,
	);
}

// =============================================================================
// Fizzy / HTML pipeline — image extraction & restoration
// =============================================================================
//
// Mirrors the table extract/restore pair: pre-pass swaps every `<img>` HTML
// tag and every `![alt](url)` markdown image for a sentinel token, lets
// `markdownToSimpleHtml` run on the token-padded text (the sentinel survives
// `escapeHtml` unchanged), then post-pass substitutes the wrapping
// `<p>token</p>` with a Lexxy attachment figure.
// =============================================================================

const FIZZY_IMG_TOKEN_RE = /__FIZZY_IMG_(\d+)__/g;
function fizzyImgToken(index: number): string {
	return `__FIZZY_IMG_${index}__`;
}

/**
 * Pre-pass for the Fizzy push pipeline: extract every `<img>` HTML tag and
 * every `![alt](url)` markdown image and replace them with a sentinel token
 * padded by blank lines (so `markdownToSimpleHtml` wraps the token as its
 * own block). Returns the substituted text and the captured image list in
 * document order.
 *
 * The caller must run this AFTER `extractFizzyTables` so images inside
 * table cells (which travel inside the captured table blocks) are not
 * double-extracted. Image-in-cell handling is done inside
 * `tiptapTableToLexxy` itself.
 */
export function extractFizzyImages(input: string): {
	withTokens: string;
	images: ImageRef[];
} {
	const images: ImageRef[] = [];

	// 1) HTML <img> tags first — handle data-s3-key + src as a single unit.
	//    Negative-lookbehind for `` ` `` skips inline-code references like
	//    `` `<img src=...>` `` in surrounding prose.
	let withTokens = input.replace(/(?<!`)<img\b[^>]*?\/?>/gi, (tag) => {
		images.push(parseImgTag(tag));
		return `\n\n${fizzyImgToken(images.length - 1)}\n\n`;
	});

	// 2) Markdown ![alt](url) images. Conservative URL parse: stop at
	//    whitespace, `)`, `"`. Title syntax `![alt](url "title")` is
	//    preserved by ignoring the title (we only need src + alt). The
	//    leading `(?<!`)` skips backtick-wrapped syntax references like
	//    `` `![alt](url)` `` in surrounding prose.
	withTokens = withTokens.replace(
		/(?<!`)!\[([^\]]*)\]\(([^)\s"]+)(?:\s+"[^"]*")?\)/g,
		(_m, alt: string, src: string) => {
			images.push({
				src,
				alt,
				s3Key: extractStoryMediaKeyFromUrl(src),
			});
			return `\n\n${fizzyImgToken(images.length - 1)}\n\n`;
		},
	);

	return { withTokens, images };
}

/**
 * Post-pass for the Fizzy push pipeline: substitute every `<p>token</p>`
 * (added around the sentinel by `markdownToSimpleHtml`) with the matching
 * Lexxy attachment figure. Also handles a bare sentinel defensively in case
 * the converter ever skips the `<p>` wrap.
 */
export function restoreFizzyImages(
	html: string,
	images: readonly ImageRef[],
): string {
	if (images.length === 0) {
		return html;
	}
	return html
		.replace(
			new RegExp(`<p>${FIZZY_IMG_TOKEN_RE.source}</p>`, "g"),
			(_m, idx) => imageToLexxyFigure(images[Number(idx)]),
		)
		.replace(FIZZY_IMG_TOKEN_RE, (_m, idx) =>
			imageToLexxyFigure(images[Number(idx)]),
		);
}

// =============================================================================
// ADO HTML pipeline — table & image extraction + restoration
// =============================================================================
//
// ADO's `System.Description` is rendered as HTML. When we push a Fabric-
// authored description that mixes markdown text (`## Heading`, `- bullet`,
// `**bold**`) with an embedded `<table>` block, sending the body verbatim
// makes ADO render the markdown as raw text (showing `## ` / `**` literally).
//
// The fix mirrors the Fizzy pipeline:
//   1. Pre-pass extracts every `<table>` block (cleaned via
//      `cleanTiptapTableHtml`) and every `<img>` / `![alt](url)` image, and
//      replaces each with a sentinel token padded by blank lines.
//   2. Caller runs `markdownToSimpleHtml` on the tokenised text — every
//      `## H2` / `- bullet` / `**bold**` becomes proper HTML.
//   3. Post-pass swaps the wrapping `<p>token</p>` back to the cleaned
//      `<table>` HTML or to a plain inline `<img>` tag (NOT a Lexxy figure
//      — ADO doesn't know the Lexxy class).
//
// The sentinels intentionally use the same token shape as the Fizzy pipeline
// (no `<`, `>`, or `&`) so they survive `markdownToSimpleHtml`'s `escapeHtml`
// pass unchanged.
// =============================================================================

const ADO_TABLE_TOKEN_RE = /__ADO_TABLE_(\d+)__/g;
function adoTableToken(index: number): string {
	return `__ADO_TABLE_${index}__`;
}

const ADO_IMG_TOKEN_RE = /__ADO_IMG_(\d+)__/g;
function adoImgToken(index: number): string {
	return `__ADO_IMG_${index}__`;
}

/**
 * Pre-pass for the ADO push pipeline: extract each `<table>…</table>` block,
 * strip Tiptap-specific noise via `cleanTiptapTableHtml`, replace each block
 * with a sentinel token padded by blank lines so `markdownToSimpleHtml`
 * treats it as its own block.
 *
 * The regex requires the `<table>` opening tag to be followed by typical
 * HTML table scaffolding (`<colgroup>`, `<thead>`, `<tbody>`, or `<tr>`),
 * which prevents false matches against inline code references like
 * `` `<table>` `` in surrounding prose (the AI bug template emits such
 * references in its triage / hypothesis sections).
 *
 * Empty tables (zero `<tr>` rows after cleanup) are dropped entirely.
 */
export function extractAdoTables(input: string): {
	withTokens: string;
	tables: string[];
} {
	const tables: string[] = [];
	// Normalise GFM markdown tables → <table> first: Fabric may store a typed
	// markdown table, and ADO renders System.Description as HTML — so a raw GFM
	// table would otherwise ship as literal `|`/`---` text (ADO WI #235).
	const normalized = convertMarkdownTablesToHtml(input);
	const withTokens = normalized.replace(
		/<table\b[^>]*>\s*(?=<(?:colgroup|thead|tbody|tr)\b)[\s\S]*?<\/table>/gi,
		(match) => {
			const cleaned = cleanTiptapTableHtml(match);
			if (cleaned.length === 0) {
				return "";
			}
			tables.push(cleaned);
			return `\n\n${adoTableToken(tables.length - 1)}\n\n`;
		},
	);
	return { withTokens, tables };
}

/**
 * Post-pass for the ADO push pipeline: substitute every `<p>token</p>` (the
 * wrapping `markdownToSimpleHtml` adds around the sentinel) with the
 * cleaned `<table>` HTML. Also handles a bare sentinel defensively.
 */
export function restoreAdoTables(
	html: string,
	tables: readonly string[],
): string {
	if (tables.length === 0) {
		return html;
	}
	return html
		.replace(
			new RegExp(`<p>${ADO_TABLE_TOKEN_RE.source}</p>`, "g"),
			(_m, idx) => tables[Number(idx)] ?? "",
		)
		.replace(ADO_TABLE_TOKEN_RE, (_m, idx) => tables[Number(idx)] ?? "");
}

/**
 * Pre-pass for the ADO push pipeline (image variant): extract every `<img>`
 * HTML tag and every `![alt](url)` markdown image, replace with a sentinel
 * token padded by blank lines. Must run AFTER `extractAdoTables` so images
 * inside table cells (which travel inside the captured table HTML) are not
 * double-extracted.
 *
 * Negative-lookbehind for `` ` `` prevents false matches against inline-code
 * references like `` `<img src=...>` `` and `` `![alt](url)` `` in
 * surrounding prose (the AI bug template's acceptance criteria sometimes
 * quote the literal syntax to show the user what shape to use). Those
 * stay as backtick-wrapped text and get escaped to HTML entities by
 * `markdownToSimpleHtml`'s `escapeHtml` pass.
 */
export function extractAdoImages(input: string): {
	withTokens: string;
	images: ImageRef[];
} {
	const images: ImageRef[] = [];
	let withTokens = input.replace(/(?<!`)<img\b[^>]*?\/?>/gi, (tag) => {
		images.push(parseImgTag(tag));
		return `\n\n${adoImgToken(images.length - 1)}\n\n`;
	});
	withTokens = withTokens.replace(
		/(?<!`)!\[([^\]]*)\]\(([^)\s"]+)(?:\s+"[^"]*")?\)/g,
		(_m, alt: string, src: string) => {
			images.push({
				src,
				alt,
				s3Key: extractStoryMediaKeyFromUrl(src),
			});
			return `\n\n${adoImgToken(images.length - 1)}\n\n`;
		},
	);
	return { withTokens, images };
}

/**
 * Render an extracted image as a plain HTML `<img>` tag. ADO's renderer
 * accepts inline `<img>` directly — no figure wrapper needed.
 */
export function imageToInlineHtml(image: ImageRef): string {
	if (!image.src) {
		return "";
	}
	const safeSrc = image.src.replace(/"/g, "&quot;");
	const safeAlt = image.alt.replace(/"/g, "&quot;");
	const altAttr = safeAlt ? ` alt="${safeAlt}"` : "";
	return `<img src="${safeSrc}"${altAttr}>`;
}

/**
 * Post-pass for the ADO push pipeline (image variant): substitute every
 * `<p>token</p>` with an inline `<img>` tag. Bare sentinels (no wrap) are
 * handled defensively.
 */
export function restoreAdoImages(
	html: string,
	images: readonly ImageRef[],
): string {
	if (images.length === 0) {
		return html;
	}
	return html
		.replace(
			new RegExp(`<p>${ADO_IMG_TOKEN_RE.source}</p>`, "g"),
			(_m, idx) => imageToInlineHtml(images[Number(idx)]),
		)
		.replace(ADO_IMG_TOKEN_RE, (_m, idx) =>
			imageToInlineHtml(images[Number(idx)]),
		);
}

// =============================================================================
// ADO attachment upload — external <img> URLs don't render in ADO
// =============================================================================
//
// ADO's HTML sanitizer strips/blocks `<img src="https://external.com/…">`
// references from `System.Description` (CSP enforced on the rendered work-
// item page — even publicly reachable URLs like Wikipedia images don't
// load). The supported way to render an image in an ADO description is
// to upload it as an attachment to the work item or the project, then
// reference the returned attachment URL (which is on `dev.azure.com` and
// thus passes the sanitizer).
//
// We POST the image binary to:
//   POST {orgUrl}/_apis/wit/attachments?fileName={name}&api-version=7.0
//
// (No project scope on the URL — attachments are org-scoped and become
// associated with a work item when referenced from its description.)
//
// Returns `{ id, url }`; we use `url` as the new `src`.
// =============================================================================

export interface AdoAttachmentTarget {
	/** PAT with `Work Items (Read & Write)` scope. */
	pat: string;
	/** ADO organization slug — e.g. `example-org`. */
	org: string;
}

/**
 * Pick a safe-ish filename for an image URL. Falls back to a deterministic
 * stem so two distinct URLs that happen to share a basename don't collide.
 */
function fileNameForImageUrl(src: string, index: number): string {
	const last = src.split(/[?#]/)[0].split("/").pop() ?? "";
	const cleaned = last.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80);
	if (cleaned && /\.[a-z0-9]{2,5}$/i.test(cleaned)) {
		return cleaned;
	}
	const fallbackExt = /\.svg$/i.test(src)
		? ".svg"
		: /\.png$/i.test(src)
			? ".png"
			: /\.jpe?g$/i.test(src)
				? ".jpg"
				: /\.gif$/i.test(src)
					? ".gif"
					: /\.webp$/i.test(src)
						? ".webp"
						: ".bin";
	return `image-${index}${fallbackExt}`;
}

/**
 * Pick the display filename for an image being uploaded to a PM tool. Prefers
 * the `alt` text — on pull we store the real source filename there (e.g.
 * `download.jpg`), so this avoids the generic `image-0.bin` stem that
 * `fileNameForImageUrl` produces for opaque story-media keys (the `image-0.bin`
 * name seen on Fizzy card 1594). Falls back to the URL-derived name when `alt`
 * is empty or not filename-like.
 */
export function fileNameForImage(image: ImageRef, index: number): string {
	const alt = image.alt?.trim() ?? "";
	if (alt && /\.[a-z0-9]{2,5}$/i.test(alt)) {
		const cleaned = alt.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80);
		if (cleaned && /\.[a-z0-9]{2,5}$/i.test(cleaned)) {
			return cleaned;
		}
	}
	return fileNameForImageUrl(image.src, index);
}

/**
 * Upload one image to ADO attachments. Returns the attachment URL on
 * success, or `null` if the source fetch or the ADO upload failed (the
 * caller will leave the original src in place so the surrounding text
 * still ships — same graceful-fallback policy as the story-media
 * signed-URL resolver).
 */
async function uploadOneImageToAdo(
	image: ImageRef,
	index: number,
	target: AdoAttachmentTarget,
): Promise<string | null> {
	const src = image.src;
	if (!src) {
		return null;
	}
	// Bail early on data URLs — they're already inline; ADO usually
	// strips them too, but uploading a data-URL is an extra round-trip
	// and the failure mode is the same.
	if (/^data:/i.test(src)) {
		return null;
	}
	// Bail on URLs already pointing at this ADO instance — re-uploading
	// would be wasteful, and signed download URLs from ADO attachments
	// already pass the sanitizer.
	if (/dev\.azure\.com\/[^/]+\/_apis\/wit\/attachments/i.test(src)) {
		return src;
	}

	let binary: ArrayBuffer;
	let contentType = "application/octet-stream";
	try {
		// Send a real-ish User-Agent — Wikipedia, GitHub user-content, and
		// other public image hosts return 4xx for default Node user-agents
		// (Wikipedia returns 400; GitHub returns 403). The token is
		// arbitrary but identifies the request as Fabric's sync worker so
		// hosts who want to block can do so deliberately.
		const res = await fetch(src, {
			headers: {
				"User-Agent":
					"Fabric-Sync/1.0 (+https://staging.fabric.pro; pm-sync worker)",
				Accept: "image/*,*/*;q=0.8",
			},
		});
		if (!res.ok) {
			logger.warn("[ADO Attachments] Source fetch failed", {
				src,
				status: res.status,
			});
			return null;
		}
		binary = await res.arrayBuffer();
		contentType = res.headers.get("content-type") ?? contentType;
	} catch (err) {
		logger.warn("[ADO Attachments] Source fetch threw", {
			src,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}

	// Prefer the image's `alt` (the real source filename captured on pull, e.g.
	// `download.jpg`) over the opaque story-media URL stem. Critical for the
	// round-trip: ADO's attachment GET returns `application/octet-stream`, so the
	// re-pull infers the image type from the `?fileName=` extension. A generic
	// `image-0.bin` (the URL-stem fallback) has no image extension → the re-pull
	// can't infer a type and drops the image to a `[Image could not be imported]`
	// placeholder (ADO WI #226: photos broke on the second pull).
	const fileName = fileNameForImage(image, index);
	// ADO attachments endpoint expects `application/octet-stream`. Using
	// the source's Content-Type (image/svg+xml, image/png, …) returns 400.
	const uploadUrl = `https://dev.azure.com/${encodeURIComponent(target.org)}/_apis/wit/attachments?fileName=${encodeURIComponent(fileName)}&api-version=7.1`;
	const auth = `Basic ${Buffer.from(`:${target.pat}`).toString("base64")}`;
	try {
		const up = await fetch(uploadUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/octet-stream",
				Authorization: auth,
			},
			body: binary,
		});
		if (!up.ok) {
			let bodyPreview = "";
			try {
				bodyPreview = (await up.text()).slice(0, 300);
			} catch {
				/* ignore */
			}
			logger.warn("[ADO Attachments] Upload failed", {
				src,
				fileName,
				status: up.status,
				bodyPreview,
				sourceContentType: contentType,
				size: binary.byteLength,
			});
			return null;
		}
		const json = (await up.json()) as { id?: string; url?: string };
		return json.url ?? null;
	} catch (err) {
		logger.warn("[ADO Attachments] Upload threw", {
			src,
			fileName,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * Upload every image in `images` to ADO attachments and return a new
 * `ImageRef[]` with each `src` rewritten to the resulting ADO attachment
 * URL. Failed uploads keep the original `src` (the description still
 * ships and the surrounding text is unaffected).
 *
 * Also walks any HTML body and rewrites in-cell `<img src="…">` tags so
 * images inside tables get the same treatment.
 */
export async function uploadAdoImageAttachments(
	images: readonly ImageRef[],
	target: AdoAttachmentTarget,
): Promise<ImageRef[]> {
	if (images.length === 0) {
		return [];
	}
	return Promise.all(
		images.map(async (img, i) => {
			const uploaded = await uploadOneImageToAdo(img, i, target);
			return uploaded ? { ...img, src: uploaded } : img;
		}),
	);
}

// =============================================================================
// GitLab push image upload (Markdown → GitLab /uploads)
// =============================================================================

/** Pick a GitLab upload filename from the alt text, else a type-derived stem. */
function gitlabUploadFileName(alt: string, contentType: string): string {
	const a = (alt || "").trim();
	if (a && /\.[a-z0-9]{2,5}$/i.test(a)) {
		const cleaned = a.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80);
		if (cleaned) {
			return cleaned;
		}
	}
	const ext = /png/.test(contentType)
		? "png"
		: /gif/.test(contentType)
			? "gif"
			: /webp/.test(contentType)
				? "webp"
				: /svg/.test(contentType)
					? "svg"
					: "jpg";
	return `image.${ext}`;
}

/**
 * Upload every embeddable markdown image in a GitLab-bound description to the
 * project's `POST /api/v4/projects/:id/uploads` endpoint and rewrite each
 * `![alt](src)` to the returned `/uploads/{secret}/{file}` link.
 *
 * Why: GitLab renders GitLab Flavored Markdown but BLOCKS `data:` image URLs
 * (so the base64 inlining other providers tolerate shows as a broken image —
 * GitLab issue #10) and Fabric's signed story-media S3 URLs expire / aren't
 * GitLab-hosted. Uploading to `/uploads` is GitLab's native, durable mechanism.
 *
 * Sources handled per image: `data:` (decoded) and `http(s)` (fetched —
 * story-media signed URLs are self-authenticating). Already-GitLab `/uploads/`
 * links are left as-is. Best-effort per image: any failure leaves the original
 * markdown so the surrounding description still ships.
 */
export async function uploadGitLabImagesAndRewriteDescription(
	description: string,
	opts: { token: string; projectId: string; baseUrl?: string },
): Promise<string> {
	if (!description || !description.includes("![")) {
		return description;
	}
	const root = (opts.baseUrl || "https://gitlab.com").replace(/\/+$/, "");
	const apiBase = root.endsWith("/api/v4") ? root : `${root}/api/v4`;
	const uploadUrl = `${apiBase}/projects/${encodeURIComponent(
		opts.projectId,
	)}/uploads`;
	const MAX_BYTES = 25 * 1024 * 1024;

	const matches = [...description.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)];
	if (matches.length === 0) {
		return description;
	}

	let result = description;
	for (const m of matches) {
		const [whole, alt, src] = m;
		// Already a GitLab upload — nothing to do.
		if (/\/uploads\/[0-9a-f]{32}\//i.test(src)) {
			continue;
		}
		try {
			let bytes: Buffer;
			let contentType = "application/octet-stream";
			const data = src.match(/^data:([^;,]*)?(;base64)?,([\s\S]*)$/i);
			if (data) {
				contentType = data[1] || contentType;
				bytes = data[2]
					? Buffer.from(data[3], "base64")
					: Buffer.from(decodeURIComponent(data[3]), "utf8");
			} else if (/^https?:\/\//i.test(src)) {
				const res = await fetch(src, {
					headers: { "User-Agent": "Fabric-Sync/1.0 (pm-sync push)" },
				});
				if (!res.ok) {
					continue;
				}
				bytes = Buffer.from(await res.arrayBuffer());
				contentType =
					res.headers.get("content-type")?.split(";")[0]?.trim() ||
					contentType;
			} else {
				continue; // relative/non-fetchable URL we can't upload
			}
			if (bytes.length === 0 || bytes.length > MAX_BYTES) {
				continue;
			}

			const fileName = gitlabUploadFileName(alt, contentType);
			const form = new FormData();
			form.append(
				"file",
				new Blob([new Uint8Array(bytes)], { type: contentType }),
				fileName,
			);
			const up = await fetch(uploadUrl, {
				method: "POST",
				headers: { Authorization: `Bearer ${opts.token}` },
				body: form,
			});
			if (!up.ok) {
				logger.warn("[GitLab Attachments] upload failed", {
					status: up.status,
					fileName,
				});
				continue;
			}
			const json = (await up.json()) as { url?: string };
			if (!json.url) {
				continue;
			}
			result = result.replace(whole, `![${alt}](${json.url})`);
		} catch (err) {
			logger.warn("[GitLab Attachments] upload threw", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return result;
}

/**
 * Pick a GitLab upload filename for a NON-image attachment. Prefers the link
 * label / anchor text when it looks like a filename (has an extension), else the
 * last path segment of the source URL (Fabric story-media keys end with the
 * original filename), else a safe fallback.
 */
function gitlabAttachmentFileName(label: string, src: string): string {
	const clean = (s: string) =>
		s
			.trim()
			.replace(/[^\w.-]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, 100);
	const fromLabel = clean(label || "");
	if (fromLabel && /\.[a-z0-9]{1,8}$/i.test(fromLabel)) {
		return fromLabel;
	}
	const path = src.split(/[?#]/)[0];
	let seg = path.split("/").pop() || "";
	try {
		seg = decodeURIComponent(seg);
	} catch {
		// keep raw segment
	}
	const fromUrl = clean(seg);
	if (fromUrl && /\.[a-z0-9]{1,8}$/i.test(fromUrl)) {
		return fromUrl;
	}
	return fromLabel || fromUrl || "attachment";
}

/**
 * Upload Fabric-hosted FILE attachments (non-image) in a GitLab-bound markdown
 * description to the project's `POST /api/v4/projects/:id/uploads` endpoint and
 * rewrite each to a native `[name](/uploads/{secret}/{file})` link.
 *
 * Mirror of `uploadGitLabImagesAndRewriteDescription`, but for the attachment
 * shapes the pull ingester (`pull-image-ingest.ts`) emits: markdown
 * `[label](src)` links and `<a … data-s3-key="story-media/…">label</a>` HTML
 * links. WITHOUT this, a pulled (or pasted) file attachment ships back to GitLab
 * as a `localhost`/expiring story-media signed URL GitLab can't resolve — the
 * file is effectively lost on the round-trip.
 *
 * Only Fabric-hosted sources (`/story-media/` URLs or `data:`) are uploaded; the
 * "View in Fabric" back-link and arbitrary external links are left as-is, and
 * already-GitLab `/uploads/` links are skipped. Best-effort per attachment: any
 * failure leaves the original link so the description still ships.
 */
export async function uploadGitLabFileAttachmentsAndRewrite(
	description: string,
	opts: { token: string; projectId: string; baseUrl?: string },
): Promise<string> {
	if (!description) {
		return description;
	}
	const root = (opts.baseUrl || "https://gitlab.com").replace(/\/+$/, "");
	const apiBase = root.endsWith("/api/v4") ? root : `${root}/api/v4`;
	const uploadUrl = `${apiBase}/projects/${encodeURIComponent(
		opts.projectId,
	)}/uploads`;
	const MAX_BYTES = 25 * 1024 * 1024;

	// Only Fabric-hosted attachments are ours to re-upload. Skip already-GitLab
	// uploads, the Fabric back-link, and arbitrary external links.
	const shouldUpload = (src: string): boolean =>
		!!src &&
		!/\/uploads\/[0-9a-f]{32}\//i.test(src) &&
		(/\/story-media\//i.test(src) || /^data:/i.test(src));

	const uploadOne = async (
		src: string,
		label: string,
	): Promise<string | null> => {
		try {
			let bytes: Buffer;
			let contentType = "application/octet-stream";
			const data = src.match(/^data:([^;,]*)?(;base64)?,([\s\S]*)$/i);
			if (data) {
				contentType = data[1] || contentType;
				bytes = data[2]
					? Buffer.from(data[3], "base64")
					: Buffer.from(decodeURIComponent(data[3]), "utf8");
			} else if (/^https?:\/\//i.test(src)) {
				const res = await fetch(src, {
					headers: { "User-Agent": "Fabric-Sync/1.0 (pm-sync push)" },
				});
				if (!res.ok) {
					return null;
				}
				bytes = Buffer.from(await res.arrayBuffer());
				contentType =
					res.headers.get("content-type")?.split(";")[0]?.trim() ||
					contentType;
			} else {
				return null;
			}
			if (bytes.length === 0 || bytes.length > MAX_BYTES) {
				return null;
			}
			const fileName = gitlabAttachmentFileName(label, src);
			const form = new FormData();
			form.append(
				"file",
				new Blob([new Uint8Array(bytes)], { type: contentType }),
				fileName,
			);
			const up = await fetch(uploadUrl, {
				method: "POST",
				headers: { Authorization: `Bearer ${opts.token}` },
				body: form,
			});
			if (!up.ok) {
				logger.warn("[GitLab Attachments] file upload failed", {
					status: up.status,
					fileName,
				});
				return null;
			}
			const json = (await up.json()) as { url?: string };
			return json.url ?? null;
		} catch (err) {
			logger.warn("[GitLab Attachments] file upload threw", {
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	};

	let result = description;

	// 1. Markdown file links `[label](src)` — NOT images (negative lookbehind).
	for (const m of [...result.matchAll(/(?<!!)\[([^\]]*)\]\(([^)\s]+)\)/g)]) {
		const [whole, label, src] = m;
		if (!shouldUpload(src)) {
			continue;
		}
		const url = await uploadOne(src, label);
		if (url) {
			const name = label || gitlabAttachmentFileName("", src);
			result = result.replace(whole, `[${name}](${url})`);
		}
	}

	// 2. HTML `<a … href data-s3-key="story-media/…">label</a>` links.
	for (const m of [...result.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]) {
		const [whole, attrs, inner] = m;
		const href = attrs.match(/\bhref=["']([^"']*)["']/i)?.[1] ?? "";
		if (!shouldUpload(href)) {
			continue;
		}
		const label = inner.replace(/<[^>]+>/g, "").trim();
		const url = await uploadOne(href, label);
		if (url) {
			const name = label || gitlabAttachmentFileName("", href);
			result = result.replace(whole, `[${name}](${url})`);
		}
	}

	return result;
}

/**
 * Walk through an HTML body and replace every `<img src="…">` tag with
 * an uploaded ADO attachment URL. Used to rewrite images that travel
 * inside a `<table>` block (in-cell images) — those don't go through
 * `extractAdoImages` and `restoreAdoImages`, so we need a second pass
 * to upload them.
 *
 * Returns the rewritten HTML. Failures leave the original src in place.
 */
export async function rewriteAdoInCellImagesToAttachments(
	html: string,
	target: AdoAttachmentTarget,
): Promise<string> {
	if (!html || !html.includes("<img")) {
		return html;
	}
	const imgTagRe = /<img\b[^>]*?\/?>/gi;
	const matches = [...html.matchAll(imgTagRe)];
	if (matches.length === 0) {
		return html;
	}

	const refs: ImageRef[] = matches.map((m) => parseImgTag(m[0]));
	const uploaded = await uploadAdoImageAttachments(refs, target);

	let result = html;
	for (let i = 0; i < matches.length; i++) {
		const original = matches[i][0];
		const newSrc = uploaded[i].src;
		const oldSrc = refs[i].src;
		if (!newSrc || newSrc === oldSrc) {
			continue;
		}
		const safe = newSrc.replace(/"/g, "&quot;");
		const replaced = original.replace(
			/\bsrc=(["'])([^"']*)\1/i,
			`src="${safe}"`,
		);
		result = result.replace(original, replaced);
	}
	return result;
}

// =============================================================================
// Generic image fetch → base64 data URL
// =============================================================================
//
// Used by the Fizzy push path. Lexxy's renderer blocks external `<img src>`
// at render time regardless of CSP (verified via probe cards 12/13). The
// CSP allows `data:` URLs broadly, and Lexxy's renderer honours them, so
// inlining the image bytes as base64 lets Fabric-authored images render in
// Fizzy without needing a Basecamp Active Storage upload path (which the
// Fizzy MCP server does not expose as a tool).
//
// Trade-off: every image embedded in a description fattens the payload by
// ~33% over raw bytes (base64 overhead). Typical Fabric story-media images
// are well under 1 MB so this is fine; we cap source size to keep the worst
// case bounded.

/**
 * Maximum source bytes we are willing to inline as a data URL. Anything
 * larger gets skipped (the original src remains in the description, which
 * is preferable to producing a 5 MB description that Fizzy may truncate).
 */
const BASE64_INLINE_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Fetch a single image URL and return a `data:` URL containing the
 * base64-encoded bytes, or `null` when the fetch failed / the response
 * was too large / the source was already a `data:` URL.
 *
 * The same `User-Agent` trick used for ADO attachment uploads applies —
 * Wikipedia / GitHub user-content reject default Node user-agents.
 */
export async function fetchImageAsBase64DataUrl(
	src: string,
): Promise<string | null> {
	if (!src) {
		return null;
	}
	// Already a data: URL — no work to do.
	if (/^data:/i.test(src)) {
		return src;
	}
	let binary: ArrayBuffer;
	let contentType = "image/png";
	try {
		const res = await fetch(src, {
			headers: {
				"User-Agent":
					"Fabric-Sync/1.0 (+https://staging.fabric.pro; pm-sync worker)",
				Accept: "image/*,*/*;q=0.8",
			},
		});
		if (!res.ok) {
			logger.warn("[Base64 Inline] Source fetch failed", {
				src,
				status: res.status,
			});
			return null;
		}
		binary = await res.arrayBuffer();
		contentType = res.headers.get("content-type") ?? contentType;
	} catch (err) {
		logger.warn("[Base64 Inline] Source fetch threw", {
			src,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}

	if (binary.byteLength > BASE64_INLINE_MAX_BYTES) {
		logger.warn(
			"[Base64 Inline] Source too large to inline, leaving original",
			{
				src,
				byteLength: binary.byteLength,
				max: BASE64_INLINE_MAX_BYTES,
			},
		);
		return null;
	}

	const base64 = Buffer.from(binary).toString("base64");
	// Trim parameters (e.g. `image/png; charset=binary`) — the data-URL
	// MIME type prefix should be the bare media type.
	const mime = contentType.split(";")[0]?.trim() || "image/png";
	return `data:${mime};base64,${base64}`;
}

/**
 * Walk an ImageRef[] and replace each `.src` with a `data:` URL when the
 * fetch succeeds. Failed entries keep their original `src` (so the
 * surrounding text still ships, matching the ADO graceful-fallback policy).
 */
export async function inlineImagesAsBase64DataUrls(
	images: readonly ImageRef[],
): Promise<ImageRef[]> {
	if (images.length === 0) {
		return [];
	}
	return Promise.all(
		images.map(async (img) => {
			const dataUrl = await fetchImageAsBase64DataUrl(img.src);
			return dataUrl ? { ...img, src: dataUrl } : img;
		}),
	);
}

/**
 * Jira push path: walk a markdown (post-`convertEmbeddedHtmlTablesToMarkdown`)
 * body, find every external image reference (both `![alt](url)` markdown form
 * and any surviving `<img src="…">` HTML form inside cells), fetch each
 * binary, and substitute the URL with a base64 `data:` URL inline.
 *
 * Why: Atlassian's Rovo MCP wraps every external `<img>` / `![]()` URL — and
 * even `data:` URLs — in an Atlassian Media `blob:` proxy placeholder. The
 * proxy DOES resolve `data:` URLs (verified empirically against KAN-2 on
 * staging: both standalone and in-cell `data:` URL images render as real
 * PNGs) but fails to resolve external HTTPS URLs because Atlassian Media
 * isn't an arbitrary image host. Inlining the bytes side-steps Atlassian
 * Media entirely — the rendered ADF media node carries the bytes itself.
 *
 * This mirrors the Fizzy base64 inline path from PR #1163 — same fetch
 * helper (`fetchImageAsBase64DataUrl`), same per-image graceful fallback
 * (failed fetches keep the original src in place so the rest of the body
 * still ships), same 2 MB cap.
 *
 * Skip rules: data: URLs already inlined; non-HTTP URLs (mailto:, file:,
 * literal "url" from broken backtick-wrapped image syntax). Repeated URLs
 * are deduped to a single fetch and applied across all occurrences.
 */
export async function inlineJiraMarkdownImagesAsBase64DataUrls(
	description: string,
): Promise<string> {
	if (!description) {
		return description;
	}

	const sources: string[] = [];
	const seen = new Set<string>();
	const collect = (src: string) => {
		if (!src) {
			return;
		}
		if (seen.has(src)) {
			return;
		}
		if (/^data:/i.test(src)) {
			return; // already inlined
		}
		if (!/^https?:\/\//i.test(src)) {
			return; // non-HTTP (e.g. "url")
		}
		seen.add(src);
		sources.push(src);
	};
	const mdRe = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
	const htmlRe = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
	let m: RegExpExecArray | null;
	while ((m = mdRe.exec(description)) !== null) {
		collect(m[1]);
	}
	while ((m = htmlRe.exec(description)) !== null) {
		collect(m[1]);
	}

	if (sources.length === 0) {
		return description;
	}

	// Fetch + base64 each unique URL in parallel.
	const substitutions = await Promise.all(
		sources.map(async (src) => {
			const dataUrl = await fetchImageAsBase64DataUrl(src);
			return dataUrl && dataUrl !== src ? { src, dataUrl } : null;
		}),
	);

	let result = description;
	for (const sub of substitutions) {
		if (!sub) {
			continue;
		}
		// Plain string substitution — every occurrence of the source URL is
		// replaced. Both `![](url)` and `<img src="url">` shapes share the
		// same `url` token so a single pass covers both.
		result = result.split(sub.src).join(sub.dataUrl);
	}
	return result;
}

/**
 * Walk an HTML fragment, fetch every `<img>` tag's src, and rewrite the
 * tag's `src` attribute to a `data:` URL. Mirrors
 * `rewriteAdoInCellImagesToAttachments` for in-cell images that travel
 * inside a captured table block.
 */
export async function rewriteInCellImagesToBase64DataUrls(
	html: string,
): Promise<string> {
	if (!html || !html.includes("<img")) {
		return html;
	}
	const imgTagRe = /<img\b[^>]*?\/?>/gi;
	const matches = [...html.matchAll(imgTagRe)];
	if (matches.length === 0) {
		return html;
	}

	const refs: ImageRef[] = matches.map((m) => parseImgTag(m[0]));
	const inlined = await inlineImagesAsBase64DataUrls(refs);

	let result = html;
	for (let i = 0; i < matches.length; i++) {
		const original = matches[i][0];
		const newSrc = inlined[i].src;
		const oldSrc = refs[i].src;
		if (!newSrc || newSrc === oldSrc) {
			continue;
		}
		const safe = newSrc.replace(/"/g, "&quot;");
		const replaced = original.replace(
			/\bsrc=(["'])([^"']*)\1/i,
			`src="${safe}"`,
		);
		result = result.replace(original, replaced);
	}
	return result;
}

// =============================================================================
// Fizzy native ActionText attachment upload (Rails direct_uploads flow)
// =============================================================================
//
// Fizzy/Basecamp inherits Rails ActionText. The native way to embed an image
// in a rich-text field is a 3-step flow:
//
//   1. POST file metadata to
//      `https://app.fizzy.do/{account_slug}/rails/active_storage/direct_uploads`
//      with Bearer API key. Atlassian returns a `signed_id` + a one-shot
//      direct-upload URL and the headers to send.
//   2. PUT the file bytes to the returned URL with the exact headers given
//      (typically `Content-Type` + `Content-MD5`).
//   3. Reference the file in the rich-text body as
//      `<action-text-attachment sgid="{signed_id}"></action-text-attachment>`.
//
// This gives us **native Fizzy attachments** — descriptions stay tiny (no
// base64 bloat), images render with proper Lexxy attachment UI, and uses the
// same API key we already have in `MCPConfig.encryptedApiKey`. Reference:
// https://github.com/basecamp/fizzy/blob/main/docs/api/sections/rich_text.md.
//
// Failure-proof: every per-image upload is wrapped — on ANY failure (fetch,
// 4xx from direct_uploads, network, decrypt) we leave the original ImageRef
// untouched. The caller can then run the base64 inline path as a fallback,
// so a Fizzy attachment-service hiccup degrades gracefully to PR #1163
// behaviour instead of breaking the push.

/**
 * Connection target for Fizzy ActionText uploads. The API key is the same
 * Bearer token used by the Fizzy MCP for tool calls; the account slug
 * (`/000001` etc.) scopes the upload to the user's Fizzy account.
 */
export interface FizzyAttachmentTarget {
	apiKey: string;
	accountSlug: string;
}

/**
 * Build a `FizzyAttachmentTarget` from a user's Fizzy MCPConfig and the
 * project's `projectManagementAdditionalContext.account_slug`. Returns
 * `null` when the config can't supply both pieces — the caller then falls
 * back to the existing base64 inline path (PR #1163).
 *
 * The API key lives in `MCPConfig.encryptedApiKey` (AES-256-GCM via
 * `@repo/utils`). The account slug lives in
 * `projectManagementAdditionalContext.account_slug` (set during PM-tool
 * configuration; PR #1163 made this required for Fizzy push).
 */
export async function resolveFizzyAttachmentTarget(
	mcpConfig: { encryptedApiKey?: string | null } | null,
	additionalContext: Record<string, unknown> | null | undefined,
): Promise<FizzyAttachmentTarget | null> {
	if (!mcpConfig?.encryptedApiKey) {
		return null;
	}
	const accountSlugRaw = additionalContext?.account_slug;
	const accountSlug =
		typeof accountSlugRaw === "string" ? accountSlugRaw.trim() : null;
	if (!accountSlug) {
		return null;
	}
	let apiKey: string;
	try {
		const { decryptApiKey } = await import("@repo/utils");
		apiKey = decryptApiKey(mcpConfig.encryptedApiKey);
	} catch (err) {
		logger.warn("[Fizzy Attachments] API key decrypt failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
	if (!apiKey) {
		return null;
	}
	return { apiKey, accountSlug };
}

/**
 * Compute an MD5 checksum over the given bytes and return it base64-encoded
 * — the exact format Rails' direct_uploads endpoint expects in the
 * `blob.checksum` field and the `Content-MD5` upload header.
 */
function md5Base64(bytes: ArrayBuffer): string {
	// Node's createHash + base64 digest matches what Rails wants.
	// `require` keeps this synchronous and avoids the dynamic import overhead
	// per-image since this is hit in a loop.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { createHash } = require("node:crypto");
	const hash = createHash("md5");
	hash.update(Buffer.from(bytes));
	return hash.digest("base64");
}

/**
 * Upload one URL's bytes to Fizzy via the Rails ActionText direct_uploads
 * flow. Returns the `attachable_sgid` on success (used to build the
 * `<action-text-attachment sgid="…">` tag), or `null` on any failure.
 *
 * Generalised over images AND non-image file attachments — the caller supplies
 * the display `fileName`, the `Accept` header, the size cap, a fallback
 * content-type, and an optional `preferContentType` (used for files where the
 * signed S3 URL responds `application/octet-stream` but the extension tells us
 * the real type).
 *
 * Failure modes that return `null` (caller applies its own fallback):
 *   - data: / non-http src (nothing to fetch)
 *   - source fetch failed (4xx, network, etc.)
 *   - source too large (cap supplied by caller)
 *   - direct_uploads endpoint failed (4xx, 5xx, malformed JSON)
 *   - PUT to the returned signed URL failed
 */
async function uploadOneUrlToFizzy(
	src: string,
	fileName: string,
	target: FizzyAttachmentTarget,
	opts: {
		accept: string;
		maxBytes: number;
		fallbackContentType: string;
		preferContentType?: string | null;
	},
): Promise<string | null> {
	if (!src) {
		return null;
	}
	if (/^data:/i.test(src)) {
		return null;
	}
	if (!/^https?:\/\//i.test(src)) {
		return null;
	}

	// 1. Fetch source bytes.
	let bytes: ArrayBuffer;
	let contentType = opts.fallbackContentType;
	try {
		const res = await fetch(src, {
			headers: {
				"User-Agent":
					"Fabric-Sync/1.0 (+https://staging.fabric.pro; pm-sync worker)",
				Accept: opts.accept,
			},
		});
		if (!res.ok) {
			logger.warn("[Fizzy Attachments] Source fetch failed", {
				src,
				status: res.status,
			});
			return null;
		}
		bytes = await res.arrayBuffer();
		contentType =
			res.headers.get("content-type")?.split(";")[0]?.trim() ||
			contentType;
	} catch (err) {
		logger.warn("[Fizzy Attachments] Source fetch threw", {
			src,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}

	if (bytes.byteLength > opts.maxBytes) {
		logger.warn(
			"[Fizzy Attachments] Source too large to upload, leaving original",
			{ src, byteLength: bytes.byteLength, max: opts.maxBytes },
		);
		return null;
	}

	// Files fetched from the signed S3 URL frequently respond with a generic
	// `application/octet-stream`; an extension-derived type (when supplied) is
	// more accurate and drives Fizzy's attachment icon + preview.
	if (
		opts.preferContentType &&
		(!contentType || contentType === "application/octet-stream")
	) {
		contentType = opts.preferContentType;
	}

	const checksum = md5Base64(bytes);

	// 2. Request a direct upload URL.
	// Account slug stored on additionalContext may be `/000001` or `000001`;
	// the API expects no leading slash on the path.
	const slugForPath = target.accountSlug.replace(/^\//, "");
	const directUploadUrl = `https://app.fizzy.do/${slugForPath}/rails/active_storage/direct_uploads`;
	let signedId: string | null = null;
	let uploadUrl: string | null = null;
	let uploadHeaders: Record<string, string> = {};
	try {
		const meta = await fetch(directUploadUrl, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${target.apiKey}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				blob: {
					filename: fileName,
					byte_size: bytes.byteLength,
					checksum,
					content_type: contentType,
				},
			}),
		});
		if (!meta.ok) {
			const text = await meta.text().catch(() => "");
			logger.warn("[Fizzy Attachments] direct_uploads POST failed", {
				src,
				fileName,
				status: meta.status,
				body: text.slice(0, 200),
			});
			return null;
		}
		const json = (await meta.json()) as {
			signed_id?: string;
			attachable_sgid?: string;
			direct_upload?: { url?: string; headers?: Record<string, string> };
		};
		// Fizzy's `direct_uploads` response returns TWO signed IDs:
		//   - `signed_id`         (purpose: "blob_id")      — generic blob reference
		//   - `attachable_sgid`   (purpose: "attachable")   — what ActionText needs
		// Rails ActionText embeds attachments as
		// `<action-text-attachment sgid="…">`, and Lexxy/Trix renderers
		// resolve the sgid via `GlobalID::Locator.locate_signed(sgid,
		// for: :attachable)`. Using the `blob_id`-purpose token returns
		// an orphan blob to the renderer — hence the broken-icon glyphs
		// we saw on card 12 after PR #1170 shipped. Verified via the
		// Fizzy probe procedure (PR #1171); both ids decode to the same
		// blob id `03g6qfpwye...` but only `attachable_sgid` carries the
		// purpose claim ActionText expects.
		signedId = json.attachable_sgid ?? json.signed_id ?? null;
		uploadUrl = json.direct_upload?.url ?? null;
		uploadHeaders = json.direct_upload?.headers ?? {};
		if (!signedId || !uploadUrl) {
			logger.warn(
				"[Fizzy Attachments] direct_uploads response missing signed_id or url",
				{ src, responsePreview: JSON.stringify(json).slice(0, 200) },
			);
			return null;
		}
	} catch (err) {
		logger.warn("[Fizzy Attachments] direct_uploads POST threw", {
			src,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}

	// 3. PUT bytes to the signed URL with the headers the API gave us.
	try {
		const put = await fetch(uploadUrl, {
			method: "PUT",
			headers: uploadHeaders,
			body: Buffer.from(bytes),
		});
		if (!put.ok) {
			const text = await put.text().catch(() => "");
			logger.warn("[Fizzy Attachments] PUT to signed URL failed", {
				src,
				fileName,
				status: put.status,
				body: text.slice(0, 200),
			});
			return null;
		}
	} catch (err) {
		logger.warn("[Fizzy Attachments] PUT to signed URL threw", {
			src,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}

	return signedId;
}

/**
 * Upload one image to Fizzy as an ActionText attachment. Thin wrapper over
 * `uploadOneUrlToFizzy` with an image-appropriate Accept header, a 10 MB cap,
 * and a filename derived from the image's `alt` (the real source filename
 * captured on pull) falling back to the URL stem.
 */
async function uploadOneImageToFizzy(
	image: ImageRef,
	index: number,
	target: FizzyAttachmentTarget,
): Promise<string | null> {
	return uploadOneUrlToFizzy(
		image.src,
		fileNameForImage(image, index),
		target,
		{
			accept: "image/*,*/*;q=0.8",
			maxBytes: 10 * 1024 * 1024,
			fallbackContentType: "image/png",
		},
	);
}

/**
 * Walk an ImageRef[] and upload each to Fizzy as an ActionText attachment.
 * Returns a parallel array of:
 *   - `{ kind: 'attachment', sgid }` for successful uploads — caller embeds
 *     as `<action-text-attachment sgid="…"></action-text-attachment>`.
 *   - `{ kind: 'fallback', ref }` for failed uploads — caller falls back
 *     to base64 inline (or whatever its degradation policy is).
 */
export async function uploadFizzyImageAttachments(
	images: readonly ImageRef[],
	target: FizzyAttachmentTarget,
): Promise<
	Array<
		| { kind: "attachment"; sgid: string; ref: ImageRef }
		| { kind: "fallback"; ref: ImageRef }
	>
> {
	if (images.length === 0) {
		return [];
	}
	return Promise.all(
		images.map(async (ref, i) => {
			const sgid = await uploadOneImageToFizzy(ref, i, target);
			return sgid
				? { kind: "attachment" as const, sgid, ref }
				: { kind: "fallback" as const, ref };
		}),
	);
}

/**
 * Render an ImageRef as an ActionText attachment tag. The `sgid` must be
 * the `signed_id` returned by Fizzy's direct_uploads endpoint.
 */
export function imageToActionTextAttachment(sgid: string): string {
	const safeSgid = sgid.replace(/"/g, "&quot;");
	return `<action-text-attachment sgid="${safeSgid}"></action-text-attachment>`;
}

/**
 * Resolve every ImageRef to its final Fizzy embed HTML.
 *
 * Returns one embed string per input image in order. Each embed is one of:
 *   - `<action-text-attachment sgid="…">` — native Fizzy attachment, when
 *     the ActionText direct_uploads flow succeeded (preferred path —
 *     small description, native Lexxy rendering).
 *   - `<figure class="lexxy-content__attachment-wrapper"><img src="data:…"></figure>`
 *     — base64 inline fallback (PR #1163 behaviour) when the attachment
 *     upload failed or no `FizzyAttachmentTarget` could be built.
 *   - `<figure class="lexxy-content__attachment-wrapper"><img src="{orig}"></figure>`
 *     — last-resort fallback when both attachment upload and base64
 *     fetch failed (image still won't render in Lexxy — broken icon —
 *     but the surrounding description ships intact).
 *
 * Target `null` (e.g. no account_slug configured) skips the upload
 * attempt entirely and goes straight to base64 — zero regression from
 * the PR #1163 behaviour.
 */
export async function resolveFizzyImageEmbeds(
	images: readonly ImageRef[],
	target: FizzyAttachmentTarget | null,
): Promise<string[]> {
	if (images.length === 0) {
		return [];
	}

	// Step 1: try ActionText upload for every image (parallel). Fast path.
	const uploadResults = target
		? await uploadFizzyImageAttachments(images, target)
		: images.map((ref) => ({ kind: "fallback" as const, ref }));

	// Step 2: for any image that didn't upload, fall back to base64 inline.
	const fallbackImages: ImageRef[] = uploadResults
		.filter((r) => r.kind === "fallback")
		.map((r) => r.ref);
	const inlinedFallbacks =
		fallbackImages.length > 0
			? await inlineImagesAsBase64DataUrls(fallbackImages)
			: [];
	const inlinedBySrc = new Map<string, ImageRef>();
	for (let i = 0; i < fallbackImages.length; i++) {
		inlinedBySrc.set(fallbackImages[i].src, inlinedFallbacks[i]);
	}

	// Step 3: assemble final embed strings in original order.
	return uploadResults.map((r) => {
		if (r.kind === "attachment") {
			return imageToActionTextAttachment(r.sgid);
		}
		const inlined = inlinedBySrc.get(r.ref.src) ?? r.ref;
		return imageToLexxyFigure(inlined);
	});
}

/**
 * Substitute every standalone-image sentinel token in `html` with the
 * pre-resolved embed string at the same index. Parallel to
 * `restoreFizzyImages` but takes ready-made embed HTML strings instead of
 * an ImageRef array — required because the embed shape varies per image
 * (ActionText attachment vs base64 figure).
 */
export function restoreFizzyImagesWithEmbeds(
	html: string,
	embeds: readonly string[],
): string {
	if (embeds.length === 0) {
		return html;
	}
	return html
		.replace(
			new RegExp(`<p>${FIZZY_IMG_TOKEN_RE.source}</p>`, "g"),
			(_m, idx) => embeds[Number(idx)] ?? "",
		)
		.replace(FIZZY_IMG_TOKEN_RE, (_m, idx) => embeds[Number(idx)] ?? "");
}

// =============================================================================
// Fizzy file-attachment pipeline (non-image attachments on PUSH)
// =============================================================================
//
// On pull, file attachments are stored in the description as
//   <a href="{signed-s3-url}" data-s3-key="story-media/…" download>name</a>
// (see pull-image-ingest `linkHtml`). On push these anchors are NOT `<img>`,
// so the table/image extractors leave them in place — and then
// `markdownToSimpleHtml` HTML-escapes the raw `<a …>` into literal text
// (`&lt;a href=…&gt;name&lt;/a&gt;`), the exact card-corrupting garbage seen
// on Fizzy card 1594. Mirror the image pipeline: pre-extract each file anchor
// into a sentinel token (survives `markdownToSimpleHtml` unescaped), upload
// the bytes to Fizzy as a native ActionText attachment, then restore the token
// as `<action-text-attachment sgid="…">` — or, on upload failure, a clean
// non-escaped `<a>` link (never the escaped-text garbage).

export interface FileAttachmentRef {
	/** Signed download URL the bytes are fetched from (post media-rewrite). */
	href: string;
	/** Display filename (the anchor text), e.g. `Test.xlsx`. */
	filename: string;
	/** story-media S3 key, when present. */
	s3Key: string | null;
}

const FIZZY_FILE_TOKEN_RE = /__FIZZY_FILE_(\d+)__/g;
function fizzyFileToken(index: number): string {
	return `__FIZZY_FILE_${index}__`;
}

/**
 * Pre-pass for the Fizzy push pipeline: extract every story-media file anchor
 * (`<a … data-s3-key="story-media/…" … download>name</a>`) into a sentinel
 * token padded with blank lines so it survives `markdownToSimpleHtml`
 * unescaped. Images (`<img>`) are handled by `extractFizzyImages`; the Fabric
 * back-link anchor carries no `data-s3-key` so it is left untouched. Matching
 * on `data-s3-key="story-media/…"` is what scopes this to ingested file
 * attachments and avoids touching ordinary links.
 */
export function extractFizzyFileAttachments(input: string): {
	withTokens: string;
	files: FileAttachmentRef[];
} {
	const files: FileAttachmentRef[] = [];
	const withTokens = input.replace(
		/<a\b[^>]*\bdata-s3-key=["'](story-media\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
		(tag: string, s3Key: string, inner: string) => {
			const href = tag.match(/\bhref=["']([^"']*)["']/i)?.[1] ?? "";
			const filename =
				inner.replace(/<[^>]*>/g, "").trim() ||
				s3Key.split("/").pop() ||
				"attachment";
			files.push({ href, filename, s3Key });
			return `\n\n${fizzyFileToken(files.length - 1)}\n\n`;
		},
	);
	return { withTokens, files };
}

/**
 * Remove story-media FILE-attachment anchors
 * (`<a … data-s3-key="story-media/…" … download>name</a>`) from a description,
 * collapsing the blank lines left behind. Used by the ADO push: ADO keeps file
 * attachments as NATIVE work-item attachments (relations), so the pulled
 * display-only anchor must NOT be written back into `System.Description` — its
 * signed localhost/S3 URL is unreachable from ADO and `markdownToSimpleHtml`
 * would escape the raw `<a>` into literal `&lt;a&gt;` text on the card. The
 * native ADO attachment relation is untouched by a description update, so the
 * file stays attached. Inline `<img>` images are NOT touched here — those are
 * uploaded to ADO as attachments and referenced inline. The Fabric back-link
 * anchor carries no `data-s3-key`, so it is preserved.
 */
export function stripStoryMediaFileAnchors(html: string): string {
	return (
		html
			// HTML anchor form: <a … data-s3-key="story-media/…" … download>name</a>
			.replace(
				/<a\b[^>]*\bdata-s3-key=["']story-media\/[^"']+["'][^>]*>[\s\S]*?<\/a>/gi,
				"",
			)
			// Markdown link form: [name](…story-media/…) — but NOT images (`![…]`,
			// guarded by the negative lookbehind). A Fabric edit runs the pulled
			// description through Turndown, turning the `<a data-s3-key download>`
			// into a markdown link, so the ADO push must strip both shapes.
			.replace(/(?<!!)\[[^\]]*\]\([^)]*story-media\/[^)]*\)/g, "")
			.replace(/\n{3,}/g, "\n\n")
			.trim()
	);
}

/** Common MIME types keyed by file extension — drives Fizzy's attachment icon. */
const EXT_CONTENT_TYPES: Record<string, string> = {
	pdf: "application/pdf",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	csv: "text/csv",
	txt: "text/plain",
	rtf: "application/rtf",
	zip: "application/zip",
	json: "application/json",
	xml: "application/xml",
};
function contentTypeForFilename(filename: string): string | null {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	return EXT_CONTENT_TYPES[ext] ?? null;
}

/**
 * Resolve every FileAttachmentRef to its final Fizzy embed HTML, in order.
 * Preferred path: upload the bytes to Fizzy ActionText and emit
 * `<action-text-attachment sgid="…">` (native attachment, same as the source
 * card had). Fallback (no target / upload failed): a clean
 * `<a href="{signed-url}">name</a>` — a real link, never the escaped-text
 * garbage the bare anchor would otherwise become after `markdownToSimpleHtml`.
 */
export async function resolveFizzyFileEmbeds(
	files: readonly FileAttachmentRef[],
	target: FizzyAttachmentTarget | null,
): Promise<string[]> {
	if (files.length === 0) {
		return [];
	}
	return Promise.all(
		files.map(async (file) => {
			if (target) {
				const sgid = await uploadOneUrlToFizzy(
					file.href,
					file.filename,
					target,
					{
						accept: "*/*",
						maxBytes: 25 * 1024 * 1024,
						fallbackContentType: "application/octet-stream",
						preferContentType: contentTypeForFilename(
							file.filename,
						),
					},
				);
				if (sgid) {
					return imageToActionTextAttachment(sgid);
				}
			}
			// Fallback: a clean anchor with the (escaped) signed URL + filename
			// text — restored AFTER markdownToSimpleHtml, so it is never escaped
			// into literal text the way the bare token-less anchor would be.
			const safeHref = file.href.replace(/"/g, "&quot;");
			const safeName = file.filename
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");
			return `<a href="${safeHref}">${safeName}</a>`;
		}),
	);
}

/**
 * Substitute every file-attachment sentinel token in `html` with the
 * pre-resolved embed string at the same index. Parallel to
 * `restoreFizzyImagesWithEmbeds`.
 */
export function restoreFizzyFileAttachments(
	html: string,
	embeds: readonly string[],
): string {
	if (embeds.length === 0) {
		return html;
	}
	return html
		.replace(
			new RegExp(`<p>${FIZZY_FILE_TOKEN_RE.source}</p>`, "g"),
			(_m, idx) => embeds[Number(idx)] ?? "",
		)
		.replace(FIZZY_FILE_TOKEN_RE, (_m, idx) => embeds[Number(idx)] ?? "");
}

/**
 * Walk an HTML fragment (a captured table block) and replace every
 * `<img>` tag with the best Fizzy embed:
 *   1. ActionText attachment when the direct_uploads upload succeeded.
 *   2. Inline `<img src="data:…">` as base64 fallback (current PR #1163
 *      in-cell behaviour).
 *   3. Original `<img>` left untouched if both fail.
 *
 * Used for images inside captured table blocks — those don't pass through
 * `extractFizzyImages` so they need an in-place replacement pass instead
 * of token substitution.
 */
export async function rewriteFizzyInCellImagesHybrid(
	html: string,
	target: FizzyAttachmentTarget | null,
): Promise<string> {
	if (!html || !html.includes("<img")) {
		return html;
	}
	const imgTagRe = /<img\b[^>]*?\/?>/gi;
	const matches = [...html.matchAll(imgTagRe)];
	if (matches.length === 0) {
		return html;
	}

	const refs: ImageRef[] = matches.map((m) => parseImgTag(m[0]));
	const embeds = await resolveFizzyImageEmbeds(refs, target);

	let result = html;
	for (let i = 0; i < matches.length; i++) {
		const original = matches[i][0];
		const embed = embeds[i];
		if (!embed) {
			continue;
		}
		// Replace the original `<img>` with the resolved embed. For
		// ActionText attachments, this means the `<img>` tag inside a
		// `<td>` becomes an `<action-text-attachment>` element — Lexxy
		// renders that as an inline media node inside cells. For the
		// base64 fallback, we restore the in-place `<img>` shape so the
		// existing in-cell rendering keeps working.
		result = result.replace(original, embed);
	}
	return result;
}

// =============================================================================
// Fallback notice
// =============================================================================

/**
 * Append a graceful-fallback notice when one or more images could not be
 * resolved to a signed URL (AC4 from the bug spec). The notice points the
 * user back to Fabric, where the canonical version of the story always
 * shows the original images.
 *
 * Returns the original description unchanged when there are no unresolved
 * keys (the common path).
 */
export function appendUnresolvedMediaNotice(
	description: string,
	unresolvedCount: number,
	fabricUrl: string | null,
): string {
	if (unresolvedCount <= 0) {
		return description;
	}
	const label = unresolvedCount === 1 ? "image" : "images";
	const linkPart = fabricUrl
		? ` — view the original in [Fabric](${fabricUrl}).`
		: " — view the original in Fabric.";
	const notice = `\n\n_Note: ${unresolvedCount} ${label} could not be embedded${linkPart}_`;
	return description.endsWith("\n")
		? `${description.trimEnd()}${notice}`
		: `${description}${notice}`;
}

// =============================================================================
// Hybrid Atlassian Cloud — Jira REST attachment upload (PR #1169)
// =============================================================================
//
// The primary Rovo MCP OAuth token has aud=mcp.atlassian.com and 401s at
// api.atlassian.com. To upload attachments we need a SECONDARY token with
// aud=api.atlassian.com, obtained via the chained 3LO flow (see
// `mcp/atlassian-cloud/start` + `callback` procedures and PR #1169). The
// token + site context lives on `MCPConfig`:
//
//   - encryptedAtlassianCloudAccessToken : Bearer token
//   - atlassianCloudCloudId              : tenant UUID
//   - atlassianCloudSiteUrl              : https://{site}.atlassian.net
//
// Upload endpoint:
//
//   POST https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/issue/{key}/attachments
//        Authorization: Bearer {atlassianCloudAccessToken}
//        X-Atlassian-Token: no-check
//        Content-Type: multipart/form-data
//        body: file=@bytes;filename=screenshot-001.png
//
// Response: array of attachment metadata, each with `id` + `filename`. We
// keep the first item's id+filename and rewrite the description body to
// reference `${siteUrl}/secure/attachment/{id}/{filename}` — empirically
// verified on KAN-2 to render inline via Atlassian Media (the proxy
// resolves same-site URLs even when external URLs are blocked).
//
// FAILURE-PROOF: every upload is wrapped — on ANY failure (refresh,
// fetch, 4xx, network) the helper returns null and the caller silently
// degrades to base64 inline (existing PR #1167 path). The Cloud path is
// a strict additive optimisation; absence of it = current behaviour.

/** One Atlassian site the Cloud token can reach. */
export type JiraCloudResource = { cloudId: string; siteUrl: string };

export type JiraCloudTarget = {
	accessToken: string;
	/** Primary site (accessible-resources[0]) — display/back-compat only. */
	cloudId: string;
	siteUrl: string;
	mcpConfigId: string;
	/**
	 * Every site the token can reach. The upload path matches a Jira
	 * issue's own cloudId (parsed from its externalUrl) against this list
	 * so multi-site accounts upload to the RIGHT tenant. Falls back to the
	 * primary site when the list is empty (older tokens minted before the
	 * accessible-resources list was stored).
	 */
	resources: JiraCloudResource[];
};

/**
 * Read the Atlassian Cloud upload target from an MCPConfig row. Returns
 * null when any required field is missing or the token has expired
 * without a usable refresh token — in either case the caller degrades.
 *
 * Optionally takes a `refreshIfExpired` callback so the caller can wire
 * in the dedicated refresh helper (`refreshAtlassianCloudToken`) without
 * pulling its dependency tree into this module.
 */
export async function resolveJiraCloudTarget(
	mcpConfig: {
		id: string;
		encryptedAtlassianCloudAccessToken?: string | null;
		atlassianCloudTokenExpiresAt?: Date | string | null;
		atlassianCloudCloudId?: string | null;
		atlassianCloudSiteUrl?: string | null;
		atlassianCloudAccessibleResources?: unknown;
	},
	options?: {
		decrypt: (ciphertext: string) => string;
		refreshIfExpired?: (configId: string) => Promise<{
			accessToken: string;
		} | null>;
	},
): Promise<JiraCloudTarget | null> {
	if (!options) {
		return null;
	}
	const {
		encryptedAtlassianCloudAccessToken,
		atlassianCloudCloudId,
		atlassianCloudSiteUrl,
		atlassianCloudTokenExpiresAt,
		atlassianCloudAccessibleResources,
		id,
	} = mcpConfig;

	if (
		!encryptedAtlassianCloudAccessToken ||
		!atlassianCloudCloudId ||
		!atlassianCloudSiteUrl
	) {
		return null;
	}

	// Token expiry: refresh if we're within 60s of expiry. Without a
	// refresh callback, just degrade — the upload would 401 anyway and
	// the fallback would re-engage.
	let accessToken: string;
	try {
		accessToken = options.decrypt(encryptedAtlassianCloudAccessToken);
	} catch (err) {
		logger.warn("[Jira Cloud] access token decrypt failed", {
			configId: id,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}

	const expiresAtMs = atlassianCloudTokenExpiresAt
		? new Date(atlassianCloudTokenExpiresAt).getTime()
		: null;
	const nowMs = Date.now();
	if (expiresAtMs && expiresAtMs < nowMs + 60_000) {
		if (!options.refreshIfExpired) {
			logger.warn(
				"[Jira Cloud] token expiring soon and no refresh callback provided — degrading to base64",
				{ configId: id, expiresAtMs, nowMs },
			);
			return null;
		}
		try {
			const refreshed = await options.refreshIfExpired(id);
			if (!refreshed?.accessToken) {
				return null;
			}
			accessToken = refreshed.accessToken;
		} catch (err) {
			logger.warn("[Jira Cloud] token refresh threw — degrading", {
				configId: id,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	}

	// Parse the stored accessible-resources JSON into a clean list. Tokens
	// minted before this field existed have it null — fall back to the
	// primary site so single-site accounts keep working unchanged.
	const resources = parseAtlassianCloudResources(
		atlassianCloudAccessibleResources,
	);
	const effectiveResources =
		resources.length > 0
			? resources
			: [
					{
						cloudId: atlassianCloudCloudId,
						siteUrl: atlassianCloudSiteUrl,
					},
				];

	return {
		accessToken,
		cloudId: atlassianCloudCloudId,
		siteUrl: atlassianCloudSiteUrl,
		mcpConfigId: id,
		resources: effectiveResources,
	};
}

/** Coerce the stored JSON `[{ id, url }]` into `[{ cloudId, siteUrl }]`. */
function parseAtlassianCloudResources(raw: unknown): JiraCloudResource[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const out: JiraCloudResource[] = [];
	for (const entry of raw) {
		if (entry && typeof entry === "object") {
			const id = (entry as Record<string, unknown>).id;
			const url = (entry as Record<string, unknown>).url;
			if (typeof id === "string" && typeof url === "string") {
				out.push({ cloudId: id, siteUrl: url });
			}
		}
	}
	return out;
}

/**
 * Resolve which Atlassian site a Jira issue lives on, from the issue's
 * Fabric `externalUrl`, and confirm the Cloud token can reach it.
 *
 * Two externalUrl shapes are handled:
 *   - `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/issue/{id}`
 *     → cloudId is explicit; site URL resolved from the token's
 *       accessible-resources list.
 *   - `https://{site}.atlassian.net/browse/{KEY}` → site URL is explicit;
 *     cloudId resolved from the list by matching the host.
 *
 * Returns null (→ caller degrades to base64) when the issue's site isn't
 * among the token's granted resources, i.e. the token can't upload there.
 */
export function resolveIssueSite(
	target: JiraCloudTarget,
	externalUrl: string | null | undefined,
): JiraCloudResource | null {
	if (!externalUrl) {
		return null;
	}

	// Shape 1: api.atlassian.com/ex/jira/{cloudId}/...
	// cloudId is whatever sits between `/ex/jira/` and the next `/` — match
	// any non-slash run rather than assuming a hex UUID shape.
	const exMatch = externalUrl.match(
		/api\.atlassian\.com\/ex\/jira\/([^/]+)\//i,
	);
	if (exMatch?.[1]) {
		const cloudId = exMatch[1];
		const known = target.resources.find((r) => r.cloudId === cloudId);
		if (known) {
			return known;
		}
		logger.warn(
			"[Jira Cloud] issue cloudId not in granted accessible-resources — degrading",
			{ cloudId, granted: target.resources.map((r) => r.cloudId) },
		);
		return null;
	}

	// Shape 2: https://{site}.atlassian.net/browse/{KEY}
	try {
		const host = new URL(externalUrl).origin;
		const known = target.resources.find(
			(r) => r.siteUrl.replace(/\/+$/, "") === host,
		);
		if (known) {
			return known;
		}
		logger.warn(
			"[Jira Cloud] issue host not in granted accessible-resources — degrading",
			{ host, granted: target.resources.map((r) => r.siteUrl) },
		);
	} catch {
		// not a URL we can parse
	}
	return null;
}

type UploadedJiraAttachment = {
	id: string;
	filename: string;
	contentUrl: string; // siteUrl/secure/attachment/{id}/{filename}
};

/**
 * Fetch an external/data: image and POST it to Jira as an attachment on
 * the given issue. Returns null on any failure; never throws.
 *
 * `site` is the issue's OWN site (resolved via `resolveIssueSite` from
 * the issue's externalUrl) — NOT necessarily the token's primary site.
 * The `apiUrl` shape `https://api.atlassian.com/ex/jira/{cloudId}/...`
 * routes through Atlassian's OAuth gateway with the issue's cloudId. The
 * `contentUrl` we return uses that same site's host
 * `{siteUrl}/secure/attachment/{id}/{filename}` because that's the form
 * Atlassian Media's same-origin resolver handles inline (verified on
 * KAN-2 Test C/E).
 */
export async function uploadOneImageToJira(
	target: JiraCloudTarget,
	site: JiraCloudResource,
	issueKey: string,
	imageSrc: string,
	filenameHint: string,
): Promise<UploadedJiraAttachment | null> {
	const { attachment } = await uploadOneImageToJiraDetailed(
		target,
		site,
		issueKey,
		imageSrc,
		filenameHint,
	);
	return attachment;
}

/**
 * Like {@link uploadOneImageToJira} but returns a structured `error` string on
 * failure instead of swallowing it to `null`. The previous swallow made the
 * whole feature undebuggable in production: an attachment that silently failed
 * to upload was indistinguishable from "no images", and the sync still reported
 * SUCCESS. The error string is short, PII-free (status + truncated body), and
 * suitable for surfacing on `UserStory.lastPmSyncError`.
 */
export async function uploadOneImageToJiraDetailed(
	target: JiraCloudTarget,
	site: JiraCloudResource,
	issueKey: string,
	imageSrc: string,
	filenameHint: string,
): Promise<{
	attachment: UploadedJiraAttachment | null;
	error: string | null;
}> {
	try {
		// Fetch the bytes (works for both data: URLs and external HTTPS).
		let fetchRes: Response;
		try {
			fetchRes = await fetch(imageSrc);
		} catch (err) {
			const msg = `image fetch threw (${err instanceof Error ? err.message : String(err)})`;
			logger.warn("[Jira Cloud] image fetch threw", {
				issueKey,
				src: imageSrc.slice(0, 64),
				error: err instanceof Error ? err.message : String(err),
			});
			return { attachment: null, error: msg };
		}
		if (!fetchRes.ok) {
			logger.warn("[Jira Cloud] image fetch non-2xx", {
				issueKey,
				src: imageSrc.slice(0, 64),
				status: fetchRes.status,
			});
			return {
				attachment: null,
				error: `image fetch HTTP ${fetchRes.status}`,
			};
		}
		const blob = await fetchRes.blob();
		if (!blob || blob.size === 0) {
			return { attachment: null, error: "image bytes empty" };
		}

		const safeName = filenameHint.replace(/[^A-Za-z0-9._-]/g, "-");
		const form = new FormData();
		form.append("file", blob, safeName);

		const apiUrl = `https://api.atlassian.com/ex/jira/${site.cloudId}/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`;
		let res: Response;
		try {
			res = await fetch(apiUrl, {
				method: "POST",
				headers: {
					authorization: `Bearer ${target.accessToken}`,
					accept: "application/json",
					"x-atlassian-token": "no-check",
				},
				body: form,
			});
		} catch (err) {
			// A throw here (vs an HTTP error) typically means the runtime could
			// not reach api.atlassian.com at all — e.g. egress/DNS blocked on the
			// host. This is the signal that distinguishes a network/egress
			// failure from an auth/permission (4xx) failure.
			const msg = `attachment POST threw — could not reach api.atlassian.com (${err instanceof Error ? err.message : String(err)})`;
			logger.warn("[Jira Cloud] attachment POST threw", {
				issueKey,
				cloudId: site.cloudId,
				error: err instanceof Error ? err.message : String(err),
			});
			return { attachment: null, error: msg };
		}
		if (!res.ok) {
			const errBody = await res.text().catch(() => "");
			logger.warn("[Jira Cloud] attachment POST non-2xx", {
				issueKey,
				cloudId: site.cloudId,
				status: res.status,
				body: errBody.slice(0, 256),
			});
			return {
				attachment: null,
				error: `attachment POST HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 160)}` : ""}`,
			};
		}
		const json = (await res.json().catch(() => null)) as Array<{
			id?: string;
			filename?: string;
		}> | null;
		if (!Array.isArray(json) || json.length === 0) {
			return {
				attachment: null,
				error: "attachment POST returned no items",
			};
		}
		const first = json[0];
		if (!first?.id || !first?.filename) {
			return {
				attachment: null,
				error: "attachment POST item missing id/filename",
			};
		}
		const siteBase = site.siteUrl.replace(/\/+$/, "");
		return {
			attachment: {
				id: first.id,
				filename: first.filename,
				contentUrl: `${siteBase}/secure/attachment/${first.id}/${encodeURIComponent(first.filename)}`,
			},
			error: null,
		};
	} catch (err) {
		const msg = `upload threw (${err instanceof Error ? err.message : String(err)})`;
		logger.warn("[Jira Cloud] uploadOneImageToJira threw", {
			issueKey,
			error: err instanceof Error ? err.message : String(err),
		});
		return { attachment: null, error: msg };
	}
}

/**
 * Scan a markdown description for image references, upload each to
 * Jira via REST attachment API, and return the rewritten description
 * with image src swapped for site-direct `/secure/attachment/{id}/{filename}`
 * URLs. Falls through unchanged on any failure (per-image).
 *
 * Handles both shapes:
 *   - `![alt](src)` markdown
 *   - `<img src="src" ...>` HTML survivors
 *
 * `site` is the issue's OWN site (from `resolveIssueSite`) — uploads and
 * the rewritten `/secure/attachment/` URLs both target it, so multi-site
 * accounts hit the right tenant.
 *
 * Skips:
 *   - data: URLs unless `includeDataUrls` is true (default: true — the
 *     primary use case is replacing base64 with attachments)
 *   - already-attached URLs matching `${site.siteUrl}/secure/attachment/`
 *   - non-HTTP/non-data: URLs
 */
export async function uploadJiraImagesAndRewriteDescription(
	description: string,
	target: JiraCloudTarget,
	site: JiraCloudResource,
	issueKey: string,
	options: { includeDataUrls?: boolean } = {},
): Promise<{
	description: string;
	uploaded: number;
	skipped: number;
	failed: number;
	/** Per-image failure reasons (status/body) — surfaced to lastPmSyncError so
	 *  a swallowed upload failure is diagnosable instead of a silent SUCCESS. */
	errors: string[];
}> {
	if (!description) {
		return { description, uploaded: 0, skipped: 0, failed: 0, errors: [] };
	}
	const includeDataUrls = options.includeDataUrls ?? true;
	const siteBase = site.siteUrl.replace(/\/+$/, "");
	const sources: string[] = [];
	const seen = new Set<string>();
	const collect = (src: string) => {
		if (!src) {
			return;
		}
		if (seen.has(src)) {
			return;
		}
		if (src.startsWith(`${siteBase}/secure/attachment/`)) {
			return;
		}
		if (/^data:/i.test(src)) {
			if (!includeDataUrls) {
				return;
			}
		} else if (!/^https?:\/\//i.test(src)) {
			return;
		}
		seen.add(src);
		sources.push(src);
	};
	const mdRe = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
	const htmlRe = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
	let m: RegExpExecArray | null;
	while ((m = mdRe.exec(description)) !== null) {
		const url = m[2];
		if (url) {
			collect(url);
		}
	}
	while ((m = htmlRe.exec(description)) !== null) {
		const url = m[1];
		if (url) {
			collect(url);
		}
	}

	if (sources.length === 0) {
		return { description, uploaded: 0, skipped: 0, failed: 0, errors: [] };
	}

	let uploaded = 0;
	let failed = 0;
	const errors: string[] = [];
	const map = new Map<string, string>();
	await Promise.all(
		sources.map(async (src, idx) => {
			const hint = `screenshot-${(idx + 1).toString().padStart(3, "0")}.png`;
			const { attachment, error } = await uploadOneImageToJiraDetailed(
				target,
				site,
				issueKey,
				src,
				hint,
			);
			if (attachment) {
				map.set(src, attachment.contentUrl);
				uploaded += 1;
			} else {
				failed += 1;
				if (error) {
					errors.push(error);
				}
			}
		}),
	);

	if (map.size === 0) {
		return { description, uploaded, skipped: 0, failed, errors };
	}

	let result = description;
	for (const [src, newSrc] of map.entries()) {
		result = result.split(src).join(newSrc);
	}
	return { description: result, uploaded, skipped: 0, failed, errors };
}

// =============================================================================
// Jira inline image rendering via ADF media nodes
// =============================================================================
//
// Uploading the image as an attachment only makes it show in the issue's
// Attachments panel. To render it INLINE in the description body, Jira Cloud
// requires an ADF `media` node referencing the attachment's media-services file
// id — a raw `<img src="...">` (or external URL) is shown as literal text by
// ADF and never renders. So: upload → resolve media id → strip the raw `<img>`
// from the body → append an ADF `mediaSingle` node and PUT the description via
// the Cloud REST API (which also bypasses the Rovo `editJiraIssue` "fields"
// limitation).

/**
 * Remove `<img>` tags and `![alt](url)` markdown images from a body, returning
 * the cleaned text plus the image source URLs in document order.
 */
export function stripImagesForJira(content: string): {
	text: string;
	srcs: string[];
} {
	if (!content) {
		return { text: content, srcs: [] };
	}
	const srcs: string[] = [];
	let text = content.replace(/<img\b[^>]*>/gi, (tag) => {
		const m = tag.match(/\bsrc=["']([^"']+)["']/i);
		if (m?.[1]) {
			srcs.push(m[1]);
		}
		return "";
	});
	text = text.replace(
		/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
		(_m, url: string) => {
			if (url) {
				srcs.push(url);
			}
			return "";
		},
	);
	text = text
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { text, srcs };
}

/**
 * Resolve the media-services file id for an uploaded Jira attachment — required
 * for an ADF `media` node. Atlassian exposes it only via the attachment
 * `content` endpoint's redirect `Location` (no direct lookup API). Node's fetch
 * (`redirect: "manual"`) exposes the 3xx `Location` header. Returns null on any
 * failure (the caller degrades to attachment-only).
 */
async function resolveJiraAttachmentMediaId(
	target: JiraCloudTarget,
	site: JiraCloudResource,
	attachmentId: string,
): Promise<string | null> {
	try {
		const url = `https://api.atlassian.com/ex/jira/${site.cloudId}/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`;
		const res = await fetch(url, {
			method: "GET",
			headers: { authorization: `Bearer ${target.accessToken}` },
			redirect: "manual",
		});
		const loc = res.headers.get("location") ?? "";
		const m = loc.match(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
		);
		if (!m) {
			logger.warn(
				"[Jira Cloud] could not resolve media id from attachment redirect",
				{ attachmentId, status: res.status, hasLocation: Boolean(loc) },
			);
			return null;
		}
		return m[0];
	} catch (err) {
		logger.warn("[Jira Cloud] resolveJiraAttachmentMediaId threw", {
			attachmentId,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * Upload `imageSrcs` to a Jira issue as attachments and embed them INLINE in
 * the description via ADF `mediaSingle/media` nodes. The body's `<img>` refs
 * must already be stripped (see {@link stripImagesForJira}) so the create call
 * shipped clean text; here we GET the resulting ADF, append a media node per
 * uploaded image, and PUT it back over the Cloud REST API. Never throws.
 */
export async function embedJiraImagesAsAdfMedia(
	imageSrcs: readonly string[],
	target: JiraCloudTarget,
	site: JiraCloudResource,
	issueKey: string,
): Promise<{ uploaded: number; failed: number; errors: string[] }> {
	const errors: string[] = [];
	let uploaded = 0;
	let failed = 0;
	const mediaIds: string[] = [];
	for (let i = 0; i < imageSrcs.length; i++) {
		const src = imageSrcs[i];
		if (!src) {
			continue;
		}
		if (!/^https?:\/\//i.test(src) && !/^data:/i.test(src)) {
			continue;
		}
		const hint = `screenshot-${(i + 1).toString().padStart(3, "0")}.png`;
		const { attachment, error } = await uploadOneImageToJiraDetailed(
			target,
			site,
			issueKey,
			src,
			hint,
		);
		if (!attachment) {
			failed += 1;
			if (error) {
				errors.push(error);
			}
			continue;
		}
		const mediaId = await resolveJiraAttachmentMediaId(
			target,
			site,
			attachment.id,
		);
		if (!mediaId) {
			failed += 1;
			errors.push(
				`attachment ${attachment.id} uploaded but media id unresolved`,
			);
			continue;
		}
		mediaIds.push(mediaId);
		uploaded += 1;
	}
	if (mediaIds.length === 0) {
		return { uploaded, failed, errors };
	}
	const base = `https://api.atlassian.com/ex/jira/${site.cloudId}/rest/api/3/issue/${encodeURIComponent(issueKey)}`;
	try {
		const getRes = await fetch(`${base}?fields=description`, {
			headers: {
				authorization: `Bearer ${target.accessToken}`,
				accept: "application/json",
			},
		});
		if (!getRes.ok) {
			errors.push(`GET description HTTP ${getRes.status}`);
			return { uploaded, failed, errors };
		}
		const getJson = (await getRes.json().catch(() => null)) as {
			fields?: { description?: unknown };
		} | null;
		const existing = getJson?.fields?.description as {
			type?: string;
			version?: number;
			content?: unknown[];
		} | null;
		const adf =
			existing &&
			existing.type === "doc" &&
			Array.isArray(existing.content)
				? existing
				: { type: "doc", version: 1, content: [] as unknown[] };
		for (const mediaId of mediaIds) {
			adf.content?.push({
				type: "mediaSingle",
				attrs: { layout: "center" },
				content: [
					{
						type: "media",
						attrs: { id: mediaId, type: "file", collection: "" },
					},
				],
			});
		}
		const putRes = await fetch(base, {
			method: "PUT",
			headers: {
				authorization: `Bearer ${target.accessToken}`,
				"content-type": "application/json",
				accept: "application/json",
			},
			body: JSON.stringify({ fields: { description: adf } }),
		});
		if (!putRes.ok) {
			const b = await putRes.text().catch(() => "");
			errors.push(
				`PUT description HTTP ${putRes.status}${b ? `: ${b.slice(0, 160)}` : ""}`,
			);
		}
	} catch (err) {
		errors.push(
			`ADF description update threw: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	return { uploaded, failed, errors };
}
