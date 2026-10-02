/**
 * Link-tab vocabulary shared by every owner of context sources: the URL form
 * schema, the scope auto-detect rule, bulk-paste parsing, the payload halves a
 * submit is built from, and the search-provider pre-flight helpers.
 *
 * Moved out of the project `ContextUploaderDialog` so a second owner (the
 * organization's company context) validates and submits a link exactly the
 * way a project does.
 */

import {
	KNOWLEDGE_BASE_SOURCE_CATEGORIES,
	type KnowledgeBaseSourceCategoryValue,
} from "@repo/api/modules/projects/procedures/contexts/knowledge-base-category.types";
import { z } from "zod";

// Link tab status indicator (Crawling / Indexed / Failed).
export type UploadStatus =
	| "idle"
	| "uploading"
	| "processing"
	| "success"
	| "error";

// ── URL Context Sources v2 (Group 7) ─────────────────────────────────────
//
// Spec: fabric/specs/2026-05-13-url-context-sources/spec.md §9.1 + §6.1
// Decisions: planning/decisions.md §7.2 (auto-detection rule table).
//
// The path-prefix auto-detect rule mirrors the procedure's accepted scope
// values verbatim — match exactly the doc-section patterns called out in
// the spec so the UI default matches what the workflow would derive after
// redirects.
const URL_SCOPE_VALUES = ["SINGLE_PAGE", "PATH_PREFIX"] as const;
const URL_REFRESH_MODE_VALUES = [
	"ONCE",
	"DAILY",
	"WEEKLY",
	"MONTHLY",
	"LIVE",
] as const;

export type UrlScope = (typeof URL_SCOPE_VALUES)[number];
export type UrlRefreshMode = (typeof URL_REFRESH_MODE_VALUES)[number];

// Defaults must match `DEFAULT_MAX_PAGES` / `MAX_MAX_PAGES` in
// `packages/api/modules/projects/procedures/contexts/process-context-link.ts`.
// Capped at 500 — see the same-named constants in
// process-context-link.ts and UrlSourcePageView.tsx for the rationale.
export const URL_MAX_PAGES_DEFAULT = 200;
export const URL_MAX_PAGES_MIN = 1;
export const URL_MAX_PAGES_MAX = 500;
export const URL_LABEL_MAX_LEN = 120;

// ── Bulk URL paste mode (Commit 4) ───────────────────────────────────────
//
// Per-batch cap on the multi-URL form. Each line goes through the existing
// single-URL `processLink` procedure (no batched server-side API), and the
// dialog fires N parallel calls via Promise.allSettled. 50 is large enough
// for nearly every paste-from-a-spreadsheet workflow while staying small
// enough that we don't blow up the dialog with hundreds of progress rows.
export const URL_BULK_MAX_LINES = 50;

// We surface only the first few invalid lines verbatim, then summarise the
// remainder with "... and N more". Keeps the live preview compact.
export const URL_BULK_INVALID_PREVIEW_LIMIT = 5;

// "Successfully added" summary stays visible for this long before the
// dialog auto-closes. Gives the user a chance to read the count without
// interrupting the workflow. ESC / Close button short-circuits it.
export const URL_BULK_SUCCESS_AUTOCLOSE_MS = 2_000;

export type BulkUrlsMode = "SINGLE" | "MULTI";

interface BulkParsedLine {
	raw: string;
	url: string | null;
	lineNumber: number; // 1-indexed for human-readable error display
	error: string | null;
}

export interface BulkSubmitResult {
	url: string;
	ok: boolean;
	error: string | null;
}

// Doc-section markers — anchored on `/` so a URL like `/products/help-center`
// does NOT spuriously match `/help/`. Order does not matter; we test all.
const URL_PATH_PREFIX_PATTERNS = [
	"/hc/",
	"/docs/",
	"/help/",
	"/kb/",
	"/guide/",
	"/learn/",
] as const;

/**
 * Auto-detect rule for the scope radio. Returns the suggested scope from the
 * URL alone — caller is free to override before submit.
 *
 * Logic:
 *   • URL path ends with `/`             → PATH_PREFIX
 *   • URL path contains a doc-section
 *     marker (`/hc/`, `/docs/`, `/help/`,
 *     `/kb/`, `/guide/`, `/learn/`)      → PATH_PREFIX
 *   • Anything else                       → SINGLE_PAGE
 *
 * Invalid URL strings (parse failure) return `SINGLE_PAGE` so the form does
 * not silently flip scope when the user hasn't finished typing.
 */
export function detectUrlScope(rawUrl: string): UrlScope {
	return detectUrlScopeMatch(rawUrl).scope;
}

/**
 * Auto-detect rule that also surfaces *why* PATH_PREFIX was picked, so the
 * UI can display a small inline hint after the blur flip ("Detected
 * path-prefix from your URL (/docs/)"). Returns `matchedPattern: null` when
 * the result is SINGLE_PAGE or when the rule could not parse the URL.
 *
 * The matched pattern is either one of `URL_PATH_PREFIX_PATTERNS` verbatim
 * or the literal `"trailing slash"` for the path-ends-with-`/` rule.
 */
export function detectUrlScopeMatch(rawUrl: string): {
	scope: UrlScope;
	matchedPattern: string | null;
} {
	try {
		const u = new URL(rawUrl);
		const path = u.pathname;
		if (path.endsWith("/") && path !== "/") {
			return { scope: "PATH_PREFIX", matchedPattern: "trailing slash" };
		}
		for (const marker of URL_PATH_PREFIX_PATTERNS) {
			if (path.includes(marker)) {
				return { scope: "PATH_PREFIX", matchedPattern: marker };
			}
		}
		return { scope: "SINGLE_PAGE", matchedPattern: null };
	} catch {
		return { scope: "SINGLE_PAGE", matchedPattern: null };
	}
}

// Mirrors the API procedure's zod refinement so client and server stay in
// lock-step on what counts as a valid URL source.
const URL_REGEX_CREDENTIALED = /^https?:\/\/[^/]*@/;

export const urlSourceFormSchema = z.object({
	url: z
		.string()
		.url({ message: "Enter a valid URL (https://...)." })
		.refine((u) => u.startsWith("https://"), {
			message: "URL must use https://",
		})
		.refine((u) => !URL_REGEX_CREDENTIALED.test(u), {
			message:
				"URL must be public; remove embedded credentials (user:pass@).",
		}),
	label: z.string().max(URL_LABEL_MAX_LEN).optional(),
	scope: z.enum(URL_SCOPE_VALUES),
	maxPages: z
		.number()
		.int()
		.min(URL_MAX_PAGES_MIN)
		.max(URL_MAX_PAGES_MAX)
		.optional(),
	refreshMode: z.enum(URL_REFRESH_MODE_VALUES),
	// Optional here, required at submit when the readiness feature is on — see
	// `missingCategoryError`. The schema cannot express "required only when a
	// flag is set" without being rebuilt per render, and the type it produces is
	// the shape the whole form is written against.
	knowledgeBaseSourceCategory: z
		.enum(KNOWLEDGE_BASE_SOURCE_CATEGORIES)
		.optional(),
	knowledgeBaseSourceCategoryOther: z.string().max(200).optional(),
	// Context Source Type Labeling (#1888). Optional; stripped from the
	// payload when the feature flag is off (see sourceMetadataPayload).
	sourceType: z.string().trim().min(1).max(80).optional(),
	aiInstructions: z.string().trim().max(500).optional(),
});

export type UrlSourceFormValues = z.infer<typeof urlSourceFormSchema>;

/**
 * The category rules, applied identically to a single URL and to a bulk paste
 * (one category covers the batch, the same way scope and refresh do).
 *
 * Returns the field errors to show, or null when the form may be submitted.
 * Off entirely when the readiness feature is off, so the link flow is unchanged
 * for anyone not running it.
 */
export function knowledgeBaseCategoryErrors(
	values: UrlSourceFormValues,
	required: boolean,
): Partial<Record<keyof UrlSourceFormValues, string>> | null {
	if (!required) {
		return null;
	}
	if (!values.knowledgeBaseSourceCategory) {
		return {
			knowledgeBaseSourceCategory:
				"Select what kind of source this is so Fabric can classify it.",
		};
	}
	if (
		values.knowledgeBaseSourceCategory === "OTHER" &&
		!values.knowledgeBaseSourceCategoryOther?.trim()
	) {
		return {
			knowledgeBaseSourceCategoryOther:
				"Describe the source when the category is Other.",
		};
	}
	return null;
}

/**
 * The category half of a processLink payload. Omits both fields entirely when
 * nothing was chosen, so a request from a build with the feature off is byte-
 * identical to what it sent before.
 */
export function knowledgeBaseCategoryPayload(values: UrlSourceFormValues): {
	knowledgeBaseSourceCategory?: KnowledgeBaseSourceCategoryValue;
	knowledgeBaseSourceCategoryOther?: string;
} {
	if (!values.knowledgeBaseSourceCategory) {
		return {};
	}
	const other = values.knowledgeBaseSourceCategoryOther?.trim();
	return {
		knowledgeBaseSourceCategory: values.knowledgeBaseSourceCategory,
		...(values.knowledgeBaseSourceCategory === "OTHER" && other
			? { knowledgeBaseSourceCategoryOther: other }
			: {}),
	};
}

/**
 * The type-label half of a processLink payload (Fizzy #1888). Omits both
 * fields entirely when unset, so the request for an unlabeled source is
 * byte-identical to what it sent before.
 */
export function sourceMetadataPayload(values: UrlSourceFormValues): {
	sourceType?: string;
	aiInstructions?: string;
} {
	const sourceType = values.sourceType?.trim();
	const aiInstructions = values.aiInstructions?.trim();
	return {
		...(sourceType ? { sourceType } : {}),
		...(aiInstructions ? { aiInstructions } : {}),
	};
}

// Mirrors the URL refinement above. Kept as its own schema so the multi-URL
// form can validate one line at a time and surface a per-line error without
// reaching into the full-form schema (which carries scope/maxPages/etc).
const urlSourceBulkLineSchema = z.object({
	url: z
		.string()
		.url({ message: "Not a valid URL" })
		.refine((u) => u.startsWith("https://"), {
			message: "Must use https://",
		})
		.refine((u) => !URL_REGEX_CREDENTIALED.test(u), {
			message: "Credentialed URLs (user:pass@) are rejected",
		}),
});

/**
 * Build the normalisation key used by `parseBulkUrlLines` to detect
 * duplicate-but-different-looking URL inputs. The key folds:
 *
 *   - host case (`X.COM` → `x.com`)
 *   - a single trailing slash on the pathname (`/docs/` → `/docs`),
 *     keeping bare root `/` as `/`
 *
 * Search query + hash fragment are kept AS-IS — `?lang=en` vs `?lang=fr`
 * is a genuinely different page in many doc sites, and collapsing them
 * here would silently drop entries the user wanted indexed.
 *
 * Returns the raw URL when parsing fails so invalid entries don't
 * collide with each other through the normalisation path.
 */
function normaliseUrlForDedupe(raw: string): string {
	try {
		const u = new URL(raw);
		const host = u.host.toLowerCase();
		let pathname = u.pathname;
		if (pathname.length > 1 && pathname.endsWith("/")) {
			pathname = pathname.slice(0, -1);
		}
		return `${u.protocol}//${host}${pathname}${u.search}${u.hash}`;
	} catch {
		return raw;
	}
}

/**
 * Parse a textarea value into bulk-URL entries. Strips whitespace, skips
 * empty lines, applies the single-URL zod validator per-line. Successful
 * entries are deduped on a normalised key (lowercase host, trailing-slash-
 * stripped pathname, query + fragment AS-IS). Invalid lines are kept
 * verbatim so the user sees their original mistake.
 *
 * The `URL_BULK_MAX_LINES` cap is *not* enforced here — the caller decides
 * what to do with an oversized batch (we render a friendly inline note and
 * disable submit rather than silently dropping lines).
 *
 * Returns the array of `BulkParsedLine` entries in original line order
 * (with duplicate-suppressed entries removed from the valid stream — the
 * caller can count `parseBulkUrlLines(raw).length` vs the raw line count
 * to surface how many were dropped, but a simpler way is in
 * `summariseBulkParse` below).
 */
export function parseBulkUrlLines(raw: string): BulkParsedLine[] {
	const lines = raw.split(/\r?\n/);
	const out: BulkParsedLine[] = [];
	const seenKeys = new Set<string>();
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed.length === 0) {
			continue;
		}
		const lineNumber = i + 1;
		const parsed = urlSourceBulkLineSchema.safeParse({ url: trimmed });
		if (parsed.success) {
			const key = normaliseUrlForDedupe(parsed.data.url);
			if (seenKeys.has(key)) {
				continue;
			}
			seenKeys.add(key);
			out.push({
				raw: trimmed,
				url: parsed.data.url,
				lineNumber,
				error: null,
			});
		} else {
			const message = parsed.error.issues[0]?.message ?? "Invalid URL";
			out.push({
				raw: trimmed,
				url: null,
				lineNumber,
				error: message,
			});
		}
	}
	return out;
}

/**
 * Summary counts derived from a parsed bulk-paste input. Exposes:
 *   - `valid`      — entries that passed validation AND survived dedupe.
 *   - `invalid`    — lines the per-line zod schema rejected.
 *   - `duplicates` — valid lines suppressed by dedupe. Equals
 *                    (raw non-blank lines − valid − invalid).
 *
 * The UI surfaces `duplicates` as "M duplicates skipped" so the user
 * understands their textarea doesn't 1:1 with the count of LINK rows
 * about to be created.
 *
 * Exported for unit testability + reuse from the live-preview output.
 */
export function summariseBulkParse(raw: string): {
	valid: number;
	invalid: number;
	duplicates: number;
} {
	const parsed = parseBulkUrlLines(raw);
	const valid = parsed.filter((l) => l.url !== null).length;
	const invalid = parsed.filter((l) => l.url === null).length;
	// Count non-blank raw lines so the diff vs `parsed.length` is the
	// dedupe drop count. Cheaper than re-running the parse in a second
	// branch.
	const nonBlankLines = raw
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0).length;
	const duplicates = Math.max(0, nonBlankLines - valid - invalid);
	return { valid, invalid, duplicates };
}

// ── Provider routing — multi-provider (commit 3 of 3) ────────────────────
//
// URL contexts now route to any scrape-capable search provider configured
// for the tenant. The pre-flight reads the unified `searchProviders.get*`
// rows the same way commit 1 did, but accepts Firecrawl / Jina / Tavily /
// Exa as equivalent. PATH_PREFIX still requires Firecrawl (only crawl-
// capable provider in v1.1) — the scope radio gates on that separately.

export type UrlSourceProviderName =
	| "firecrawl"
	| "jina"
	| "tavily"
	| "exa"
	| "parallel";

const SCRAPE_CAPABLE_PROVIDERS: readonly UrlSourceProviderName[] = [
	"firecrawl",
	"jina",
	"tavily",
	"exa",
] as const;

const CRAWL_CAPABLE_PROVIDERS: readonly UrlSourceProviderName[] = [
	"firecrawl",
] as const;

export const PROVIDER_DISPLAY_NAMES: Record<UrlSourceProviderName, string> = {
	firecrawl: "Firecrawl",
	jina: "Jina AI",
	tavily: "Tavily",
	exa: "Exa",
	parallel: "Parallel",
};

function isScrapeCapable(name: string): name is UrlSourceProviderName {
	return SCRAPE_CAPABLE_PROVIDERS.includes(name as UrlSourceProviderName);
}

function isCrawlCapable(name: string): name is UrlSourceProviderName {
	return CRAWL_CAPABLE_PROVIDERS.includes(name as UrlSourceProviderName);
}

/**
 * BAD_REQUEST data payloads the procedure can return. The legacy
 * `FIRECRAWL_NOT_CONFIGURED` shape stays handled so older clients/servers
 * continue to render the notice. The new codes carry the same `settingsPath`
 * surface so the UI's notice card is unchanged.
 */
type ProviderNotConfiguredCode =
	| "FIRECRAWL_NOT_CONFIGURED"
	| "SCRAPE_PROVIDER_NOT_CONFIGURED"
	| "CRAWL_PROVIDER_NOT_CONFIGURED";

export interface ProviderNotConfiguredData {
	code: ProviderNotConfiguredCode;
	settingsPath?: string;
}

export function isProviderNotConfiguredError(
	err: unknown,
): err is { data: ProviderNotConfiguredData; message?: string } {
	if (typeof err !== "object" || err === null) {
		return false;
	}
	const data = (err as { data?: unknown }).data;
	if (typeof data !== "object" || data === null) {
		return false;
	}
	const code = (data as { code?: unknown }).code;
	return (
		code === "FIRECRAWL_NOT_CONFIGURED" ||
		code === "SCRAPE_PROVIDER_NOT_CONFIGURED" ||
		code === "CRAWL_PROVIDER_NOT_CONFIGURED"
	);
}

/**
 * Mirror of the server-side picker in `get-web-scraper.ts`. Given the list
 * of enabled providers, return the one the server *would* pick. Used by the
 * "Indexing with X" indicator so the UI matches what actually runs.
 */
export function pickPreferredProvider<
	P extends {
		providerName: string;
		enabled: boolean;
		maskedApiKey: string | null;
		isDefault: boolean;
		priority: number;
	},
>(providers: P[], requireCrawl: boolean): P | null {
	const filter = requireCrawl ? isCrawlCapable : isScrapeCapable;
	for (const provider of providers) {
		if (!provider.enabled || !provider.maskedApiKey) {
			continue;
		}
		if (!filter(provider.providerName)) {
			continue;
		}
		return provider;
	}
	return null;
}
