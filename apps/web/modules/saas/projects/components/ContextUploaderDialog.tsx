"use client";

import { useAnalytics } from "@analytics";
import {
	KNOWLEDGE_BASE_SOURCE_CATEGORIES,
	type KnowledgeBaseSourceCategoryValue,
} from "@repo/api/modules/projects/procedures/contexts/knowledge-base-category.types";
import {
	CONTEXT_UPLOAD_ACCEPT_ATTR,
	contextUploadConfigFor,
	resolveContextUploadCategory,
	resolveContextUploadMime,
	UPLOAD_SIZE_LIMITS,
} from "@repo/utils";
import { isValidExcalidrawContent } from "@repo/utils/attachment";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { KNOWLEDGE_BASE_CATEGORY_OPTIONS } from "@saas/projects/lib/knowledge-base-categories";
import { useSettingsReturnUrl } from "@saas/settings/hooks/use-settings-return-url";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import {
	LiveAnnouncerRegion,
	useLiveAnnouncer,
} from "@saas/shared/components/LiveAnnouncer";
import { isMonitoringFeatureEnabled } from "@saas/shared/lib/feature-flags";
import { ConfluenceIcon } from "@saas/workflows/lib/plugins/confluence/icon";
import { GoogleDriveIcon } from "@saas/workflows/lib/plugins/google-drive/icon";
import { MicrosoftTeamsIcon } from "@saas/workflows/lib/plugins/microsoft-teams/icon";
import { TruncatedText } from "@shared/components/TruncatedText";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	CheckCircleIcon,
	CheckIcon,
	FileIcon,
	FileSpreadsheetIcon,
	FileTextIcon,
	ImageIcon,
	LinkIcon,
	LoaderIcon,
	MinusIcon,
	PlusIcon,
	SettingsIcon,
	SparklesIcon,
	TextIcon,
	UploadCloudIcon,
	XCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { isConfluenceMcpConfig } from "../lib/confluence-mcp-config";
import {
	CONTEXT_UPLOAD_FORMATS_AND_LIMITS,
	oversizeReason,
	unsupportedTypeReason,
} from "../lib/context-upload-copy";
import { DOCUMENT_TAG_OPTIONS } from "../lib/document-tag-options";
import { ConfluenceResourceBrowser } from "./ConfluenceResourceBrowser";
import { CONTEXT_SOURCE_TYPE_PRESETS } from "./ContextSourceDetailsDialog";
import { GoogleDocsSelectorDialog } from "./GoogleDocsSelectorDialog";
import { NotionResourceBrowser } from "./NotionResourceBrowser";
import { SlackChannelSelectorDialog } from "./SlackChannelSelectorDialog";
import { TeamsChatSelectorDialog } from "./TeamsChatSelectorDialog";

// Props.projectId is REQUIRED and stays required. The wizard pre-creation
// surface passes the DRAFT project's real `projectId` (Q1 DRAFT-as-host
// binding from the Unified Context Uploader Wizard spec §7.2). We
// deliberately do NOT add an optional `sessionId` prop here — both wizard
// and post-creation surfaces write directly to `ProjectContext` against
// the DRAFT/ACTIVE projectId. `WizardTempContext` is intentionally
// bypassed by the wizard surface after that spec.
type Props = {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * Hosting surface tag used solely for telemetry routing on the new
	 * `project_context_added_during_wizard` event (spec
	 * `2026-05-23-unified-context-uploader-wizard` §9.2). The dialog
	 * behaves identically in both surfaces — the value is read-only inside
	 * the success branches that fire `trackEvent`.
	 *
	 * Defaults to `"post-creation"` so existing post-creation callers
	 * (project detail page, settings, etc.) keep their pre-spec behaviour
	 * without touching every call site. The wizard mount in
	 * `BasicInfoStep` passes `surface="wizard"` explicitly to drive the
	 * post-launch validation question: _does moving the entry point into
	 * the wizard actually drive more pre-creation context attachment?_
	 */
	surface?: "wizard" | "post-creation";
};

type UploadStatus = "idle" | "uploading" | "processing" | "success" | "error";

// Per-file row shape for the multi-file upload list. Mirrors the
// `UploadedFile` shape from `WizardFileUploader.tsx:24-34` (status / progress
// vocabulary) so a future cross-component visual refactor stays mechanical.
// Spec ref: 2026-05-23-unified-context-uploader-wizard/spec.md §7.1.
type FileUploadRowStatus =
	| "queued"
	| "uploading"
	| "processing"
	| "completed"
	| "failed";

type UploadedFileRow = {
	id: string;
	file: File;
	name: string;
	size: number;
	/** What the browser claimed, or the octet-stream placeholder when it claimed nothing. */
	mimeType: string;
	status: FileUploadRowStatus;
	error?: string;
};

// Supported-format copy is derived from the shared vocabulary and lives in
// `../lib/context-upload-copy` — the wizard's own uploader renders the same
// sentences, and two derivations of one sentence is the drift a single
// derivation exists to prevent.

// Notion icon component.
//
// `aria-hidden="true"` because every render site in this file pairs the icon
// with a visible "Notion" text label (the tab label, the Notion Integration
// heading, the "Browse Notion Pages" button). The previous labeled-SVG variant
// caused the accessible name to compute as "NotionNotion" (icon-title +
// adjacent text), surfaced during staging Phase 2.A — anomaly A-2. Matches
// the SlackIcon pattern below + the canonical pattern in
// `marketing/home/components/BrandIcons.tsx#NotionIcon`.
function NotionIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.98-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466l1.823 1.447zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.84-.046.933-.56.933-1.167V6.354c0-.606-.233-.933-.746-.886l-15.177.887c-.56.046-.747.326-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.746 0-.933-.234-1.495-.933l-4.577-7.186v6.952l1.447.327s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.14c-.093-.514.28-.886.747-.933l3.222-.186zM2.077 1.028l13.681-.933c1.68-.14 2.1.093 2.8.606l3.876 2.754c.467.327.607.42.607.98v15.37c0 .96-.373 1.494-1.68 1.587l-15.458.934c-.98.047-1.447-.093-1.96-.747L.787 18.2c-.56-.7-.794-1.26-.794-1.96V2.42c0-.84.374-1.346 1.167-1.4l.917.008z" />
		</svg>
	);
}

// Slack icon component
function SlackIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
			xmlns="http://www.w3.org/2000/svg"
			aria-hidden="true"
		>
			<path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
		</svg>
	);
}

// Static base list — full superset of tab IDs. The Google Docs tab is
// rendered (in both the tablist and the panels) only when its kill-switch
// flag is on. Keeping all IDs in the type lets `activeTab === "google-docs"`
// stay a real union member rather than a string drift.
const allTabs = [
	{ id: "file", label: "File", icon: FileIcon },
	{ id: "link", label: "Link", icon: LinkIcon },
	{ id: "text", label: "Text", icon: TextIcon },
	{ id: "teams", label: "Teams", icon: MicrosoftTeamsIcon },
	{ id: "slack", label: "Slack", icon: SlackIcon },
	{ id: "notion", label: "Notion", icon: NotionIcon },
	{ id: "confluence", label: "Confluence", icon: ConfluenceIcon },
	{ id: "google-docs", label: "Google Docs", icon: GoogleDriveIcon },
] as const;

type TabId = (typeof allTabs)[number]["id"];

// File type icons
function getFileIcon(mimeType: string) {
	if (mimeType.includes("image")) {
		return ImageIcon;
	}
	if (
		mimeType.includes("spreadsheet") ||
		mimeType.includes("csv") ||
		mimeType.includes("excel")
	) {
		return FileSpreadsheetIcon;
	}
	return FileTextIcon;
}

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

type UrlScope = (typeof URL_SCOPE_VALUES)[number];
type UrlRefreshMode = (typeof URL_REFRESH_MODE_VALUES)[number];

// Defaults must match `DEFAULT_MAX_PAGES` / `MAX_MAX_PAGES` in
// `packages/api/modules/projects/procedures/contexts/process-context-link.ts`.
// Capped at 500 — see the same-named constants in
// process-context-link.ts and UrlSourcePageView.tsx for the rationale.
const URL_MAX_PAGES_DEFAULT = 200;
const URL_MAX_PAGES_MIN = 1;
const URL_MAX_PAGES_MAX = 500;
const URL_LABEL_MAX_LEN = 120;

// ── Bulk URL paste mode (Commit 4) ───────────────────────────────────────
//
// Per-batch cap on the multi-URL form. Each line goes through the existing
// single-URL `processLink` procedure (no batched server-side API), and the
// dialog fires N parallel calls via Promise.allSettled. 50 is large enough
// for nearly every paste-from-a-spreadsheet workflow while staying small
// enough that we don't blow up the dialog with hundreds of progress rows.
const URL_BULK_MAX_LINES = 50;

// We surface only the first few invalid lines verbatim, then summarise the
// remainder with "... and N more". Keeps the live preview compact.
const URL_BULK_INVALID_PREVIEW_LIMIT = 5;

// "Successfully added" summary stays visible for this long before the
// dialog auto-closes. Gives the user a chance to read the count without
// interrupting the workflow. ESC / Close button short-circuits it.
const URL_BULK_SUCCESS_AUTOCLOSE_MS = 2_000;

type BulkUrlsMode = "SINGLE" | "MULTI";

interface BulkParsedLine {
	raw: string;
	url: string | null;
	lineNumber: number; // 1-indexed for human-readable error display
	error: string | null;
}

interface BulkSubmitResult {
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
function detectUrlScopeMatch(rawUrl: string): {
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

const urlSourceFormSchema = z.object({
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

type UrlSourceFormValues = z.infer<typeof urlSourceFormSchema>;

/**
 * The category rules, applied identically to a single URL and to a bulk paste
 * (one category covers the batch, the same way scope and refresh do).
 *
 * Returns the field errors to show, or null when the form may be submitted.
 * Off entirely when the readiness feature is off, so the link flow is unchanged
 * for anyone not running it.
 */
function knowledgeBaseCategoryErrors(
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
function knowledgeBaseCategoryPayload(values: UrlSourceFormValues): {
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
function sourceMetadataPayload(values: UrlSourceFormValues): {
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
function summariseBulkParse(raw: string): {
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

type UrlSourceProviderName =
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

const PROVIDER_DISPLAY_NAMES: Record<UrlSourceProviderName, string> = {
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

interface ProviderNotConfiguredData {
	code: ProviderNotConfiguredCode;
	settingsPath?: string;
}

function isProviderNotConfiguredError(
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
function pickPreferredProvider<
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

export function ContextUploaderDialog({
	projectId,
	open,
	onOpenChange,
	surface = "post-creation",
}: Props) {
	const _t = useTranslations();
	const t = useTranslations("tooltips.contextSources");
	const queryClient = useQueryClient();

	// Visible tab set — drop the Google Docs tab when its kill-switch is off.
	// Computed each render so a flag flip (env-driven, build-time today) is
	// picked up without further plumbing.
	const tabs = useMemo(
		() =>
			isMonitoringFeatureEnabled("feature-google-docs-context")
				? allTabs
				: allTabs.filter((tab) => tab.id !== "google-docs"),
		[],
	);

	const [activeTab, setActiveTab] = useState<TabId>("file");
	const [googleDocsDialogOpen, setGoogleDocsDialogOpen] = useState(false);

	// File upload state — multi-file. Files accumulate on drop /
	// pick; submit fans out as N parallel `createUploadUrl → PUT → processFile`
	// round-trips via Promise.allSettled (mirrors bulk-URL pattern at
	// `handleUrlBulkAdd` below). `fileTitle` / `fileDocumentTag` apply to all
	// queued files (per spec §7.1 — multi-file is "drop a batch", not a
	// per-file editor; granular title editing would warrant a richer surface).
	const [files, setFiles] = useState<UploadedFileRow[]>([]);
	const [fileTitle, setFileTitle] = useState("");
	const [fileDocumentTag, setFileDocumentTag] = useState<string>("");
	const [isDragOver, setIsDragOver] = useState(false);
	// Queue-time refusals insert a row that is *already* failed. A newly
	// inserted node is not an update to a live region, so screen readers stay
	// silent on it — this pre-mounted region is what carries the refusal.
	const { announcement, announce } = useLiveAnnouncer();
	// Tracks whether the queue is actively uploading. `false` until handler
	// fires the first round-trip, then resets to `false` once Promise.allSettled
	// resolves.
	const [isBatchUploading, setIsBatchUploading] = useState(false);

	// Link tab status indicator (Crawling / Indexed / Failed).
	const [linkStatus, setLinkStatus] = useState<UploadStatus>("idle");

	// Link form state — URL Context Sources (Group 7). One state object so the
	// scope auto-detect on URL blur stays atomic with the form value the
	// submit handler reads.
	const [urlFormValues, setUrlFormValues] = useState<UrlSourceFormValues>({
		url: "",
		label: "",
		scope: "SINGLE_PAGE",
		maxPages: URL_MAX_PAGES_DEFAULT,
		refreshMode: "ONCE",
		// No default category, deliberately: a pre-selected one would be a guess
		// recorded as an answer.
		knowledgeBaseSourceCategory: undefined,
		knowledgeBaseSourceCategoryOther: "",
	});
	// Classifying a link source only exists as a requirement alongside the
	// readiness checklist that consumes it. With the flag off this whole field
	// is absent and the link flow behaves exactly as it did before.
	const requireKnowledgeBaseCategory = useFeatureFlag("PROJECT_READINESS");
	// Tracks whether the user has explicitly clicked a scope radio. Once they
	// have, we stop auto-detecting on blur so we don't fight the user.
	const [urlScopeUserOverridden, setUrlScopeUserOverridden] = useState(false);
	const [urlFormErrors, setUrlFormErrors] = useState<
		Partial<Record<keyof UrlSourceFormValues, string>>
	>({});
	const [urlSubmitNoticeOverride, setUrlSubmitNoticeOverride] =
		useState<ProviderNotConfiguredData | null>(null);

	// ── Bulk URL paste mode state (Commit 4) ─────────────────────────────
	// Mode toggle between Single URL and Multiple URLs. Default to SINGLE so
	// the form opens to the familiar single-URL UX; user opts into the paste
	// view explicitly.
	const [urlBulkMode, setUrlBulkMode] = useState<BulkUrlsMode>("SINGLE");
	// Raw textarea contents. Parsed live (memoised in the tab content) so
	// the live preview, submit-enabled state, and the URL count on the
	// button stay in lock-step with what the user typed.
	const [urlBulkRaw, setUrlBulkRaw] = useState("");
	// Per-URL progress + summary for the multi-URL submit. Driven by the
	// Promise.allSettled handler below; the in-dialog progress card reads
	// `submitted` / `total`, and the post-settle summary reads `results`.
	const [urlBulkProgress, setUrlBulkProgress] = useState<{
		total: number;
		submitted: number;
	} | null>(null);
	const [urlBulkResults, setUrlBulkResults] = useState<
		BulkSubmitResult[] | null
	>(null);

	// Teams dialog state
	const [teamsDialogOpen, setTeamsDialogOpen] = useState(false);

	// Slack dialog state
	const [slackDialogOpen, setSlackDialogOpen] = useState(false);

	// Notion dialog state
	const [notionDialogOpen, setNotionDialogOpen] = useState(false);
	const [selectedNotionMcpConfigId, setSelectedNotionMcpConfigId] = useState<
		string | null
	>(null);

	// Confluence dialog state
	const [confluenceDialogOpen, setConfluenceDialogOpen] = useState(false);
	const [selectedConfluenceMcpConfigId, setSelectedConfluenceMcpConfigId] =
		useState<string | null>(null);

	// Get organization context
	const { organizationId, organizationSlug, basePath } =
		useOrganizationContext();
	const buildReturnUrl = useSettingsReturnUrl();

	// Analytics — Group 7.4 wires `project_context_url_added` on the URL
	// submit success branch. Group 10 audits the four events; payload shape
	// per spec §13.
	const { trackEvent } = useAnalytics();

	// Search-provider pre-flight.
	// Reads the unified search-providers table — the same rows `processLink`
	// reads server-side. Returns:
	//   - `scrapeProvider`: picked provider for SINGLE_PAGE / fallback.
	//   - `crawlProvider`: picked provider for PATH_PREFIX (Firecrawl only).
	//   - `hasAnyScrapeCapable`: true ⇔ any enabled Firecrawl/Jina/Tavily/Exa
	//     row exists (drives the notice gate).
	//   - `hasCrawlCapable`: true ⇔ Firecrawl is enabled (drives the
	//     PATH_PREFIX radio gate).
	// Refetch on window focus and re-mount so a user who toggles a key in
	// another tab sees the notice update without a full reload.
	const providersConfigQuery = useQuery({
		queryKey: [
			"url-source-providers-preflight",
			organizationId ?? "personal",
		],
		queryFn: async () => {
			const providers = organizationId
				? await orpcClient.searchProviders.getOrganizationProviders({
						organizationId,
					})
				: await orpcClient.searchProviders.getUserProviders();
			const scrapeProvider = pickPreferredProvider(providers, false);
			const crawlProvider = pickPreferredProvider(providers, true);
			return {
				hasAnyScrapeCapable: scrapeProvider !== null,
				hasCrawlCapable: crawlProvider !== null,
				scrapeProviderName: (scrapeProvider?.providerName ??
					null) as UrlSourceProviderName | null,
				crawlProviderName: (crawlProvider?.providerName ??
					null) as UrlSourceProviderName | null,
			};
		},
		refetchOnWindowFocus: true,
		// Only run when the dialog is open so we don't fetch eagerly on every
		// mount of the parent contexts list.
		enabled: open,
	});

	const hasAnyScrapeCapable =
		providersConfigQuery.data?.hasAnyScrapeCapable ?? false;
	const hasCrawlCapable = providersConfigQuery.data?.hasCrawlCapable ?? false;
	const scrapeProviderName =
		providersConfigQuery.data?.scrapeProviderName ?? null;

	// Pre-built settings path for the notice CTA. The org slug determines
	// the prefix per spec §9.1 — `/app/settings/search-providers` for
	// personal, `/app/{slug}/settings/search-providers` for org.
	const searchProvidersSettingsPath = useMemo(() => {
		return organizationSlug
			? `/app/${organizationSlug}/settings/search-providers`
			: "/app/settings/search-providers";
	}, [organizationSlug]);

	// If the BAD_REQUEST notice payload from the server includes its own
	// settingsPath (revoked-key case during submit), prefer that — it's
	// guaranteed to match the server's tenant-resolution. Otherwise fall back
	// to the client-derived one.
	const noticeSettingsPath =
		urlSubmitNoticeOverride?.settingsPath ?? searchProvidersSettingsPath;

	// Fetch MCP configs that have Notion tools
	const { data: notionMcpConfigs, isLoading: notionConfigsLoading } =
		useQuery({
			queryKey: ["mcp-configs-notion", organizationId],
			queryFn: async () => {
				// Fetch configs for current context (personal or org)
				const allConfigs = await orpcClient.mcp.configs.list({
					organizationId: organizationId ?? undefined,
				});

				// Also fetch personal configs if in org context
				let personalMcpConfigs: typeof allConfigs = [];
				if (organizationId) {
					try {
						personalMcpConfigs = await orpcClient.mcp.configs.list(
							{},
						);
					} catch {
						// Ignore personal config fetch errors
					}
				}

				const combinedConfigs = organizationId
					? [...allConfigs, ...personalMcpConfigs]
					: allConfigs;

				// Filter to configs that likely have Notion tools
				return combinedConfigs.filter(
					(cfg: (typeof allConfigs)[number]) => {
						if (!cfg.enabled) {
							return false;
						}
						const server = cfg.mcpServer;
						if (!server) {
							return false;
						}
						const key = server.key?.toLowerCase() || "";
						const name = server.name?.toLowerCase() || "";
						return (
							key.includes("notion") || name.includes("notion")
						);
					},
				);
			},
		});

	// Fetch existing Notion contexts for this project (to pass syncedPageIds)
	const { data: notionContexts } = useQuery({
		queryKey: ["project-notion-contexts", projectId],
		queryFn: async () => {
			const result = await orpcClient.projects.contexts.list({
				projectId,
				organizationId: organizationId ?? undefined,
			});
			// Filter to INTEGRATION type with Notion metadata, excluding PRD source
			return (result?.contexts || []).filter((ctx) => {
				if (ctx.type !== "INTEGRATION") {
					return false;
				}
				const metadata = ctx.metadata as Record<string, unknown>;
				if (!metadata?.notionPageId) {
					return false;
				}
				if (metadata?.isPrdSource) {
					return false;
				}
				return true;
			});
		},
	});

	// Fetch MCP configs that have Confluence tools. Detection uses the stable
	// linked-catalog signal (server tags / key "atlassian") — never the
	// user-editable config name (see `isConfluenceMcpConfig`).
	const { data: confluenceMcpConfigs, isLoading: confluenceConfigsLoading } =
		useQuery({
			queryKey: ["mcp-configs-confluence", organizationId],
			queryFn: async () => {
				const allConfigs = await orpcClient.mcp.configs.list({
					organizationId: organizationId ?? undefined,
				});

				let personalMcpConfigs: typeof allConfigs = [];
				if (organizationId) {
					try {
						personalMcpConfigs = await orpcClient.mcp.configs.list(
							{},
						);
					} catch {
						// Ignore personal config fetch errors
					}
				}

				const combinedConfigs = organizationId
					? [...allConfigs, ...personalMcpConfigs]
					: allConfigs;

				return combinedConfigs.filter(
					(cfg: (typeof allConfigs)[number]) =>
						cfg.enabled && isConfluenceMcpConfig(cfg),
				);
			},
		});

	// Fetch existing Confluence contexts for this project (to pass syncedPageIds)
	const { data: confluenceContexts } = useQuery({
		queryKey: ["project-confluence-contexts", projectId],
		queryFn: async () => {
			const result = await orpcClient.projects.contexts.list({
				projectId,
				organizationId: organizationId ?? undefined,
			});
			return (result?.contexts || []).filter((ctx) => {
				if (ctx.type !== "INTEGRATION") {
					return false;
				}
				const metadata = ctx.metadata as Record<string, unknown>;
				return !!metadata?.confluencePageId;
			});
		},
	});

	// Text state
	const [textTitle, setTextTitle] = useState("");
	const [textContent, setTextContent] = useState("");

	const createTextMutation = useMutation(
		orpc.projects.contexts.create.mutationOptions({
			onSuccess: () => {
				// Spec `2026-05-23-unified-context-uploader-wizard` §9.2:
				// fires on every successful TEXT submit. The Text tab's
				// only call site is `handleTextAdd` ⇒ one event per row,
				// matching the File / Link patterns above.
				trackEvent("project_context_added_during_wizard", {
					surface,
					contextType: "TEXT",
				});
				toast.success("Context added successfully");
				invalidateAndClose();
			},
			onError: (error) => {
				toast.error(`Failed to add context: ${error.message}`);
			},
		}),
	);

	const invalidateAndClose = () => {
		queryClient.invalidateQueries({
			queryKey: orpc.projects.contexts.list.queryKey({
				input: { projectId },
			}),
		});
		onOpenChange(false);
		resetForm();
	};

	const resetForm = () => {
		setFiles([]);
		setFileTitle("");
		setFileDocumentTag("");
		setIsBatchUploading(false);
		setLinkStatus("idle");
		setUrlFormValues({
			url: "",
			label: "",
			scope: "SINGLE_PAGE",
			maxPages: URL_MAX_PAGES_DEFAULT,
			refreshMode: "ONCE",
		});
		setUrlScopeUserOverridden(false);
		setUrlFormErrors({});
		setUrlSubmitNoticeOverride(null);
		setUrlBulkMode("SINGLE");
		setUrlBulkRaw("");
		setUrlBulkProgress(null);
		setUrlBulkResults(null);
		setTextTitle("");
		setTextContent("");
		setActiveTab("file");
	};

	// Drag and drop handlers
	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(true);
	}, []);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(false);
	}, []);

	// Convert a list of native `File` objects into validated row entries.
	//
	// The single funnel both the drop path and the picker path go through, so
	// the gates here are the gates for every way a file can enter the queue.
	// Files failing either gate are kept as `failed` rows so the user sees the
	// rejection inline rather than silently dropped (spec §7.1, decision Q12 —
	// rejected siblings must not block the batch), and each file is judged on
	// its own. Returns rows in the same order as the input so the user can
	// correlate the rejection with the file they just dropped.
	//
	// Two gates, type before size:
	//   1. Type — `contextUploadConfigFor` is the allowlist lookup, and
	//      `undefined` means this surface does not admit the type. Do NOT test
	//      the resolved MIME for null instead: the resolver hands back the
	//      caller's own value when nothing resolves, so it is never null. An
	//      unadvertised type used to queue as "Ready", enable the Upload
	//      button, and only be refused by the server's 400 after the round-trip.
	//   2. Size — against the limit the *resolved* category carries.
	const buildRowsFromFiles = useCallback(
		(picked: File[]): UploadedFileRow[] => {
			const refusals: string[] = [];
			const rows = picked.map((picked_file): UploadedFileRow => {
				const mimeType = picked_file.type || "application/octet-stream";
				const { resolvedMimeType, category } =
					resolveContextUploadCategory(mimeType, picked_file.name);
				const base = {
					id: `${Date.now()}-${Math.random().toString(36).slice(2)}-${picked_file.name}`,
					file: picked_file,
					name: picked_file.name,
					size: picked_file.size,
					mimeType,
				};

				if (!contextUploadConfigFor(resolvedMimeType)) {
					const reason = unsupportedTypeReason(
						picked_file.name,
						resolvedMimeType,
					);
					refusals.push(reason);
					return { ...base, status: "failed", error: reason };
				}

				const maxSize = UPLOAD_SIZE_LIMITS[category];
				if (picked_file.size > maxSize) {
					// Announced like the type refusal above: both are queue-time
					// refusals that insert an already-failed row, and assistive
					// technology does not reliably announce a newly inserted node.
					// Worded by the shared helper so this surface and the wizard
					// phrase an oversize file identically.
					const reason = oversizeReason(picked_file.name, maxSize);
					refusals.push(reason);
					return { ...base, status: "failed", error: reason };
				}

				return { ...base, status: "queued" };
			});

			// One announcement per batch, naming every file it refused.
			if (refusals.length > 0) {
				announce(refusals.join(" "));
			}

			return rows;
		},
		[announce],
	);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			setIsDragOver(false);

			const droppedFiles = Array.from(e.dataTransfer.files);
			if (droppedFiles.length === 0) {
				return;
			}
			// Append rather than replace — sequential drops accumulate.
			// The first dropped file seeds an empty `fileTitle`
			// only if none has been set yet — preserves the legacy single-file
			// UX where the title input is pre-populated with the filename, but
			// stays out of the way for multi-file batches where there's no
			// one canonical title.
			const newRows = buildRowsFromFiles(droppedFiles);
			setFiles((prev) => [...prev, ...newRows]);
			if (!fileTitle && droppedFiles.length === 1) {
				setFileTitle(droppedFiles[0].name.replace(/\.[^/.]+$/, ""));
			}
		},
		[buildRowsFromFiles, fileTitle],
	);

	const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
		const selectedFiles = Array.from(e.target.files ?? []);
		if (selectedFiles.length === 0) {
			return;
		}
		const newRows = buildRowsFromFiles(selectedFiles);
		setFiles((prev) => [...prev, ...newRows]);
		if (!fileTitle && selectedFiles.length === 1) {
			setFileTitle(selectedFiles[0].name.replace(/\.[^/.]+$/, ""));
		}
		// Reset input value so re-selecting the same file fires `onChange` again.
		e.target.value = "";
	};

	const removeFileRow = (id: string) => {
		setFiles((prev) => prev.filter((row) => row.id !== id));
	};

	// Multi-file upload. Fans out N parallel
	// `createUploadUrl → PUT → processFile` round-trips via Promise.allSettled
	// — mirrors the bulk-URL pattern in `handleUrlBulkAdd` above. Each
	// per-file failure surfaces inline on its own row and does NOT block
	// siblings. Already-`failed` rows (oversize from drop-time validation)
	// are skipped without re-attempting.
	//
	// Group 3 audit (`process-context-file.concurrent.test.ts`) confirms the
	// procedure is parallel-safe with distinct contextIds against the same
	// projectId, so no client-side serialization is required.
	const handleFileUpload = async () => {
		const queueable = files.filter((row) => row.status === "queued");
		if (queueable.length === 0) {
			toast.error("Please select a file");
			return;
		}

		// Rows the gate already refused. They never enter the fan-out, so they
		// never reach `failCount` — and without counting them here a batch of
		// one refused file plus one good upload closed the dialog and reset the
		// form, destroying a refusal the user may not have read. A refusal that
		// vanishes on someone else's success is not the persistent row R19 asks
		// for.
		const refusedCount = files.filter(
			(row) => row.status === "failed",
		).length;

		setIsBatchUploading(true);

		// Mark queueable rows as uploading before kicking off the fan-out so
		// the submit button's disabled state catches the in-flight set.
		setFiles((prev) =>
			prev.map((row) =>
				row.status === "queued"
					? { ...row, status: "uploading" as const }
					: row,
			),
		);

		// Per-row counters scoped to this submit. React state can't be read
		// synchronously after `setFiles` because the updates are batched, so
		// we tally success/failure in-closure to drive the final toast +
		// auto-close decision below.
		let successCount = 0;
		let failCount = 0;

		await Promise.allSettled(
			queueable.map(async (row) => {
				try {
					// Excalidraw content pre-check (#1942): advisory; the extractor
					// stores the raw JSON, so reject a malformed file before upload.
					if (row.name.toLowerCase().endsWith(".excalidraw")) {
						const text = await row.file.text();
						if (!isValidExcalidrawContent(text)) {
							throw new Error(
								"The file is not a valid Excalidraw document.",
							);
						}
					}

					// 1. Get signed upload URL
					const { signedUploadUrl, contextId, contentType } =
						await orpcClient.projects.contexts.createUploadUrl({
							projectId,
							filename: row.name,
							mimeType: row.mimeType,
							size: row.size,
							...(fileDocumentTag
								? { documentTag: fileDocumentTag }
								: {}),
						});

					if (!signedUploadUrl) {
						throw new Error(
							"Storage provider does not support direct uploads for project contexts",
						);
					}

					// 2. Upload file to storage.
					//
					// Send the type the server resolved rather than the
					// browser's placeholder, so the stored object's
					// Content-Type matches the row the server persisted. Falls
					// back to resolving locally so a new bundle talking to a
					// server that predates the field still stores the right
					// type. #2139.
					const uploadResponse = await fetch(signedUploadUrl, {
						method: "PUT",
						body: row.file,
						headers: {
							"Content-Type":
								contentType ??
								resolveContextUploadMime(
									row.mimeType,
									row.name,
								),
						},
					});

					if (!uploadResponse.ok) {
						throw new Error("Failed to upload file to storage");
					}

					// Flip to processing while the procedure runs.
					setFiles((prev) =>
						prev.map((r) =>
							r.id === row.id
								? { ...r, status: "processing" as const }
								: r,
						),
					);

					// 3. Trigger file processing
					await orpcClient.projects.contexts.processFile({
						projectId,
						contextId,
					});

					setFiles((prev) =>
						prev.map((r) =>
							r.id === row.id
								? { ...r, status: "completed" as const }
								: r,
						),
					);

					successCount++;

					// New event (spec
					// `2026-05-23-unified-context-uploader-wizard` §9.2):
					// fires exactly once per successful row so the bulk-add
					// flow reports N events for N completed files.
					// Per-row failures land in the `catch` block above and
					// intentionally do NOT emit — the event measures
					// successful attachment, not attempt volume.
					trackEvent("project_context_added_during_wizard", {
						surface,
						contextType: "FILE",
					});
				} catch (error) {
					console.error("File upload error:", error);
					const message =
						error instanceof Error && error.message
							? error.message
							: "Unknown error";
					setFiles((prev) =>
						prev.map((r) =>
							r.id === row.id
								? {
										...r,
										status: "failed" as const,
										error: message,
									}
								: r,
						),
					);
					failCount++;
				}
			}),
		);

		setIsBatchUploading(false);

		// Branch on outcome: only auto-close + green toast when every row
		// succeeded. On any failure, keep the dialog open so the user can
		// read inline error messages on the failed rows and either remove
		// + retry them or close manually. Always invalidate the pending list
		// so successful rows surface immediately in the wizard cards (Group 8).
		queryClient.invalidateQueries({
			queryKey: orpc.projects.contexts.list.queryKey({
				input: { projectId },
			}),
		});

		if (failCount === 0 && refusedCount === 0) {
			toast.success(
				successCount === 1
					? "File uploaded"
					: `${successCount} files uploaded`,
			);
			onOpenChange(false);
			resetForm();
		} else if (successCount > 0) {
			const unresolved = failCount + refusedCount;
			toast.warning(
				`${successCount} uploaded, ${unresolved} not uploaded — review the remaining items.`,
			);
		} else {
			toast.error(
				failCount === 1
					? "Upload failed — see error details on the row."
					: `All ${failCount} uploads failed — see error details on each row.`,
			);
		}
	};

	// URL source submit handler — `processLink` payload contract:
	// scope, maxPages (only for PATH_PREFIX), refreshMode. On the
	// FIRECRAWL_NOT_CONFIGURED BAD_REQUEST shape (revoked between mount and
	// submit) we surface the notice card in place of a destructive toast.
	const handleUrlSourceAdd = async () => {
		// Clear stale notice override so a fresh attempt doesn't keep the
		// previous error pinned.
		setUrlSubmitNoticeOverride(null);

		// Trim before validating so trailing whitespace doesn't fail the URL
		// regex.
		const trimmed: UrlSourceFormValues = {
			...urlFormValues,
			url: urlFormValues.url.trim(),
			label: urlFormValues.label?.trim() ?? "",
		};
		const parsed = urlSourceFormSchema.safeParse(trimmed);
		if (!parsed.success) {
			const errors: Partial<Record<keyof UrlSourceFormValues, string>> =
				{};
			for (const issue of parsed.error.issues) {
				const key = issue.path[0] as keyof UrlSourceFormValues;
				if (key && !errors[key]) {
					errors[key] = issue.message;
				}
			}
			setUrlFormErrors(errors);
			return;
		}

		const categoryErrors = knowledgeBaseCategoryErrors(
			trimmed,
			requireKnowledgeBaseCategory,
		);
		if (categoryErrors) {
			setUrlFormErrors(categoryErrors);
			return;
		}
		setUrlFormErrors({});

		const payload: {
			projectId: string;
			organizationId?: string;
			url: string;
			label?: string;
			scope: UrlScope;
			maxPages?: number;
			refreshMode: UrlRefreshMode;
			knowledgeBaseSourceCategory?: KnowledgeBaseSourceCategoryValue;
			knowledgeBaseSourceCategoryOther?: string;
		} = {
			projectId,
			...(organizationId ? { organizationId } : {}),
			url: parsed.data.url,
			...(parsed.data.label ? { label: parsed.data.label } : {}),
			scope: parsed.data.scope,
			refreshMode: parsed.data.refreshMode,
			...knowledgeBaseCategoryPayload(trimmed),
			...sourceMetadataPayload(trimmed),
		};
		// Server defaults maxPages to 100 for PATH_PREFIX, but we send it
		// explicitly when the user has typed something so the procedure
		// doesn't have to coalesce.
		if (parsed.data.scope === "PATH_PREFIX" && parsed.data.maxPages) {
			payload.maxPages = parsed.data.maxPages;
		}

		try {
			setLinkStatus("processing");
			await orpcClient.projects.contexts.processLink(payload);
			setLinkStatus("success");
			// Group 10.1 telemetry: `project_context_url_added` per spec §13.
			trackEvent("project_context_url_added", {
				scope: parsed.data.scope,
				refreshMode: parsed.data.refreshMode,
				maxPages: payload.maxPages ?? null,
				projectId,
				...(organizationId ? { organizationId } : {}),
			});
			// New event (spec
			// `2026-05-23-unified-context-uploader-wizard` §9.2): fires
			// alongside the legacy URL-added event so both pipelines stay
			// populated. `contextType` is the spec-defined enum value
			// (LINK), not the server-side type literal (TEXT/INTEGRATION
			// stay distinct in the same payload below).
			trackEvent("project_context_added_during_wizard", {
				surface,
				contextType: "LINK",
			});
			toast.success("Processing started…");
			invalidateAndClose();
		} catch (error) {
			console.error("URL source add error:", error);
			setLinkStatus("error");
			if (isProviderNotConfiguredError(error)) {
				// Server says either:
				//   - no scrape provider configured at all
				//   - PATH_PREFIX requested but no crawl-capable provider
				//   - legacy FIRECRAWL_NOT_CONFIGURED (kept for back-compat)
				// In every case we surface the notice card again so the user
				// can reconfigure.
				setUrlSubmitNoticeOverride(error.data);
				// Trigger a re-fetch so the pre-flight reflects reality on
				// next mount.
				providersConfigQuery.refetch();
				return;
			}
			const message =
				error instanceof Error && error.message
					? error.message
					: "Unknown error";
			toast.error(`Failed to add URL source: ${message}`);
		}
	};

	// Bulk URL submit (Commit 4) — fires N parallel `processLink` calls and
	// reports per-URL outcomes back through `urlBulkProgress` + `urlBulkResults`.
	// We deliberately do NOT use the shared `processLink` payload extras
	// (label, maxPages) for individual lines — every URL in a batch shares
	// the same scope / refreshMode picked from the existing form values, and
	// each scraped title becomes that row's label server-side.
	const handleUrlBulkAdd = async () => {
		setUrlSubmitNoticeOverride(null);
		const parsedLines = parseBulkUrlLines(urlBulkRaw);
		const validLines = parsedLines.filter((l) => l.url !== null);
		if (validLines.length === 0) {
			return;
		}
		if (validLines.length > URL_BULK_MAX_LINES) {
			return;
		}

		// The category is a shared batch setting like scope and refresh, so it
		// is required here on exactly the same terms as a single URL.
		const categoryErrors = knowledgeBaseCategoryErrors(
			urlFormValues,
			requireKnowledgeBaseCategory,
		);
		if (categoryErrors) {
			setUrlFormErrors(categoryErrors);
			return;
		}
		setUrlFormErrors({});

		// Use the parent form's scope / maxPages / refreshMode as the shared
		// batch settings. Validate them once (the rest of the schema accepts
		// any URL — we won't pass that field through; per-line URLs come
		// from the textarea).
		const scope = urlFormValues.scope;
		const refreshMode = urlFormValues.refreshMode;
		const maxPages =
			scope === "PATH_PREFIX"
				? (urlFormValues.maxPages ?? URL_MAX_PAGES_DEFAULT)
				: undefined;

		setLinkStatus("processing");
		setUrlBulkResults(null);
		setUrlBulkProgress({ total: validLines.length, submitted: 0 });

		const results: BulkSubmitResult[] = new Array(validLines.length);
		let notice: ProviderNotConfiguredData | null = null;
		await Promise.allSettled(
			validLines.map(async (line, idx) => {
				const url = line.url as string;
				const payload: {
					projectId: string;
					organizationId?: string;
					url: string;
					scope: UrlScope;
					maxPages?: number;
					refreshMode: UrlRefreshMode;
					knowledgeBaseSourceCategory?: KnowledgeBaseSourceCategoryValue;
					knowledgeBaseSourceCategoryOther?: string;
				} = {
					projectId,
					...(organizationId ? { organizationId } : {}),
					url,
					scope,
					refreshMode,
					// One classification covers the batch, the same way scope
					// and refresh already do.
					...knowledgeBaseCategoryPayload(urlFormValues),
				};
				if (maxPages !== undefined) {
					payload.maxPages = maxPages;
				}
				try {
					await orpcClient.projects.contexts.processLink(payload);
					results[idx] = { url, ok: true, error: null };
					trackEvent("project_context_url_added", {
						scope,
						refreshMode,
						maxPages: payload.maxPages ?? null,
						projectId,
						...(organizationId ? { organizationId } : {}),
					});
					// Mirror the single-URL branch: one
					// `project_context_added_during_wizard` event per
					// successful bulk-paste row so N pasted URLs ⇒ N
					// events. Failed rows skip the emit naturally because
					// the throwing call short-circuits to `catch`.
					trackEvent("project_context_added_during_wizard", {
						surface,
						contextType: "LINK",
					});
				} catch (error) {
					if (isProviderNotConfiguredError(error)) {
						// Capture once — same provider gate would fire for
						// every URL. We surface the notice card after settle
						// instead of repeating the error inline 50 times.
						if (notice === null) {
							notice = error.data;
						}
					}
					const message =
						error instanceof Error && error.message
							? error.message
							: "Failed";
					results[idx] = { url, ok: false, error: message };
				} finally {
					setUrlBulkProgress((prev) =>
						prev
							? { ...prev, submitted: prev.submitted + 1 }
							: prev,
					);
				}
			}),
		);

		setUrlBulkResults(results);
		const successCount = results.filter((r) => r.ok).length;

		if (notice !== null) {
			// At least one URL hit the provider gate — surface the same notice
			// card the single-URL path uses.
			setUrlSubmitNoticeOverride(notice);
			setLinkStatus("error");
			providersConfigQuery.refetch();
			return;
		}

		if (successCount === results.length) {
			setLinkStatus("success");
			// Invalidate the contexts list so new rows appear immediately.
			queryClient.invalidateQueries({
				queryKey: orpc.projects.contexts.list.queryKey({
					input: { projectId },
				}),
			});
		} else if (successCount === 0) {
			setLinkStatus("error");
		} else {
			// Partial success — still invalidate so the rows that did make
			// it through are visible.
			setLinkStatus("success");
			queryClient.invalidateQueries({
				queryKey: orpc.projects.contexts.list.queryKey({
					input: { projectId },
				}),
			});
		}
	};

	// Auto-close after a fully-successful bulk submit. Gives the user
	// `URL_BULK_SUCCESS_AUTOCLOSE_MS` to read the summary, then closes the
	// dialog and resets state. Failures keep the dialog open so the user can
	// see what went wrong (per spec: summary stays visible).
	useEffect(() => {
		if (urlBulkResults === null) {
			return;
		}
		const allOk = urlBulkResults.every((r) => r.ok);
		if (!allOk) {
			return;
		}
		const t = setTimeout(() => {
			onOpenChange(false);
			resetForm();
		}, URL_BULK_SUCCESS_AUTOCLOSE_MS);
		return () => clearTimeout(t);
		// We deliberately depend on `urlBulkResults` only — `resetForm` and
		// `onOpenChange` are stable for as long as the dialog is mounted.
		// biome-ignore lint/correctness/useExhaustiveDependencies: see note above
	}, [urlBulkResults]);

	const handleTextAdd = () => {
		if (!textTitle.trim() || !textContent.trim()) {
			toast.error("Please enter both title and content");
			return;
		}

		createTextMutation.mutate({
			projectId,
			type: "TEXT",
			content: textContent.trim(),
			metadata: {
				title: textTitle.trim(),
			},
		});
	};

	const handleSubmit = () => {
		switch (activeTab) {
			case "file":
				handleFileUpload();
				break;
			case "link":
				if (urlBulkMode === "MULTI") {
					handleUrlBulkAdd();
				} else {
					handleUrlSourceAdd();
				}
				break;
			case "text":
				handleTextAdd();
				break;
		}
	};

	// Submit-button disabled while *any* file row is mid-flight (uploading or
	// processing). Mirrors the old single-file `uploadStatus === "uploading"`
	// gate but generalized to a list. Spec §7.5.
	const hasInFlightFile = files.some(
		(row) => row.status === "uploading" || row.status === "processing",
	);
	const isLoading =
		isBatchUploading ||
		hasInFlightFile ||
		linkStatus === "processing" ||
		createTextMutation.isPending;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{/* `max-w-3xl` gives the seven-tab row enough room to sit on one
			    line without scrolling at desktop widths.
			    `grid-cols-[minmax(0,1fr)]` caps the grid column at the dialog
			    width so the tab row can't grow the column past the dialog box
			    and crop content off the right edge; on narrower viewports the
			    tab row scrolls (see below) rather than overflowing. */}
			<DialogContent className="grid-cols-[minmax(0,1fr)] max-h-[90vh] max-w-3xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<div className="rounded-lg border border-border bg-card p-2 text-primary">
							<SparklesIcon className="size-4" />
						</div>
						Add Context
					</DialogTitle>
					<DialogDescription>
						Add context to your project by uploading files, adding
						links, or pasting text. This helps generate better, more
						accurate documents.
					</DialogDescription>
				</DialogHeader>

				{/* Custom Tabs */}
				<div
					className="relative"
					role="tablist"
					aria-label="Context source"
				>
					{/* `min-w-0 overflow-x-auto` lets the seven-tab row scroll
					    horizontally instead of forcing the dialog wider than its
					    container; `no-scrollbar` keeps the editorial look (matches
					    the ProjectDetails tab row). */}
					<div className="no-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1.5">
						{tabs.map((tab) => {
							const Icon = tab.icon;
							const isActive = activeTab === tab.id;

							return (
								<button
									key={tab.id}
									type="button"
									role="tab"
									aria-selected={isActive}
									aria-controls={`context-tabpanel-${tab.id}`}
									id={`context-tab-${tab.id}`}
									onClick={() => setActiveTab(tab.id)}
									disabled={isLoading}
									className={cn(
										"relative flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 font-medium text-sm transition-colors",
										isActive
											? "bg-accent text-foreground"
											: "text-muted-foreground hover:text-foreground",
										isLoading &&
											"cursor-not-allowed opacity-50",
									)}
								>
									<Icon
										className={cn(
											"size-4",
											isActive && "text-primary",
										)}
									/>
									<span>{tab.label}</span>
								</button>
							);
						})}
					</div>

					{/* Editorial underline — single primary token, no gradient */}
					<div className="relative mt-1 h-0.5 w-full overflow-hidden rounded-full bg-border">
						<div
							className="absolute h-full rounded-full bg-primary motion-safe:transition-[left] motion-safe:duration-300 motion-safe:ease-out"
							style={{
								width: `${100 / tabs.length}%`,
								left: `${(tabs.findIndex((t) => t.id === activeTab) / tabs.length) * 100}%`,
							}}
						/>
					</div>
				</div>

				{/* Tab Content */}
				<div className="mt-4">
					{/* File upload tab — multi-file */}
					{activeTab === "file" && (
						<div
							className="space-y-4 motion-safe:animate-stagger"
							role="tabpanel"
							id="context-tabpanel-file"
							aria-labelledby="context-tab-file"
						>
							{/* Drag and Drop Zone — always shows the "drop here"
							    affordance even when files are already queued, so
							    multi-file accumulation feels obvious. */}
							{/* biome-ignore lint/a11y/noStaticElementInteractions: file drop zone uses drag events, not click; file input inside handles keyboard/click access */}
							<div
								className={cn(
									"relative overflow-hidden rounded-xl border-2 border-dashed bg-card transition-colors",
									isDragOver
										? "border-primary bg-accent"
										: "border-border hover:border-muted-foreground",
								)}
								onDragOver={handleDragOver}
								onDragLeave={handleDragLeave}
								onDrop={handleDrop}
							>
								<div className="relative z-10 flex flex-col items-center justify-center p-8">
									<div className="mb-4 rounded-2xl border border-border bg-card p-4 text-primary">
										<UploadCloudIcon className="size-8" />
									</div>
									<p className="mb-1 font-medium">
										{files.length > 0
											? "Drop more files or browse"
											: "Drag and drop your files here"}
									</p>
									<p className="mb-3 max-w-md text-pretty text-center text-muted-foreground text-sm">
										{CONTEXT_UPLOAD_FORMATS_AND_LIMITS}
									</p>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={(e) => {
													e.stopPropagation();
													document
														.getElementById(
															"context-file-input",
														)
														?.click();
												}}
												disabled={isLoading}
											>
												Browse Files
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{t("browseFiles")}
										</TooltipContent>
									</Tooltip>
								</div>

								<input
									id="context-file-input"
									type="file"
									className="sr-only"
									accept={CONTEXT_UPLOAD_ACCEPT_ATTR}
									multiple
									onChange={handleFileSelect}
									disabled={isLoading}
								/>
							</div>

							{/* Per-file status list. Renders once any file is in
							    the queue. Each row carries (filename, size, status
							    pill, remove button). Spec §7.4. */}
							{files.length > 0 && (
								<ul
									className="space-y-2"
									aria-label="Selected files"
								>
									{files.map((row) => (
										<FileQueueRow
											key={row.id}
											row={row}
											onRemove={() =>
												removeFileRow(row.id)
											}
											disabled={isLoading}
										/>
									))}
								</ul>
							)}

							{/* Title input */}
							<div>
								<Label htmlFor="file-title">
									Title (Optional)
								</Label>
								<Input
									id="file-title"
									placeholder="Enter a title or leave empty to use filename"
									value={fileTitle}
									onChange={(e) =>
										setFileTitle(e.target.value)
									}
									disabled={isLoading}
									className="mt-2"
								/>
							</div>

							{/* Document type tag */}
							<div>
								<Label htmlFor="file-document-tag">
									Tag as Document (Optional)
								</Label>
								<select
									id="file-document-tag"
									value={fileDocumentTag}
									onChange={(e) =>
										setFileDocumentTag(e.target.value)
									}
									disabled={isLoading}
									className="mt-2 flex h-9 w-full rounded-md border border-input bg-background text-foreground px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
								>
									{DOCUMENT_TAG_OPTIONS.map((opt) => (
										<option
											key={opt.value}
											value={opt.value}
											className="bg-background text-foreground"
										>
											{opt.value === ""
												? "None - Context only"
												: opt.label}
										</option>
									))}
								</select>
								<p className="mt-1 text-xs text-muted-foreground">
									Tag this file as a project document to use
									it directly instead of generating one
								</p>
							</div>

							{/* Mounted with the tab, before any file can be
							    picked, so a refusal written into it later reads
							    as an update to an existing live region rather
							    than an inserted node a screen reader would skip.
							    Last in the panel because `sr-only` is
							    position-absolute: `space-y-4` cannot give it a
							    visible gap here, whereas placing it first would
							    push the dropzone down by one step. */}
							<LiveAnnouncerRegion
								announcement={announcement}
								data-testid="context-upload-announcer"
							/>
						</div>
					)}

					{/* Link tab — URL Context Sources */}
					{activeTab === "link" && (
						<UrlSourceTabContent
							values={urlFormValues}
							onValuesChange={setUrlFormValues}
							scopeUserOverridden={urlScopeUserOverridden}
							setScopeUserOverridden={setUrlScopeUserOverridden}
							errors={urlFormErrors}
							setErrors={setUrlFormErrors}
							isLoading={isLoading}
							hasAnyScrapeCapable={hasAnyScrapeCapable}
							hasCrawlCapable={hasCrawlCapable}
							scrapeProviderName={scrapeProviderName}
							preflightLoading={
								providersConfigQuery.isLoading ||
								providersConfigQuery.isFetching
							}
							noticeSettingsPath={noticeSettingsPath}
							noticeOverride={urlSubmitNoticeOverride}
							linkStatus={linkStatus}
							bulkMode={urlBulkMode}
							onBulkModeChange={setUrlBulkMode}
							bulkRaw={urlBulkRaw}
							onBulkRawChange={setUrlBulkRaw}
							bulkProgress={urlBulkProgress}
							bulkResults={urlBulkResults}
							requireCategory={requireKnowledgeBaseCategory}
						/>
					)}

					{/* Text tab */}
					{activeTab === "text" && (
						<div
							className="space-y-4 motion-safe:animate-stagger"
							role="tabpanel"
							id="context-tabpanel-text"
							aria-labelledby="context-tab-text"
						>
							<div>
								<Label htmlFor="text-title">Title</Label>
								<Input
									id="text-title"
									placeholder="Enter a title for this content"
									value={textTitle}
									onChange={(e) =>
										setTextTitle(e.target.value)
									}
									disabled={isLoading}
									className="mt-2"
								/>
							</div>

							<div>
								<Label htmlFor="text-content">Content</Label>
								<Textarea
									id="text-content"
									placeholder="Paste or type your content here. This could be notes, requirements, specifications, or any other relevant text."
									value={textContent}
									onChange={(e) =>
										setTextContent(e.target.value)
									}
									disabled={isLoading}
									rows={8}
									className="mt-2 resize-none"
								/>
								<p className="mt-1 text-muted-foreground text-sm">
									{textContent.length} characters
								</p>
							</div>
						</div>
					)}

					{/* Teams tab */}
					{activeTab === "teams" && (
						<div
							className="flex flex-col items-center justify-center py-8 motion-safe:animate-stagger"
							role="tabpanel"
							id="context-tabpanel-teams"
							aria-labelledby="context-tab-teams"
						>
							<div className="mb-4 rounded-2xl border border-border bg-card p-4 text-primary">
								<MicrosoftTeamsIcon className="size-8" />
							</div>
							<h3 className="mb-2 font-medium text-foreground">
								Microsoft Teams Integration
							</h3>
							<p className="mb-6 max-w-sm text-center text-muted-foreground text-sm">
								Connect your Teams group chats to include
								conversation context in document generation.
							</p>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										onClick={() => setTeamsDialogOpen(true)}
										className="gap-2"
									>
										<MicrosoftTeamsIcon className="size-4" />
										Select Teams Chats
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{t("selectTeamsChats")}
								</TooltipContent>
							</Tooltip>
						</div>
					)}

					{/* Slack tab */}
					{activeTab === "slack" && (
						<div
							className="flex flex-col items-center justify-center py-8 motion-safe:animate-stagger"
							role="tabpanel"
							id="context-tabpanel-slack"
							aria-labelledby="context-tab-slack"
						>
							<div className="mb-4 rounded-2xl border border-border bg-card p-4 text-primary">
								<SlackIcon className="size-8" />
							</div>
							<h3 className="mb-2 font-medium text-foreground">
								Slack Integration
							</h3>
							<p className="mb-6 max-w-sm text-center text-muted-foreground text-sm">
								Connect your Slack workspace channels to include
								conversation context in document generation.
							</p>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										onClick={() => setSlackDialogOpen(true)}
										className="gap-2"
									>
										<SlackIcon className="size-4" />
										Select Slack Channels
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{t("selectSlackChannels")}
								</TooltipContent>
							</Tooltip>
						</div>
					)}

					{/* Google Docs tab — opens the picker-session-backed dialog */}
					{activeTab === "google-docs" && (
						<div
							className="flex flex-col items-center justify-center py-8 motion-safe:animate-stagger"
							role="tabpanel"
							id="context-tabpanel-google-docs"
							aria-labelledby="context-tab-google-docs"
						>
							<div className="mb-4 rounded-2xl border border-border bg-card p-4 text-foreground">
								<GoogleDriveIcon className="size-8" />
							</div>
							<h3 className="mb-2 font-medium text-foreground">
								Google Docs Integration
							</h3>
							<p className="mb-6 max-w-sm text-center text-muted-foreground text-sm">
								Pick Google Docs from your connected Google
								account and add them as project context.
							</p>
							<Button
								onClick={() => setGoogleDocsDialogOpen(true)}
								className="gap-2"
							>
								<GoogleDriveIcon className="size-4" />
								Pick Google Docs
							</Button>
						</div>
					)}

					{/* Notion tab */}
					{activeTab === "notion" && (
						<div
							className="flex flex-col items-center justify-center py-8 motion-safe:animate-stagger"
							role="tabpanel"
							id="context-tabpanel-notion"
							aria-labelledby="context-tab-notion"
						>
							<div className="mb-4 rounded-2xl border border-border bg-card p-4 text-foreground">
								<NotionIcon className="size-8" />
							</div>
							<h3 className="mb-2 font-medium text-foreground">
								Notion Integration
							</h3>
							<p className="mb-6 max-w-sm text-center text-muted-foreground text-sm">
								Sync Notion pages to include as context for
								document generation.
							</p>
							{notionConfigsLoading ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<LoaderIcon className="size-4 motion-safe:animate-spin" />
									<span>Loading...</span>
								</div>
							) : (notionMcpConfigs?.length ?? 0) === 0 ? (
								<>
									<p className="mb-4 text-sm text-muted-foreground">
										No Notion MCP server configured
									</p>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button variant="outline" asChild>
												<Link
													href={buildReturnUrl(
														`${basePath}/mcp-servers`,
													)}
												>
													<SettingsIcon className="size-4 mr-2" />
													Configure MCP
												</Link>
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{t("configureMcp")}
										</TooltipContent>
									</Tooltip>
								</>
							) : (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											onClick={() => {
												if (notionMcpConfigs?.[0]) {
													setSelectedNotionMcpConfigId(
														notionMcpConfigs[0].id,
													);
													setNotionDialogOpen(true);
												}
											}}
											className="gap-2"
										>
											<NotionIcon className="size-4" />
											Browse Notion Pages
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{t("browseNotionPages")}
									</TooltipContent>
								</Tooltip>
							)}
						</div>
					)}

					{/* Confluence tab */}
					{activeTab === "confluence" && (
						<div
							className="flex flex-col items-center justify-center py-8 motion-safe:animate-stagger"
							role="tabpanel"
							id="context-tabpanel-confluence"
							aria-labelledby="context-tab-confluence"
						>
							<div className="mb-4 rounded-2xl border border-border bg-card p-4 text-foreground">
								<ConfluenceIcon className="size-8" />
							</div>
							<h3 className="mb-2 font-medium text-foreground">
								Confluence Integration
							</h3>
							<p className="mb-6 max-w-sm text-center text-muted-foreground text-sm">
								Sync Confluence pages to include as context for
								document generation.
							</p>
							{confluenceConfigsLoading ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<LoaderIcon className="size-4 motion-safe:animate-spin" />
									<span>Loading...</span>
								</div>
							) : (confluenceMcpConfigs?.length ?? 0) === 0 ? (
								<>
									<p className="mb-4 text-sm text-muted-foreground">
										No Confluence MCP server configured
									</p>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button variant="outline" asChild>
												<Link
													href={buildReturnUrl(
														`${basePath}/mcp-servers`,
													)}
												>
													<SettingsIcon className="size-4 mr-2" />
													Configure MCP
												</Link>
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{t("configureMcp")}
										</TooltipContent>
									</Tooltip>
								</>
							) : (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											onClick={() => {
												if (confluenceMcpConfigs?.[0]) {
													setSelectedConfluenceMcpConfigId(
														confluenceMcpConfigs[0]
															.id,
													);
													setConfluenceDialogOpen(
														true,
													);
												}
											}}
											className="gap-2"
										>
											<ConfluenceIcon className="size-4" />
											Browse Confluence Pages
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{t("browseConfluencePages")}
									</TooltipContent>
								</Tooltip>
							)}
						</div>
					)}
				</div>

				{/* Footer - hidden for teams/slack/notion/confluence/google-docs tabs (they have their own buttons) */}
				{activeTab !== "teams" &&
					activeTab !== "slack" &&
					activeTab !== "notion" &&
					activeTab !== "confluence" &&
					activeTab !== "google-docs" &&
					(() => {
						// When the Link tab is active and no scrape-capable
						// provider is configured (commit 3 of 3: widened from
						// "no Firecrawl" to "no provider at all"), disable
						// submit and switch the tooltip to the configuration
						// hint. PATH_PREFIX additionally requires
						// a crawl-capable provider — we disable submit too
						// when that's selected and only non-crawl providers
						// are enabled (matches the server pre-flight).
						const linkTabUnconfigured =
							activeTab === "link" && !hasAnyScrapeCapable;
						const linkTabPathPrefixNeedsCrawl =
							activeTab === "link" &&
							hasAnyScrapeCapable &&
							!hasCrawlCapable &&
							urlFormValues.scope === "PATH_PREFIX";

						// Bulk-mode submit-disabled: parse the textarea on
						// every render so the button enabled state stays in
						// lock-step with the live preview the user sees.
						// Cap enforcement is identical to the inline note —
						// the message + the disable share one source of truth.
						const bulkParsed =
							activeTab === "link" && urlBulkMode === "MULTI"
								? parseBulkUrlLines(urlBulkRaw)
								: null;
						const bulkValidCount =
							bulkParsed?.filter((l) => l.url !== null).length ??
							0;
						const bulkInvalidCount =
							bulkParsed?.filter((l) => l.url === null).length ??
							0;
						const bulkOverLimit =
							bulkValidCount > URL_BULK_MAX_LINES;
						const linkTabBulkBlocked =
							activeTab === "link" &&
							urlBulkMode === "MULTI" &&
							(bulkValidCount === 0 ||
								bulkOverLimit ||
								bulkInvalidCount > 0);

						// File tab — submit disabled when no queueable file is
						// present (only `failed` rows, or zero rows). Spec §7.5.
						const queueableFileCount =
							activeTab === "file"
								? files.filter((row) => row.status === "queued")
										.length
								: 0;
						const fileTabBlocked =
							activeTab === "file" && queueableFileCount === 0;

						const linkTabBlocked =
							linkTabUnconfigured ||
							linkTabPathPrefixNeedsCrawl ||
							linkTabBulkBlocked;
						const submitDisabled =
							isLoading || linkTabBlocked || fileTabBlocked;
						const submitTooltip = linkTabUnconfigured
							? "Configure a search provider in Settings → Search Providers to add URL sources."
							: linkTabPathPrefixNeedsCrawl
								? "Path-prefix crawls require Firecrawl. Configure Firecrawl in Settings → Search Providers, or pick Single page."
								: linkTabBulkBlocked && bulkOverLimit
									? `Batches are limited to ${URL_BULK_MAX_LINES} URLs at a time.`
									: linkTabBulkBlocked && bulkInvalidCount > 0
										? "Fix or remove the invalid lines listed below the textarea."
										: linkTabBulkBlocked
											? "Paste at least one valid URL to enable submit."
											: fileTabBlocked
												? "Drop or pick at least one file to upload."
												: t("submitContext");

						// Button copy: in bulk mode + idle state, surface the
						// live count so users see what they're about to fire.
						const isBulk =
							activeTab === "link" && urlBulkMode === "MULTI";
						const showBulkCountCopy =
							isBulk && !isLoading && bulkValidCount > 0;
						// File tab — switch to "Upload" / "Upload N files" copy
						// per spec §7.5 once at least one file is queued. The
						// generic "Add Context" copy still renders when the
						// queue is empty so the disabled button reads naturally.
						const showFileUploadCopy =
							activeTab === "file" &&
							!isLoading &&
							queueableFileCount > 0;

						return (
							<DialogFooter className="mt-4">
								<Button
									variant="outline"
									onClick={() => onOpenChange(false)}
									disabled={isLoading}
								>
									Cancel
								</Button>
								<Tooltip>
									<TooltipTrigger asChild>
										{/*
										 * Wrapper span keeps the tooltip
										 * reachable when the button is
										 * disabled — Radix Tooltip skips
										 * pointer events on disabled
										 * children. The button retains
										 * aria-disabled so screen readers
										 * still announce the state.
										 */}
										<span
											className="inline-flex"
											tabIndex={
												submitDisabled ? 0 : undefined
											}
										>
											<Button
												onClick={handleSubmit}
												disabled={submitDisabled}
												aria-disabled={submitDisabled}
												className="gap-2"
											>
												{isLoading ? (
													<>
														<LoaderIcon className="size-4 motion-safe:animate-spin" />
														Processing...
													</>
												) : showBulkCountCopy ? (
													<>
														<SparklesIcon className="size-4" />
														Add {bulkValidCount} URL
														{bulkValidCount === 1
															? ""
															: "s"}
													</>
												) : showFileUploadCopy ? (
													<>
														<SparklesIcon className="size-4" />
														{queueableFileCount ===
														1
															? "Upload"
															: `Upload ${queueableFileCount} files`}
													</>
												) : (
													<>
														<SparklesIcon className="size-4" />
														Add Context
													</>
												)}
											</Button>
										</span>
									</TooltipTrigger>
									<TooltipContent>
										{submitTooltip}
									</TooltipContent>
								</Tooltip>
							</DialogFooter>
						);
					})()}
			</DialogContent>

			{/* Teams chat selector dialog */}
			<TeamsChatSelectorDialog
				projectId={projectId}
				open={teamsDialogOpen}
				onOpenChange={setTeamsDialogOpen}
				onSuccess={() => {
					// Spec `2026-05-23-unified-context-uploader-wizard`
					// §9.2: INTEGRATION rows carry a granular
					// `integrationKind` so post-launch validation can
					// separate Teams vs Slack vs Notion attachment rates
					// without parsing a contextType.
					trackEvent("project_context_added_during_wizard", {
						surface,
						contextType: "INTEGRATION",
						integrationKind: "TEAMS",
					});
					// Close the main dialog after successful chat selection
					onOpenChange(false);
				}}
			/>

			{/* Slack channel selector dialog */}
			<SlackChannelSelectorDialog
				projectId={projectId}
				open={slackDialogOpen}
				onOpenChange={setSlackDialogOpen}
				onSuccess={() => {
					trackEvent("project_context_added_during_wizard", {
						surface,
						contextType: "INTEGRATION",
						integrationKind: "SLACK",
					});
					// Close the main dialog after successful channel selection
					onOpenChange(false);
				}}
			/>

			{/* Google Docs picker — uses the Google Picker SDK under the hood,
			    so the heavy lifting (auth, MIME filter, multi-select) is
			    Google's; we just ingest the picks via `addGoogleDocs`. The
			    `onAdded` split (vs `onOpenChange`) means analytics + the
			    outer-dialog close only fire on a *successful* pick, not on
			    cancel. */}
			<GoogleDocsSelectorDialog
				open={googleDocsDialogOpen}
				onOpenChange={setGoogleDocsDialogOpen}
				projectId={projectId}
				organizationId={organizationId ?? null}
				onAdded={() => {
					trackEvent("project_context_added_during_wizard", {
						surface,
						contextType: "INTEGRATION",
						integrationKind: "GOOGLE_DRIVE",
					});
					onOpenChange(false);
				}}
			/>

			{/* Notion resource browser dialog */}
			<NotionResourceBrowser
				open={notionDialogOpen}
				onOpenChange={setNotionDialogOpen}
				mcpConfigId={selectedNotionMcpConfigId}
				projectId={projectId}
				organizationId={organizationId ?? null}
				syncedPageIds={
					notionContexts
						?.map(
							(ctx) =>
								(ctx.metadata as Record<string, unknown>)
									?.notionPageId as string,
						)
						.filter(Boolean) ?? []
				}
				onResourcesAdded={() => {
					trackEvent("project_context_added_during_wizard", {
						surface,
						contextType: "INTEGRATION",
						integrationKind: "NOTION",
					});
					// Invalidate contexts and close dialog
					queryClient.invalidateQueries({
						queryKey: ["project-notion-contexts", projectId],
					});
					queryClient.invalidateQueries({
						queryKey: orpc.projects.contexts.list.queryKey({
							input: { projectId },
						}),
					});
					onOpenChange(false);
				}}
			/>
			{/* Confluence resource browser dialog */}
			<ConfluenceResourceBrowser
				open={confluenceDialogOpen}
				onOpenChange={setConfluenceDialogOpen}
				mcpConfigId={selectedConfluenceMcpConfigId}
				projectId={projectId}
				organizationId={organizationId ?? null}
				syncedPageIds={
					confluenceContexts
						?.map(
							(ctx) =>
								(ctx.metadata as Record<string, unknown>)
									?.confluencePageId as string,
						)
						.filter(Boolean) ?? []
				}
				onResourcesAdded={() => {
					trackEvent("project_context_added_during_wizard", {
						surface,
						contextType: "INTEGRATION",
						integrationKind: "CONFLUENCE",
					});
					queryClient.invalidateQueries({
						queryKey: ["project-confluence-contexts", projectId],
					});
					queryClient.invalidateQueries({
						queryKey: orpc.projects.contexts.list.queryKey({
							input: { projectId },
						}),
					});
					onOpenChange(false);
				}}
			/>
		</Dialog>
	);
}

// ── URL Source tab content (v2) ──────────────────────────────────────────
//
// Extracted as a sibling component because the new form is meaningfully
// larger than the legacy two-input version. Receives state from the parent
// dialog so the submit handler (which lives there alongside the other
// tabs) can read the validated payload.
//
// Editorial aesthetic (CLAUDE.md): warm-neutral cards (`bg-card border
// border-border`), CSS-variable tokens only (`text-primary`,
// `text-muted-foreground`, `text-destructive`), no gradients, no
// `backdrop-blur`, no animated gradient blobs, no `transition-all`.

type UrlSourceTabContentProps = {
	values: UrlSourceFormValues;
	onValuesChange: (next: UrlSourceFormValues) => void;
	scopeUserOverridden: boolean;
	setScopeUserOverridden: (v: boolean) => void;
	errors: Partial<Record<keyof UrlSourceFormValues, string>>;
	setErrors: (
		next: Partial<Record<keyof UrlSourceFormValues, string>>,
	) => void;
	isLoading: boolean;
	/** True ⇔ at least one scrape-capable provider (FC / Jina / Tavily / Exa)
	 * is enabled. */
	hasAnyScrapeCapable: boolean;
	/** True ⇔ a crawl-capable provider (Firecrawl) is enabled. */
	hasCrawlCapable: boolean;
	/** Name of the provider that *would* be picked for SINGLE_PAGE / fallback. */
	scrapeProviderName: UrlSourceProviderName | null;
	preflightLoading: boolean;
	noticeSettingsPath: string;
	noticeOverride: ProviderNotConfiguredData | null;
	linkStatus: UploadStatus;
	// Bulk URL paste (Commit 4) ───────────────────────────────────────
	bulkMode: BulkUrlsMode;
	onBulkModeChange: (next: BulkUrlsMode) => void;
	bulkRaw: string;
	onBulkRawChange: (next: string) => void;
	bulkProgress: { total: number; submitted: number } | null;
	bulkResults: BulkSubmitResult[] | null;
	/** Readiness feature on ⇒ the source must be classified before it is saved. */
	requireCategory: boolean;
};

function UrlSourceTabContent({
	values,
	onValuesChange,
	scopeUserOverridden,
	setScopeUserOverridden,
	errors,
	setErrors,
	isLoading,
	hasAnyScrapeCapable,
	hasCrawlCapable,
	scrapeProviderName,
	preflightLoading,
	noticeSettingsPath,
	noticeOverride,
	linkStatus,
	bulkMode,
	onBulkModeChange,
	bulkRaw,
	onBulkRawChange,
	bulkProgress,
	bulkResults,
	requireCategory,
}: UrlSourceTabContentProps) {
	const t = useTranslations("tooltips.contextSources");
	const scopeLabelId = "url-scope-label";
	const urlErrId = "url-source-url-err";
	const labelErrId = "url-source-label-err";
	const maxPagesErrId = "url-source-maxpages-err";
	const categoryErrId = "url-source-category-err";
	const categoryOtherErrId = "url-source-category-other-err";

	// Show the warm-neutral notice card whenever the pre-flight (or the most
	// recent submit) reports "not configured". The override wins so a
	// post-submit notice persists across re-renders.
	const showNotice =
		noticeOverride !== null || (!preflightLoading && !hasAnyScrapeCapable);

	// Code drives copy. PATH_PREFIX-specific notice only triggered on submit
	// (the radio gate prevents most users from hitting it pre-submit).
	const noticeKind: "no-scrape" | "no-crawl" =
		noticeOverride?.code === "CRAWL_PROVIDER_NOT_CONFIGURED"
			? "no-crawl"
			: "no-scrape";

	// Tracks the matched pattern (e.g. "/docs/", "trailing slash") when the
	// blur auto-detect flips scope from SINGLE_PAGE to PATH_PREFIX. Cleared
	// on user override so the hint disappears the moment they pick a radio
	// manually. Local to the form sub-component because it only matters for
	// as long as the dialog stays open.
	const [scopeAutoDetectedFrom, setScopeAutoDetectedFrom] = useState<
		string | null
	>(null);

	// PATH_PREFIX requires a crawl-capable provider (Firecrawl in v1.1).
	// When none is enabled we disable the radio entirely AND make the blur
	// auto-detect fall back to SINGLE_PAGE — picking PATH_PREFIX silently
	// would produce a submit-time error that's harder to debug than a
	// disabled-from-the-start radio.
	const pathPrefixDisabled = !hasCrawlCapable;

	const handleUrlBlur = () => {
		// Auto-detect scope once on blur, unless the user has already
		// explicitly chosen a scope radio.
		if (scopeUserOverridden) {
			return;
		}
		if (!values.url.trim()) {
			return;
		}
		const { scope: detected, matchedPattern } = detectUrlScopeMatch(
			values.url.trim(),
		);
		// Fall back to SINGLE_PAGE if PATH_PREFIX is not available — the
		// user can still pick PATH_PREFIX manually (the radio explains why
		// it's disabled when they hover).
		const next: UrlScope =
			detected === "PATH_PREFIX" && pathPrefixDisabled
				? "SINGLE_PAGE"
				: detected;
		if (next !== values.scope) {
			onValuesChange({ ...values, scope: next });
			// Surface the matched pattern only when the rule flipped UP to
			// PATH_PREFIX — there's no hint to show for the SINGLE_PAGE
			// default, and we don't want a stale hint after the user clears
			// the URL and re-blurs on a plain article URL.
			setScopeAutoDetectedFrom(
				next === "PATH_PREFIX" ? matchedPattern : null,
			);
		}
	};

	const handleScopeChange = (next: UrlScope) => {
		setScopeUserOverridden(true);
		setScopeAutoDetectedFrom(null);
		onValuesChange({ ...values, scope: next });
	};

	const handleMaxPagesStep = (delta: number) => {
		const current = values.maxPages ?? URL_MAX_PAGES_DEFAULT;
		const next = Math.min(
			URL_MAX_PAGES_MAX,
			Math.max(URL_MAX_PAGES_MIN, current + delta),
		);
		onValuesChange({ ...values, maxPages: next });
	};

	const handleMaxPagesInput = (e: React.ChangeEvent<HTMLInputElement>) => {
		// Allow the field to be temporarily empty while editing; coerce on
		// blur via the validation submit.
		const raw = e.target.value;
		if (raw === "") {
			onValuesChange({ ...values, maxPages: undefined });
			return;
		}
		const n = Number.parseInt(raw, 10);
		if (Number.isNaN(n)) {
			return;
		}
		onValuesChange({ ...values, maxPages: n });
	};

	// Clear an error for a field once the user starts editing it again.
	const clearError = (key: keyof UrlSourceFormValues) => {
		if (errors[key]) {
			const { [key]: _, ...rest } = errors;
			setErrors(rest);
		}
	};

	return (
		<div
			className="space-y-4 motion-safe:animate-stagger"
			role="tabpanel"
			id="context-tabpanel-link"
			aria-labelledby="context-tab-link"
		>
			{/* Pre-flight notice — warm-neutral card. Renders when no scrape-
			    capable provider is enabled, or when the submit hit one of
			    the typed BAD_REQUEST codes (SCRAPE_/CRAWL_PROVIDER_NOT_
			    CONFIGURED, or the legacy FIRECRAWL_NOT_CONFIGURED). */}
			{showNotice && (
				<div
					className="space-y-2 rounded-lg border border-border bg-card p-4"
					role="status"
					aria-live="polite"
				>
					<div className="flex items-center gap-2">
						<span className="inline-flex items-center rounded-md border border-border bg-muted px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
							{noticeKind === "no-crawl"
								? "Crawl provider"
								: "Search provider"}
						</span>
					</div>
					<p className="text-sm text-foreground">
						{noticeKind === "no-crawl"
							? "Path-prefix crawls currently require Firecrawl. "
							: "URL sources need a search provider with scraping (Firecrawl, Jina, Tavily, or Exa). "}
						Configure one in{" "}
						<Link
							href={noticeSettingsPath}
							className="font-medium text-primary underline-offset-4 hover:underline"
						>
							Settings → Search Providers
						</Link>
						{noticeKind === "no-crawl"
							? ", or pick Single page."
							: " to start adding URLs."}
					</p>
				</div>
			)}

			{/* Mode toggle — single URL vs paste many at once (Commit 4).
			    Editorial chip style mirrors the radio cards above:
			    `bg-card border border-border`, `border-primary` when
			    active. No gradient pill, no chips. */}
			<div
				role="tablist"
				aria-label="URL entry mode"
				className="flex gap-2"
			>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							role="tab"
							aria-selected={bulkMode === "SINGLE"}
							onClick={() => onBulkModeChange("SINGLE")}
							disabled={isLoading}
							className={cn(
								"flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm transition-colors",
								bulkMode === "SINGLE"
									? "border-primary text-foreground"
									: "text-muted-foreground hover:text-foreground",
								isLoading && "cursor-not-allowed opacity-50",
							)}
						>
							Single URL
						</button>
					</TooltipTrigger>
					<TooltipContent>Add one URL</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							role="tab"
							aria-selected={bulkMode === "MULTI"}
							onClick={() => onBulkModeChange("MULTI")}
							disabled={isLoading}
							className={cn(
								"flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm transition-colors",
								bulkMode === "MULTI"
									? "border-primary text-foreground"
									: "text-muted-foreground hover:text-foreground",
								isLoading && "cursor-not-allowed opacity-50",
							)}
						>
							Multiple URLs (paste list)
						</button>
					</TooltipTrigger>
					<TooltipContent>Paste many URLs at once</TooltipContent>
				</Tooltip>
			</div>

			{/* SINGLE-URL form ─────────────────────────────────────────── */}
			{bulkMode === "SINGLE" && (
				<>
					{/* URL */}
					<div>
						<Label htmlFor="link-url">URL</Label>
						<Input
							id="link-url"
							type="url"
							placeholder="https://example.com/docs"
							value={values.url}
							onChange={(e) => {
								clearError("url");
								onValuesChange({
									...values,
									url: e.target.value,
								});
							}}
							onBlur={handleUrlBlur}
							disabled={isLoading}
							required
							aria-invalid={!!errors.url}
							aria-describedby={errors.url ? urlErrId : undefined}
							className="mt-2"
						/>
						{errors.url ? (
							<p
								id={urlErrId}
								className="mt-1 text-sm text-destructive"
								role="alert"
							>
								{errors.url}
							</p>
						) : (
							<p className="mt-1 text-muted-foreground text-sm">
								Fabric respects robots.txt, ai.txt, and
								llms.txt. Public HTTPS URLs only.
							</p>
						)}
					</div>

					{/* Source details (#1888) — optional type label + AI
					    guidance injected into prompts for this source. */}
					<div>
						<Label htmlFor="link-source-type">
							{t("sourceDetails.typeLabelOptional")}
						</Label>
						<Input
							id="link-source-type"
							placeholder={t("sourceDetails.typeAddPlaceholder")}
							value={values.sourceType ?? ""}
							maxLength={80}
							list="context-source-type-presets"
							autoComplete="off"
							onChange={(e) => {
								onValuesChange({
									...values,
									sourceType: e.target.value,
								});
							}}
							disabled={isLoading}
							className="mt-2"
						/>
						<datalist id="context-source-type-presets">
							{CONTEXT_SOURCE_TYPE_PRESETS.map((preset) => (
								<option key={preset} value={preset} />
							))}
						</datalist>
						<Label htmlFor="link-ai-instructions" className="mt-3">
							{t("sourceDetails.instructionsLabelOptional")}
						</Label>
						<Textarea
							id="link-ai-instructions"
							rows={3}
							maxLength={500}
							placeholder={t(
								"sourceDetails.instructionsAddPlaceholder",
							)}
							value={values.aiInstructions ?? ""}
							onChange={(e) => {
								onValuesChange({
									...values,
									aiInstructions: e.target.value,
								});
							}}
							disabled={isLoading}
							className="mt-2"
						/>
					</div>
					{/* Label */}
					<div>
						<Label htmlFor="link-label">Label (Optional)</Label>
						<Input
							id="link-label"
							placeholder="e.g. Zendesk Help Center"
							value={values.label ?? ""}
							maxLength={URL_LABEL_MAX_LEN}
							onChange={(e) => {
								clearError("label");
								onValuesChange({
									...values,
									label: e.target.value,
								});
							}}
							disabled={isLoading}
							aria-invalid={!!errors.label}
							aria-describedby={
								errors.label ? labelErrId : undefined
							}
							className="mt-2"
						/>
						{errors.label && (
							<p
								id={labelErrId}
								className="mt-1 text-sm text-destructive"
								role="alert"
							>
								{errors.label}
							</p>
						)}
					</div>
				</>
			)}

			{/* MULTI-URL form ────────────────────────────────────────────
			    Replaces the URL input with a textarea (one URL per line),
			    hides the optional Label field (each URL gets its scraped
			    title as label server-side), and parses lines live for a
			    live preview + per-line error listing. The scope / maxPages /
			    refresh fields below stay shared with the single-URL form
			    so the bulk submit applies them uniformly. */}
			{bulkMode === "MULTI" && (
				<BulkUrlsForm
					bulkRaw={bulkRaw}
					onBulkRawChange={onBulkRawChange}
					isLoading={isLoading}
				/>
			)}

			{/* Scope radio */}
			<div>
				<p
					id={scopeLabelId}
					className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground"
				>
					Crawl scope
				</p>
				<RadioGroup
					value={values.scope}
					onValueChange={(v) => handleScopeChange(v as UrlScope)}
					aria-labelledby={scopeLabelId}
					className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2"
				>
					<Tooltip delayDuration={150}>
						<TooltipTrigger asChild>
							<label
								htmlFor="url-scope-single"
								className={cn(
									"flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-card p-3 text-sm",
									values.scope === "SINGLE_PAGE" &&
										"border-primary",
									isLoading &&
										"cursor-not-allowed opacity-50",
								)}
							>
								<RadioGroupItem
									value="SINGLE_PAGE"
									id="url-scope-single"
									disabled={isLoading}
									className="mt-0.5"
								/>
								<span className="block">
									<span className="block font-medium">
										Single page
									</span>
									<span className="block text-muted-foreground text-xs">
										Index only the URL you entered.
									</span>
								</span>
							</label>
						</TooltipTrigger>
						<TooltipContent>
							{t("urlSource.scopeSinglePage")}
						</TooltipContent>
					</Tooltip>
					{/* PATH_PREFIX. Disabled when no crawl-capable provider is
					    enabled (commit 3 of 3, multi-provider PR). The label is
					    wrapped in a Tooltip in that case so the reason for the
					    disable is reachable on hover / focus — matches the
					    submit-button pattern used in the dialog footer. */}
					{pathPrefixDisabled ? (
						<Tooltip>
							<TooltipTrigger asChild>
								{/* The outer span keeps the tooltip reachable
								    while the radio item itself is disabled —
								    Radix Tooltip skips pointer events on
								    disabled children. */}
								<span
									className={cn(
										"inline-flex items-start gap-2 rounded-lg border border-border bg-card p-3 text-sm opacity-60",
										"cursor-not-allowed",
									)}
									aria-label="Path-prefix scope (disabled — no crawl-capable provider configured)"
								>
									<RadioGroupItem
										value="PATH_PREFIX"
										id="url-scope-prefix"
										disabled
										aria-disabled="true"
										className="mt-0.5"
									/>
									<span className="block">
										<span className="block font-medium">
											Path-prefix
										</span>
										<span className="block text-muted-foreground text-xs">
											Crawl pages under the URL's path
											(e.g. an entire help center).
										</span>
									</span>
								</span>
							</TooltipTrigger>
							<TooltipContent>
								Path-prefix crawls require Firecrawl. Configure
								Firecrawl in Settings → Search Providers.
							</TooltipContent>
						</Tooltip>
					) : (
						<Tooltip delayDuration={150}>
							<TooltipTrigger asChild>
								<label
									htmlFor="url-scope-prefix"
									className={cn(
										"flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-card p-3 text-sm",
										values.scope === "PATH_PREFIX" &&
											"border-primary",
										isLoading &&
											"cursor-not-allowed opacity-50",
									)}
								>
									<RadioGroupItem
										value="PATH_PREFIX"
										id="url-scope-prefix"
										disabled={isLoading}
										className="mt-0.5"
									/>
									<span className="block">
										<span className="block font-medium">
											Path-prefix
										</span>
										<span className="block text-muted-foreground text-xs">
											Crawl pages under the URL's path
											(e.g. an entire help center).
										</span>
									</span>
								</label>
							</TooltipTrigger>
							<TooltipContent>
								{t("urlSource.scopePathPrefix")}
							</TooltipContent>
						</Tooltip>
					)}
				</RadioGroup>
				{/* Inline auto-detect hint — names the matched pattern when
				    the blur rule flipped scope to PATH_PREFIX, so the flip
				    doesn't feel silent. Hidden once the user manually picks
				    a scope radio (urlScopeUserOverridden flag). */}
				{!scopeUserOverridden &&
					scopeAutoDetectedFrom &&
					values.scope === "PATH_PREFIX" && (
						<output
							className="mt-2 block text-xs text-muted-foreground"
							aria-live="polite"
						>
							Detected path-prefix from your URL (
							<span className="font-mono">
								{scopeAutoDetectedFrom}
							</span>
							).
						</output>
					)}
			</div>

			{/* Max pages stepper — only when scope = PATH_PREFIX */}
			{values.scope === "PATH_PREFIX" && (
				<div>
					<Label htmlFor="url-max-pages">Max pages to crawl</Label>
					<div className="mt-2 flex items-center gap-2">
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="outline"
									size="icon"
									aria-label="Decrease max pages"
									onClick={() => handleMaxPagesStep(-10)}
									disabled={
										isLoading ||
										(values.maxPages ??
											URL_MAX_PAGES_DEFAULT) <=
											URL_MAX_PAGES_MIN
									}
								>
									<MinusIcon className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								Decrease by 10 (min {URL_MAX_PAGES_MIN})
							</TooltipContent>
						</Tooltip>
						<Input
							id="url-max-pages"
							type="number"
							inputMode="numeric"
							min={URL_MAX_PAGES_MIN}
							max={URL_MAX_PAGES_MAX}
							value={values.maxPages ?? ""}
							onChange={(e) => {
								clearError("maxPages");
								handleMaxPagesInput(e);
							}}
							disabled={isLoading}
							aria-invalid={!!errors.maxPages}
							aria-describedby={
								errors.maxPages ? maxPagesErrId : undefined
							}
							className="w-24 text-center"
						/>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="outline"
									size="icon"
									aria-label="Increase max pages"
									onClick={() => handleMaxPagesStep(10)}
									disabled={
										isLoading ||
										(values.maxPages ??
											URL_MAX_PAGES_DEFAULT) >=
											URL_MAX_PAGES_MAX
									}
								>
									<PlusIcon className="size-4" />
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								Increase by 10 (max {URL_MAX_PAGES_MAX})
							</TooltipContent>
						</Tooltip>
						<span className="text-muted-foreground text-sm">
							pages
						</span>
					</div>
					{errors.maxPages ? (
						<p
							id={maxPagesErrId}
							className="mt-1 text-sm text-destructive"
							role="alert"
						>
							{errors.maxPages}
						</p>
					) : (
						<p className="mt-1 text-muted-foreground text-sm">
							Default {URL_MAX_PAGES_DEFAULT}. Range{" "}
							{URL_MAX_PAGES_MIN}–{URL_MAX_PAGES_MAX}. Raise for
							large help centers.
						</p>
					)}
				</div>
			)}

			{/* Refresh mode */}
			<div>
				<Label htmlFor="url-refresh-mode">Refresh</Label>
				<Select
					value={values.refreshMode}
					onValueChange={(v) =>
						onValuesChange({
							...values,
							refreshMode: v as UrlRefreshMode,
						})
					}
					disabled={isLoading}
				>
					<SelectTrigger
						id="url-refresh-mode"
						className="mt-2"
						aria-label="Refresh cadence"
					>
						<SelectValue placeholder="Refresh cadence" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="ONCE">
							Once (no auto-refresh)
						</SelectItem>
						<SelectItem value="DAILY">Daily</SelectItem>
						<SelectItem value="WEEKLY">Weekly</SelectItem>
						<SelectItem value="MONTHLY">Monthly</SelectItem>
						<SelectItem value="LIVE">
							Live (re-fetch on each AI run)
						</SelectItem>
					</SelectContent>
				</Select>
				<p className="mt-1 text-muted-foreground text-sm">
					Scheduled refreshes use Temporal. Live re-fetches at
					retrieval time and is not cached.
				</p>
			</div>

			{/* Source category — what this link actually is. Shared by both
			    modes, like scope and refresh: a bulk paste is one kind of
			    source pasted many times.

			    Nothing is pre-selected. A default would put a guess on record
			    as the user's answer, and the project readiness checklist reads
			    this to tell a wiki from a marketing page. */}
			{requireCategory && (
				<div>
					<Label htmlFor="url-source-category">
						What kind of source is this?
					</Label>
					<Select
						value={values.knowledgeBaseSourceCategory ?? ""}
						onValueChange={(v) => {
							// Clear only this field's errors. Wiping the whole
							// map would hide a URL error the user still has to
							// fix.
							setErrors({
								...errors,
								knowledgeBaseSourceCategory: undefined,
								knowledgeBaseSourceCategoryOther: undefined,
							});
							onValuesChange({
								...values,
								knowledgeBaseSourceCategory:
									v as KnowledgeBaseSourceCategoryValue,
							});
						}}
						disabled={isLoading}
					>
						<SelectTrigger
							id="url-source-category"
							className="mt-2"
							aria-label="Knowledge base source category"
							aria-invalid={
								errors.knowledgeBaseSourceCategory
									? true
									: undefined
							}
							aria-describedby={
								errors.knowledgeBaseSourceCategory
									? categoryErrId
									: undefined
							}
						>
							<SelectValue placeholder="Select a category" />
						</SelectTrigger>
						<SelectContent>
							{KNOWLEDGE_BASE_CATEGORY_OPTIONS.map((option) => (
								<SelectItem
									key={option.value}
									value={option.value}
								>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{errors.knowledgeBaseSourceCategory && (
						<p
							id={categoryErrId}
							className="mt-1 text-destructive text-sm"
						>
							{errors.knowledgeBaseSourceCategory}
						</p>
					)}

					{/* "Other" on its own says nothing, so it has to be
					    described before it can be saved. */}
					{values.knowledgeBaseSourceCategory === "OTHER" && (
						<div className="mt-3">
							<Label htmlFor="url-source-category-other">
								Describe the source
							</Label>
							<Input
								id="url-source-category-other"
								className="mt-2"
								maxLength={200}
								placeholder="e.g. internal runbook"
								value={
									values.knowledgeBaseSourceCategoryOther ??
									""
								}
								onChange={(e) =>
									onValuesChange({
										...values,
										knowledgeBaseSourceCategoryOther:
											e.target.value,
									})
								}
								disabled={isLoading}
								aria-invalid={
									errors.knowledgeBaseSourceCategoryOther
										? true
										: undefined
								}
								aria-describedby={
									errors.knowledgeBaseSourceCategoryOther
										? categoryOtherErrId
										: undefined
								}
							/>
							{errors.knowledgeBaseSourceCategoryOther && (
								<p
									id={categoryOtherErrId}
									className="mt-1 text-destructive text-sm"
								>
									{errors.knowledgeBaseSourceCategoryOther}
								</p>
							)}
						</div>
					)}
				</div>
			)}

			{/* Provider indicator — names the provider that would be picked
			    server-side. PATH_PREFIX always shows Firecrawl (crawl-only
			    capability in v1.1); SINGLE_PAGE shows whatever the picker
			    would prefer. Hidden when no provider qualifies (the notice
			    card already explains that case). */}
			{(() => {
				const effectiveProvider =
					values.scope === "PATH_PREFIX"
						? "firecrawl"
						: scrapeProviderName;
				if (!effectiveProvider) {
					return null;
				}
				return (
					<p
						className="text-xs text-muted-foreground"
						data-testid="url-source-indexing-with"
					>
						Indexing with{" "}
						<span className="font-medium text-foreground">
							{PROVIDER_DISPLAY_NAMES[effectiveProvider]}
						</span>
						.
					</p>
				);
			})()}

			{/* Bulk-mode progress card — visible while N parallel processLink
			    calls are in-flight. Ticks "Adding N URLs… (M / N done)". */}
			{bulkMode === "MULTI" &&
				linkStatus === "processing" &&
				bulkProgress !== null && (
					<output className="block space-y-2 rounded-lg border border-border bg-card p-3 text-primary">
						<div className="flex items-center gap-2">
							<LoaderIcon className="size-5 motion-safe:animate-spin" />
							<span className="text-sm text-foreground">
								Adding {bulkProgress.total} URL
								{bulkProgress.total === 1 ? "" : "s"}…{" "}
								<span className="text-muted-foreground">
									({bulkProgress.submitted} /{" "}
									{bulkProgress.total} done)
								</span>
							</span>
						</div>
						<div
							className="h-2 w-full overflow-hidden rounded-full bg-border"
							role="progressbar"
							aria-valuenow={bulkProgress.submitted}
							aria-valuemin={0}
							aria-valuemax={bulkProgress.total}
						>
							<div
								className="h-full rounded-full bg-primary motion-safe:transition-[width] motion-safe:duration-300"
								style={{
									width: `${
										bulkProgress.total === 0
											? 0
											: Math.round(
													(bulkProgress.submitted /
														bulkProgress.total) *
														100,
												)
									}%`,
								}}
							/>
						</div>
					</output>
				)}

			{/* Bulk-mode post-settle summary — per-URL outcomes. Stays
			    visible after the dialog's 2s auto-close window for the
			    all-success case; failures keep it pinned indefinitely until
			    the user closes the dialog. */}
			{bulkMode === "MULTI" &&
				bulkResults !== null &&
				linkStatus !== "processing" &&
				(() => {
					const successCount = bulkResults.filter((r) => r.ok).length;
					const failureCount = bulkResults.length - successCount;
					const failures = bulkResults.filter((r) => !r.ok);
					const allOk = failureCount === 0;
					return (
						<output
							className={cn(
								"block space-y-2 rounded-lg border bg-card p-3",
								allOk
									? "border-border text-secondary"
									: "border-destructive/30 text-destructive",
							)}
						>
							<div className="flex items-center gap-2">
								{allOk ? (
									<CheckCircleIcon className="size-5" />
								) : (
									<AlertCircleIcon className="size-5" />
								)}
								<span className="text-sm text-foreground">
									<span className="font-medium">
										{successCount}
									</span>{" "}
									added.
									{failureCount > 0 && (
										<>
											{" "}
											<span className="font-medium">
												{failureCount}
											</span>{" "}
											failed.
										</>
									)}
								</span>
							</div>
							{failures.length > 0 && (
								<ul className="space-y-1 pl-7 text-xs text-muted-foreground">
									{failures
										.slice(
											0,
											URL_BULK_INVALID_PREVIEW_LIMIT,
										)
										.map((f) => (
											<li
												key={f.url}
												className="break-all"
											>
												<span className="font-mono">
													{f.url}
												</span>
												{f.error ? `: ${f.error}` : ""}
											</li>
										))}
									{failures.length >
										URL_BULK_INVALID_PREVIEW_LIMIT && (
										<li className="italic">
											…and{" "}
											{failures.length -
												URL_BULK_INVALID_PREVIEW_LIMIT}{" "}
											more.
										</li>
									)}
								</ul>
							)}
						</output>
					);
				})()}

			{/* Status indicators — match the legacy tab's UX. Single-URL
			    only; the bulk branch has its own progress + summary
			    cards above so we don't double-up. */}
			{bulkMode === "SINGLE" && linkStatus === "processing" && (
				<output className="flex items-center gap-2 rounded-lg border border-border bg-card p-3 text-primary">
					<LoaderIcon className="size-5 motion-safe:animate-spin" />
					<span>Processing started…</span>
				</output>
			)}

			{bulkMode === "SINGLE" && linkStatus === "success" && (
				<output className="flex items-center gap-2 rounded-lg border border-border bg-card p-3 text-secondary">
					<CheckCircleIcon className="size-5" />
					<span>URL source added.</span>
				</output>
			)}

			{bulkMode === "SINGLE" &&
				linkStatus === "error" &&
				!noticeOverride && (
					<div
						className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-card p-3 text-destructive"
						role="alert"
					>
						<XCircleIcon className="size-5" />
						<span>Failed to add URL source. Please try again.</span>
					</div>
				)}
		</div>
	);
}

// ── Multi-URL paste form (Commit 4) ──────────────────────────────────────
//
// Renders the textarea + live-parsed preview only. The parent
// `UrlSourceTabContent` owns the shared scope / maxPages / refresh fields
// (they apply to both modes), the submit button (which lives in the dialog
// footer), and the progress / summary cards. Keeping the textarea-specific
// markup here keeps the parent diff small.

type BulkUrlsFormProps = {
	bulkRaw: string;
	onBulkRawChange: (next: string) => void;
	isLoading: boolean;
};

function BulkUrlsForm({
	bulkRaw,
	onBulkRawChange,
	isLoading,
}: BulkUrlsFormProps) {
	// Parse on every render — the textarea is the source of truth. The
	// preview, the submit-disabled state in the footer, and the count on the
	// Add button all derive from this same `parseBulkUrlLines` call.
	const parsed = useMemo(() => parseBulkUrlLines(bulkRaw), [bulkRaw]);
	const validLines = parsed.filter((l) => l.url !== null);
	const invalidLines = parsed.filter((l) => l.url === null);
	const overLimit = validLines.length > URL_BULK_MAX_LINES;
	// Dedupe count — `parseBulkUrlLines` already collapsed
	// case/trailing-slash variants. We compare against the non-blank raw
	// line count to surface "M duplicates skipped" so users understand why
	// the preview count is lower than the lines they pasted.
	const summary = useMemo(() => summariseBulkParse(bulkRaw), [bulkRaw]);
	const duplicateCount = summary.duplicates;

	return (
		<div className="space-y-3">
			<div>
				<Label htmlFor="link-url-bulk">URLs (one per line)</Label>
				<Textarea
					id="link-url-bulk"
					placeholder={
						"https://example.com/docs/intro\nhttps://example.com/docs/api\nhttps://example.com/blog/post"
					}
					value={bulkRaw}
					onChange={(e) => onBulkRawChange(e.target.value)}
					disabled={isLoading}
					rows={6}
					className="mt-2 resize-y font-mono text-sm bg-card border border-border focus:ring-1 focus:ring-primary"
				/>
				<p className="mt-1 text-muted-foreground text-sm">
					Paste one URL per line. Same scope / refresh settings will
					apply to all of them.
				</p>
			</div>

			{/* Live-parsed preview — count + invalid-line listing. Only
			    rendered when the user has typed something; an empty
			    textarea has no preview. */}
			{parsed.length > 0 && (
				<output className="block space-y-1.5" aria-live="polite">
					{validLines.length > 0 && (
						<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
							<CheckIcon className="size-3.5 text-secondary" />
							<span>
								<span className="font-medium text-foreground">
									{validLines.length}
								</span>{" "}
								URL{validLines.length === 1 ? "" : "s"} ready to
								add
							</span>
						</p>
					)}
					{duplicateCount > 0 && (
						<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
							<AlertCircleIcon className="size-3.5 text-highlight" />
							<span>
								<span className="font-medium text-foreground">
									{duplicateCount}
								</span>{" "}
								duplicate
								{duplicateCount === 1 ? "" : "s"} skipped
							</span>
						</p>
					)}
					{overLimit && (
						<p className="flex items-start gap-1.5 text-xs text-destructive">
							<AlertCircleIcon className="size-3.5 mt-0.5 shrink-0" />
							<span>
								Batches are limited to {URL_BULK_MAX_LINES} URLs
								at a time. Trim the list or run this twice.
							</span>
						</p>
					)}
					{invalidLines.length > 0 && (
						<>
							<p className="flex items-center gap-1.5 text-xs text-destructive">
								<AlertCircleIcon className="size-3.5" />
								<span>
									<span className="font-medium">
										{invalidLines.length}
									</span>{" "}
									line
									{invalidLines.length === 1 ? "" : "s"}{" "}
									couldn&apos;t be parsed (see below)
								</span>
							</p>
							<ul className="space-y-0.5 pl-5 text-xs text-muted-foreground">
								{invalidLines
									.slice(0, URL_BULK_INVALID_PREVIEW_LIMIT)
									.map((line) => (
										<li
											key={`${line.lineNumber}-${line.raw}`}
											className="break-all"
										>
											line {line.lineNumber}:{" "}
											<span className="font-mono">
												&ldquo;{line.raw}&rdquo;
											</span>
											{line.error
												? ` (${line.error})`
												: ""}
										</li>
									))}
								{invalidLines.length >
									URL_BULK_INVALID_PREVIEW_LIMIT && (
									<li className="italic">
										…and{" "}
										{invalidLines.length -
											URL_BULK_INVALID_PREVIEW_LIMIT}{" "}
										more.
									</li>
								)}
							</ul>
						</>
					)}
				</output>
			)}
		</div>
	);
}

// ── File queue row ────────────────────────────────────
//
// Per-file row in the multi-file upload list. Surfaces filename + size +
// status pill + a remove button. Status copy maps:
//   - queued       → "Ready"
//   - uploading    → "Uploading…"
//   - processing   → "Processing…"
//   - completed    → "Done"
//   - failed       → "Failed: {error}"
//
// Accessibility:
//   - Each row is a list item with the file's name as its accessible name.
//   - The remove button carries `aria-label="Remove {filename}"`.
//   - The status pill carries an `aria-label` mirroring the visible text so
//     screen readers announce state transitions ("Uploading", "Done", etc.).
//
// Editorial aesthetic: warm-neutral card (`bg-card border border-border`),
// `text-destructive` for failures (not red hex), `text-secondary` for the
// success done-state (rose-tint matches the rest of the dialog).

type FileQueueRowProps = {
	row: UploadedFileRow;
	onRemove: () => void;
	disabled: boolean;
};

function FileQueueRow({ row, onRemove, disabled }: FileQueueRowProps) {
	// Pick the icon from the resolved type, not the browser's claim: an untyped
	// file carries the octet-stream placeholder, which would show every one of
	// them as a generic document. #2139.
	const FileTypeIcon = getFileIcon(
		resolveContextUploadMime(row.mimeType, row.name),
	);
	const sizeMb = (row.size / (1024 * 1024)).toFixed(2);

	const isInFlight =
		row.status === "uploading" || row.status === "processing";
	const isTerminal = row.status === "completed" || row.status === "failed";
	const isFailed = row.status === "failed";

	const pillText: string = (() => {
		switch (row.status) {
			case "queued":
				return "Ready";
			case "uploading":
				return "Uploading…";
			case "processing":
				return "Processing…";
			case "completed":
				return "Done";
			case "failed":
				// Marker only. The reason renders on its own line below the
				// filename — see the error paragraph in the content column.
				return "Failed";
		}
	})();

	const failureReason = row.error ?? "Unknown error";

	// SR-visible state. Mirrors the visible pill copy so screen readers do
	// not need to parse the icon-color combination.
	const pillAriaLabel = pillText;

	return (
		<li
			data-testid={`file-queue-row-${row.id}`}
			className={cn(
				"flex items-center gap-3 rounded-lg border bg-card p-3",
				isFailed
					? "border-destructive/30"
					: isTerminal
						? "border-secondary/40"
						: "border-border",
			)}
		>
			<div
				className={cn(
					"shrink-0 rounded-md border border-border bg-card p-2",
					isFailed ? "text-destructive" : "text-muted-foreground",
				)}
			>
				<FileTypeIcon className="size-4" />
			</div>

			<div className="min-w-0 flex-1">
				<TruncatedText
					as="p"
					text={row.name}
					className="font-medium text-sm text-foreground"
				/>
				<p className="text-xs text-muted-foreground">{sizeMb} MB</p>
				{isFailed ? (
					<p className="mt-1 text-destructive text-xs">
						{failureReason}
					</p>
				) : null}
			</div>

			{/* Status pill */}
			<span
				role="status"
				aria-label={pillAriaLabel}
				className={cn(
					// `shrink-0`: the pill sits beside a `min-w-0 flex-1` name
					// column. Without it, pill copy longer than a word steals
					// the column's width and the filename disappears from the
					// row — which is what put the reason on its own line.
					"inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
					isFailed
						? "border-destructive/30 text-destructive"
						: row.status === "completed"
							? "border-secondary/40 text-secondary"
							: isInFlight
								? "border-border text-primary"
								: "border-border text-muted-foreground",
				)}
			>
				{isInFlight ? (
					<LoaderIcon className="size-3 motion-safe:animate-spin" />
				) : row.status === "completed" ? (
					<CheckCircleIcon className="size-3" />
				) : isFailed ? (
					<AlertCircleIcon className="size-3" />
				) : null}
				<span>{pillText}</span>
			</span>

			<Button
				variant="ghost"
				size="sm"
				onClick={onRemove}
				disabled={disabled && isInFlight}
				aria-label={`Remove ${row.name}`}
				className="shrink-0"
			>
				<XCircleIcon className="size-4" aria-hidden="true" />
			</Button>
		</li>
	);
}
