"use client";

import { useAnalytics } from "@analytics";
import { pmDetectedTypeDisplayName } from "@repo/utils";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { ConfluenceIcon } from "@saas/workflows/lib/plugins/confluence/icon";
import { MicrosoftTeamsIcon } from "@saas/workflows/lib/plugins/microsoft-teams/icon";
import { TruncatedText } from "@shared/components/TruncatedText";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { DestructiveTooltip } from "@ui/components/destructive-tooltip";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Skeleton } from "@ui/components/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import type { LucideIcon } from "lucide-react";
import {
	CheckCircleIcon,
	ChevronDownIcon,
	DownloadIcon,
	ExternalLinkIcon,
	EyeIcon,
	FileIcon,
	FileSpreadsheetIcon,
	FileTextIcon,
	FolderIcon,
	ImageIcon,
	InfoIcon,
	LinkIcon,
	LoaderIcon,
	MessageSquareIcon,
	MicIcon,
	MoreVerticalIcon,
	PlusIcon,
	SparklesIcon,
	TextIcon,
	TrashIcon,
	XCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	renderMarkdownToDocx,
	renderMarkdownToPdf,
	triggerBlobDownload,
} from "../lib/markdown-to-document";
import {
	ContextSourceDetailsDialog,
	ContextSourceMetaLine,
	EditSourceDetailsMenuItem,
} from "./ContextSourceDetailsDialog";
import { ContextSummaryPanel } from "./ContextSummaryPanel";
import { ContextUploaderDialog } from "./ContextUploaderDialog";
import { DownloadAllContextsButton } from "./DownloadAllContextsButton";
import {
	LinkContextManagePanel,
	type LinkContextRefreshMode,
	type LinkContextScope,
} from "./LinkContextManagePanel";
import { ProjectSectionHero } from "./ProjectSectionHero";
import { getPmToolBrandIcon } from "./stories/pm-sync/pm-tool-brand-icon";

// Context types that map to Class A (originals presigned directly) per
// spec §8.4. Everything else is Class B (TEXT/NOTE → .md) or Class C
// (LINK/INTEGRATION/MEETING_TRANSCRIPT → .txt).
const CLASS_A_TYPES = new Set(["FILE", "IMAGE", "DOCUMENT", "SPREADSHEET"]);
const CLASS_C_TYPES = new Set(["CODE_FILE", "CODE_FILE_SUMMARY"]);

/**
 * Maximum window during which we'll keep polling a still-in-flight context
 * row. After this, a stuck PENDING/EXTRACTING row is considered abandoned
 * (worker crash, lost Temporal workflow, etc.) and we stop polling so the
 * page doesn't keep transferring ~765 KB every 2s indefinitely. The user
 * can manually re-sync to recover. Exported for tests.
 */
export const MAX_POLL_DURATION_MS = 5 * 60 * 1000;

/**
 * True when a row created at `createdAtMs` is past the polling cap.
 * Exported so the unit test can assert the boundary without rendering the
 * whole component. Defensive against bogus future timestamps (clock skew):
 * those just keep polling normally — the cap only kicks in once enough
 * real elapsed time has accumulated.
 */
export function shouldStopPolling(createdAtMs: number, nowMs: number): boolean {
	const elapsed = nowMs - createdAtMs;
	return elapsed >= MAX_POLL_DURATION_MS;
}

type RowContext = {
	id: string;
	type: string;
	extractionStatus?: string | null;
	s3Path?: string | null;
	content?: string | null;
	fileSize?: number | null;
	sourceTitle?: string | null;
	originalFilename?: string | null;
	metadata?: unknown;
	sourceType?: string | null;
	aiInstructions?: string | null;
};

function getContextClass(ctx: RowContext): "A" | "B" | "C" {
	if (CLASS_A_TYPES.has(ctx.type)) {
		return "A";
	}
	if (CLASS_C_TYPES.has(ctx.type)) {
		return "C";
	}
	return "B";
}

function isContextDownloadable(ctx: RowContext): boolean {
	const cls = getContextClass(ctx);
	if (cls === "A") {
		return Boolean(ctx.s3Path);
	}
	// Class B/C download synthesizes a .md/.txt from `content`, so treat the
	// row as downloadable whenever content is present OR the extraction status
	// is COMPLETED. Legacy rows (pre-extractionStatus column) have a valid
	// `content` but `extractionStatus === null` — they would wrongly be
	// treated as pending otherwise.
	if (ctx.content && ctx.content.length > 0) {
		return true;
	}
	return ctx.extractionStatus === "COMPLETED";
}

function triggerBrowserDownload(url: string, filename: string): void {
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.rel = "noopener";
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
}

function getContextDisplayTitle(ctx: RowContext): string {
	const meta = (ctx.metadata ?? {}) as {
		title?: string;
		sourceTitle?: string;
		chatTopic?: string;
	};
	return (
		meta.chatTopic ||
		meta.title ||
		meta.sourceTitle ||
		ctx.sourceTitle ||
		ctx.originalFilename ||
		ctx.type
	);
}

// Notion icon component — decorative; visible "Notion" label always rendered
// alongside (avoids "NotionNotion" duplicate accessible-name).
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

// Slack icon component — decorative; visible "Slack" label always rendered
// alongside (avoids "SlackSlack" duplicate accessible-name).
function SlackIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
		</svg>
	);
}

type IntegrationProviderConfigEntry = {
	icon: React.ComponentType<{ className?: string }>;
	gradient: string;
	lightBg: string;
	badgeLabel: string;
	defaultTitle: string;
};

/**
 * Builds a PM-backlog provider entry (unified-project-setup spec §4.5 / D8,
 * Task 2.3). Reuses the shared brand icon for the detected PM type and uses
 * DESIGN TOKENS for the card visuals — `from-primary to-primary` /
 * `from-primary/10 to-primary/10` — so no NEW hardcoded hex is introduced in
 * this component (the pre-existing Slack/Teams brand-hex entries are out of
 * scope, §4.5). Status is never color-only: the recognizable brand icon is
 * always paired with a visible provider label (`badgeLabel`) per
 * `frontend/accessibility.md`.
 */
function pmBacklogProviderEntry(
	detectedType: string,
): IntegrationProviderConfigEntry {
	const Icon = getPmToolBrandIcon(detectedType) ?? MessageSquareIcon;
	const label = pmDetectedTypeDisplayName(detectedType) ?? "Backlog";
	return {
		icon: Icon,
		gradient: "from-primary to-primary",
		lightBg: "from-primary/10 to-primary/10",
		badgeLabel: label,
		defaultTitle: `${label} Backlog`,
	};
}

/** Provider-specific overrides for INTEGRATION context cards */
const integrationProviderConfig: Record<
	string,
	IntegrationProviderConfigEntry
> = {
	SLACK: {
		icon: SlackIcon,
		gradient: "from-[#4A154B] to-[#611f69]",
		lightBg: "from-[#4A154B]/10 to-[#611f69]/10",
		badgeLabel: "Slack",
		defaultTitle: "Slack Channel",
	},
	MICROSOFT_TEAMS: {
		icon: MicrosoftTeamsIcon,
		gradient: "from-[#464EB8] to-[#6264A7]",
		lightBg: "from-[#464EB8]/10 to-[#6264A7]/10",
		badgeLabel: "Teams",
		defaultTitle: "Teams Chat",
	},
	// Key is lowercase "confluence" — it must equal the stored
	// `metadata.provider` exactly (the lookup does no uppercasing). Wrong casing
	// silently falls back to a generic "Integration" card. Uses DESIGN TOKENS
	// (no brand hex) per the editorial-restraint guidance, like the PM-backlog
	// entries above.
	confluence: {
		icon: ConfluenceIcon,
		gradient: "from-primary to-primary",
		lightBg: "from-primary/10 to-primary/10",
		badgeLabel: "Confluence",
		defaultTitle: "Confluence Page",
	},
	// PM-backlog providers (D8 / Task 2.3). Keys are the UPPERCASE provider
	// tokens emitted by `backlogProviderToken()` for a connected backlog. All
	// use design tokens (no new hex) and the recognizable shared brand icon.
	AZURE_DEVOPS: pmBacklogProviderEntry("azure-devops"),
	JIRA: pmBacklogProviderEntry("jira"),
	GITLAB: pmBacklogProviderEntry("gitlab"),
	GITHUB: pmBacklogProviderEntry("github"),
	FIZZY: pmBacklogProviderEntry("fizzy"),
	LINEAR: pmBacklogProviderEntry("linear"),
	TRELLO: pmBacklogProviderEntry("trello"),
	ASANA: pmBacklogProviderEntry("asana"),
	MONDAY: pmBacklogProviderEntry("monday"),
	CLICKUP: pmBacklogProviderEntry("clickup"),
};

type Props = {
	projectId: string;
};

const contextTypeConfig: Record<
	string,
	{
		// Custom brand SVGs (e.g. the local Slack icon) are not lucide glyphs, so
		// the icon slot accepts any className-taking component — mirrors
		// `IntegrationProviderConfigEntry`.
		icon: React.ComponentType<{ className?: string }>;
		gradient: string;
		lightBg: string;
		label: string;
	}
> = {
	FILE: {
		icon: FileTextIcon,
		gradient: "from-blue-500 to-indigo-500",
		lightBg: "from-blue-500/10 to-indigo-500/10",
		label: "File",
	},
	LINK: {
		icon: LinkIcon,
		gradient: "from-purple-500 to-pink-500",
		lightBg: "from-purple-500/10 to-pink-500/10",
		label: "Link",
	},
	TEXT: {
		icon: TextIcon,
		gradient: "from-amber-500 to-orange-500",
		lightBg: "from-amber-500/10 to-orange-500/10",
		label: "Text",
	},
	IMAGE: {
		icon: ImageIcon,
		gradient: "from-emerald-500 to-green-500",
		lightBg: "from-emerald-500/10 to-green-500/10",
		label: "Image",
	},
	SPREADSHEET: {
		icon: FileSpreadsheetIcon,
		gradient: "from-teal-500 to-cyan-500",
		lightBg: "from-teal-500/10 to-cyan-500/10",
		label: "Spreadsheet",
	},
	DOCUMENT: {
		icon: FileIcon,
		gradient: "from-rose-500 to-red-500",
		lightBg: "from-rose-500/10 to-red-500/10",
		label: "Document",
	},
	INTEGRATION: {
		icon: MessageSquareIcon,
		gradient: "from-violet-500 to-purple-600",
		lightBg: "from-violet-500/10 to-purple-600/10",
		label: "Integration",
	},
	MEETING_TRANSCRIPT: {
		icon: MicIcon,
		gradient: "from-[#464EB8] to-[#6264A7]",
		lightBg: "from-[#464EB8]/10 to-[#6264A7]/10",
		label: "Transcript",
	},
	// Slack huddle AI-notes canvases ingested as passive AI-Updates context.
	// Design tokens only (no new hardcoded brand hex) per spec §8.2 — mirrors
	// `pmBacklogProviderEntry`'s token-based card visuals.
	SLACK_HUDDLE_NOTES: {
		icon: SlackIcon,
		gradient: "from-primary to-primary",
		lightBg: "from-primary/10 to-primary/10",
		label: "Huddle Notes",
	},
};

const extractionStatusConfig: Record<
	string,
	{ icon: LucideIcon; color: string; label: string }
> = {
	PENDING: {
		icon: LoaderIcon,
		color: "text-foreground/40",
		label: "Pending",
	},
	EXTRACTING: {
		icon: LoaderIcon,
		color: "text-primary",
		label: "Extracting...",
	},
	COMPLETED: {
		icon: CheckCircleIcon,
		color: "text-success",
		label: "Ready",
	},
	FAILED: {
		icon: XCircleIcon,
		color: "text-destructive",
		label: "Failed",
	},
};

/**
 * "Failed" over a row whose content is sitting right there is a lie the user
 * cannot check.
 *
 * `extractionStatus` is written by two different steps. Extraction fills
 * `content`; embedding then indexes it for search, and when only THAT fails
 * (`context-embedding.ts`) it stamps the same `FAILED` on the row. A staging
 * sweep on 18 Aug 2026 found all 49 meeting transcripts in one project flagged
 * red — every one of them stored in full and perfectly readable — because a
 * single embedding deployment was misconfigured. The badge said the content was
 * broken; the truth was that search could not reach it.
 *
 * So: a FAILED row that still has content gets the narrower, accurate label. No
 * schema change and no new state — the presence of content is already the
 * evidence that extraction finished.
 */
const NOT_SEARCHABLE_STATUS = {
	icon: InfoIcon,
	color: "text-highlight",
	label: "Not searchable",
};

/**
 * Stored, readable, but search cannot reach it.
 *
 * Every reader of a context row has to agree on this, or the page contradicts
 * itself: the badge said "Not searchable" while the readiness counter above it
 * tallied the same row under Ready, and the LINK card said "Indexed". One
 * predicate, three callers.
 */
function isStoredButNotSearchable(context: {
	extractionStatus?: string | null;
	extractionError?: string | null;
	content?: string | null;
}) {
	const status = context.extractionStatus || "PENDING";

	// Two shapes mean the same thing, and both have to render.
	//
	// SINCE THE FIX: an indexing failure records its reason and leaves a
	// completed extraction COMPLETED (`recordContextIndexingFailure`). A
	// COMPLETED row carrying an error is therefore stored and readable, but
	// unreachable by search. The success path clears the error, so this never
	// lingers on a row a retry later indexed.
	//
	// BEFORE IT: the same failure stamped FAILED over the completed extraction.
	// Those rows are never backfilled — 49 of them sat in a single staging
	// project — so the old narrowing stays: FAILED with content is the same
	// state, recorded by an older writer.
	if (status === "COMPLETED" && (context.extractionError ?? "").length > 0) {
		return true;
	}
	return status === "FAILED" && (context.content ?? "").trim().length > 0;
}

function resolveExtractionStatus(context: {
	extractionStatus?: string | null;
	extractionError?: string | null;
	content?: string | null;
}) {
	const status = context.extractionStatus || "PENDING";

	// Two shapes mean the same thing, and both have to render.
	//
	// See `isStoredButNotSearchable` for why both shapes count.
	if (isStoredButNotSearchable(context)) {
		return NOT_SEARCHABLE_STATUS;
	}
	return extractionStatusConfig[status] || extractionStatusConfig.PENDING;
}

/**
 * Inline status row for a LINK card — mirrors the pattern used by the
 * non-LINK context cards (Backlog Items / Meeting Transcripts) where status
 * is plain colored text + a small lucide icon, NOT a chip-style badge.
 *
 *  - COMPLETED → ✓ Indexed  ✓ Embedded  Last synced X ago  (emerald)
 *  - PENDING / EXTRACTING → ↻ Crawling…  Started X ago      (highlight/amber)
 *  - FAILED  → ✗ Failed  Last attempted X ago               (destructive)
 *
 * PM feedback (post-staging): the chip pill stood out as the only badge on
 * the contexts list. This matches the inline-text rhythm used everywhere
 * else on the same page.
 */
// Exported so `ContextPendingItemsList` can type-check the LINK rows it
// hands to the reused `UrlContextCard` without re-deriving the shape.
export type UrlContextRowFields = {
	id: string;
	type: string;
	sourceUrl: string | null;
	sourceTitle: string | null;
	extractionStatus: string | null;
	extractionError: string | null;
	urlScope: LinkContextScope | null;
	urlMaxPages: number | null;
	urlRefreshMode: LinkContextRefreshMode | null;
	urlLastSyncedAt: Date | string | null;
	createdAt: Date | string;
	embeddedAt?: Date | string | null;
	metadata: unknown;
	sourceType?: string | null;
	aiInstructions?: string | null;
};

/**
 * Inline status row for the LINK card. Mirrors the rhythm used by the
 * sibling Backlog Items / Meeting Transcripts rows on the same page:
 * plain colored text with a small lucide icon, no chip backgrounds.
 *
 * Visual states:
 *  - COMPLETED → ✓ Indexed  (✓ Embedded?)  Last synced X ago    (emerald)
 *  - PENDING / EXTRACTING → ↻ Crawling…  Started X ago          (amber/highlight)
 *  - FAILED  → ✗ Failed  Last attempted X ago                   (destructive)
 */
function LinkStatusRow({
	extractionStatus,
	extractionError,
	embeddedAt,
	lastSyncedAt,
	createdAt,
}: {
	extractionStatus: string | null;
	extractionError?: string | null;
	embeddedAt: Date | string | null | undefined;
	lastSyncedAt: Date | null;
	createdAt: Date | null;
}) {
	const referenceTime = lastSyncedAt ?? createdAt;
	const referenceLabel =
		extractionStatus === "FAILED"
			? "Last attempted"
			: lastSyncedAt
				? "Last synced"
				: "Added";

	let primary: React.ReactNode;
	// `url-source-crawl` stamps the parent row COMPLETED and only THEN embeds
	// it, so an indexing failure lands on an already-completed row. Reading
	// status alone showed a green "Indexed" over a source RAG cannot retrieve a
	// single chunk from, with the reason surfaced nowhere.
	if (isStoredButNotSearchable({ extractionStatus, extractionError })) {
		primary = (
			<span
				className="flex items-center gap-1 text-highlight"
				data-testid="link-status-not-searchable"
			>
				<InfoIcon className="size-3.5" aria-hidden="true" />
				Not searchable
			</span>
		);
	} else if (extractionStatus === "COMPLETED") {
		primary = (
			<span
				className="flex items-center gap-1 text-success"
				data-testid="link-status-indexed"
			>
				<CheckCircleIcon className="size-3.5" aria-hidden="true" />
				Indexed
			</span>
		);
	} else if (extractionStatus === "FAILED") {
		primary = (
			<span
				className="flex items-center gap-1 text-destructive"
				data-testid="link-status-failed"
			>
				<XCircleIcon className="size-3.5" aria-hidden="true" />
				Failed
			</span>
		);
	} else {
		primary = (
			<span
				className="flex items-center gap-1 text-highlight"
				data-testid="link-status-crawling"
			>
				<LoaderIcon
					className="size-3.5 motion-safe:animate-spin"
					aria-hidden="true"
				/>
				Processing…
			</span>
		);
	}

	return (
		<div
			className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-foreground/50 text-xs"
			data-testid="link-status-row"
		>
			{primary}
			{extractionStatus === "COMPLETED" && embeddedAt && (
				<span
					className="flex items-center gap-1 text-success"
					data-testid="link-status-embedded"
				>
					<CheckCircleIcon className="size-3.5" aria-hidden="true" />
					Embedded
				</span>
			)}
			{referenceTime && (
				<span>
					{referenceLabel}{" "}
					{formatDistanceToNow(referenceTime, { addSuffix: true })}
				</span>
			)}
		</div>
	);
}

// Exported so `ContextPendingItemsList` (wizard pending-items list) can
// reuse the LINK-card rendering verbatim. Spec §7.5 + planning note
// `group-8-card-extraction.md` (LINK rows are 1:1 with the post-creation
// surface — the only row type the wizard surface and the post-creation
// surface need to share via component reuse rather than markup copy).
export function UrlContextCard({
	context,
	projectId,
	onDelete,
	deletePending,
	deleteCopy,
	onDownload,
}: {
	context: UrlContextRowFields;
	projectId: string;
	onDelete: (id: string) => void;
	deletePending: boolean;
	deleteCopy: { label: string; warning: string };
	onDownload?: (id: string) => void;
}) {
	const metadata =
		(context.metadata as { sourceTitle?: string } | null) ?? {};
	const title =
		metadata.sourceTitle ||
		context.sourceTitle ||
		context.sourceUrl ||
		"URL source";
	const sourceUrl = context.sourceUrl;
	const lastSynced = context.urlLastSyncedAt
		? typeof context.urlLastSyncedAt === "string"
			? new Date(context.urlLastSyncedAt)
			: context.urlLastSyncedAt
		: null;
	const createdAt = context.createdAt
		? typeof context.createdAt === "string"
			? new Date(context.createdAt)
			: context.createdAt
		: null;

	return (
		<div
			className="group relative overflow-hidden rounded-xl border border-border bg-card motion-safe:transition-colors hover:border-primary/30"
			data-context-type="LINK"
			data-testid={`link-card-${context.id}`}
		>
			<div className="flex items-start gap-3 p-4">
				<div
					className="shrink-0 rounded-md border border-border bg-muted p-2 text-primary"
					aria-hidden="true"
				>
					<LinkIcon className="size-5" />
				</div>

				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<TruncatedText
							as="h3"
							text={title}
							className="font-semibold text-sm"
						/>
						<Badge
							variant="outline"
							className="shrink-0 border-foreground/20 text-xs"
						>
							Link
						</Badge>
					</div>

					<ContextSourceMetaLine
						sourceType={context.sourceType}
						aiInstructions={context.aiInstructions}
					/>

					<LinkStatusRow
						extractionStatus={context.extractionStatus}
						extractionError={context.extractionError}
						embeddedAt={context.embeddedAt}
						lastSyncedAt={lastSynced}
						createdAt={createdAt}
					/>

					{sourceUrl && (
						<a
							href={sourceUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="mt-1 flex items-center gap-1 text-primary text-xs hover:underline"
							onClick={(e) => e.stopPropagation()}
							data-testid="link-card-source-url"
						>
							<ExternalLinkIcon
								className="size-3"
								aria-hidden="true"
							/>
							<TruncatedText
								as="span"
								text={sourceUrl}
								className="max-w-[260px]"
							/>
						</a>
					)}
				</div>

				{/* Right-side action cluster — Eye (full view) + More
				    (Sync / Download / Delete). Matches the sibling cards'
				    affordance pattern. Download mirrors what Backlog /
				    Meeting-Transcripts rows offer. */}
				<LinkContextManagePanel
					contextId={context.id}
					projectId={projectId}
					sourceType={context.sourceType}
					aiInstructions={context.aiInstructions}
					sourceName={title}
					onDelete={() => onDelete(context.id)}
					deletePending={deletePending}
					deleteCopy={deleteCopy}
					onDownload={
						onDownload ? () => onDownload(context.id) : undefined
					}
					isCrawling={
						context.extractionStatus === "PENDING" ||
						context.extractionStatus === "EXTRACTING"
					}
				/>
			</div>
		</div>
	);
}

export function ProjectContextsList({ projectId }: Props) {
	const { organizationId, organizationSlug } = useOrganizationContext();
	const [uploaderOpen, setUploaderOpen] = useState(false);
	// Context Source Type Labeling (#1888): the row menus flip this target;
	// the ONE dialog rendering it lives outside every Radix menu tree.
	const [detailsTarget, setDetailsTarget] = useState<{
		contextId: string;
		sourceName: string;
		initialSourceType: string | null;
		initialAiInstructions: string | null;
	} | null>(null);

	// Base path for internal viewer / settings deep-links. Org context prefixes
	// the slug; personal context does not. Net-new here — the list did not
	// previously build internal viewer routes.
	const projectBasePath = organizationSlug
		? `/app/${organizationSlug}/projects/${projectId}`
		: `/app/projects/${projectId}`;
	const t = useTranslations("tooltips.contextSources");
	const tDownload = useTranslations("projects.contexts.download");
	const { trackEvent } = useAnalytics();

	const handleDownloadRow = useCallback(
		async (ctx: RowContext, format: "md" | "pdf" | "docx" = "md") => {
			try {
				const res = await orpc.projects.contexts.createDownloadUrl.call(
					{
						contextId: ctx.id,
						projectId,
						organizationId,
					},
				);
				// Class A is always the original binary — `format` is ignored.
				// Class B/C with `format === "md"` keeps the existing path
				// (anchor-click the presigned URL — server already returns .md).
				if (format === "md" || getContextClass(ctx) === "A") {
					triggerBrowserDownload(res.url, res.filename);
				} else {
					// Fetch the synthesized markdown text from the presigned URL,
					// then render to PDF / DOCX in the browser before saving.
					const markdownResp = await fetch(res.url);
					if (!markdownResp.ok) {
						throw new Error(
							`Failed to fetch context text: ${markdownResp.status}`,
						);
					}
					const markdown = await markdownResp.text();
					const title = getContextDisplayTitle(ctx);
					const blob =
						format === "pdf"
							? await renderMarkdownToPdf(markdown)
							: await renderMarkdownToDocx(markdown, title);
					// Swap the server-issued filename's extension to the chosen
					// format. Fallback: append the new extension if no dot found.
					const dot = res.filename.lastIndexOf(".");
					const stem =
						dot > 0 ? res.filename.slice(0, dot) : res.filename;
					triggerBlobDownload(blob, `${stem}.${format}`);
				}
				trackEvent("project_context_downloaded", {
					contextId: ctx.id,
					projectId,
					type: ctx.type,
					organizationId,
					format,
				});
			} catch (_err) {
				toast.error(tDownload("failed"));
			}
		},
		[organizationId, projectId, tDownload, trackEvent],
	);

	const renderDownloadMenuItem = (ctx: RowContext) => {
		// Context Source Type Labeling (#1888): every row menu carries the
		// Edit-details item ahead of Download/Delete. The item only flips
		// `detailsTarget` — the dialog itself lives OUTSIDE the Radix menu
		// tree, which unmounts its content on close.
		const editItem = (
			<EditSourceDetailsMenuItem
				testId={`context-edit-details-${ctx.id}`}
				onOpen={() =>
					setDetailsTarget({
						contextId: ctx.id,
						sourceName: getContextDisplayTitle(ctx),
						initialSourceType: ctx.sourceType ?? null,
						initialAiInstructions: ctx.aiInstructions ?? null,
					})
				}
			/>
		);

		// Only render the Download item when the context can actually be
		// downloaded. Hiding is a better UX than a disabled item with a
		// "still processing" tooltip — the menu stays focused on the actions
		// the user can take right now.
		if (!isContextDownloadable(ctx)) {
			return editItem;
		}
		const cls = getContextClass(ctx);
		const title = getContextDisplayTitle(ctx);

		// Class A: single Download item — the original binary is presigned
		// directly. Format choice doesn't apply (image→PDF / xlsx→DOCX is
		// out of scope by design).
		if (cls === "A") {
			return (
				<>
					{editItem}
					<DropdownMenuItem
						aria-label={tDownload("actionForRow", { title })}
						onSelect={(e) => {
							e.preventDefault();
							void handleDownloadRow(ctx, "md");
						}}
					>
						<DownloadIcon
							className="mr-2 size-4"
							aria-hidden="true"
						/>
						{tDownload("action")}
					</DropdownMenuItem>
					<DropdownMenuSeparator />
				</>
			);
		}

		// Class B/C: format submenu — server returns synthesized .md, the
		// browser converts to PDF/DOCX via `renderMarkdownToPdf` /
		// `renderMarkdownToDocx` (see handleDownloadRow). Info tooltip about
		// "extracted text, not original source" stays attached to the parent
		// label.
		//
		// Layout: `gap-2` on the sub-trigger gives a uniform spacing between
		// every child (download icon · label · info · chevron), instead of
		// hardcoding `mr-2`/`ml-3` on individual elements — that approach
		// glued the InfoIcon to the chevron because Radix's chevron uses
		// `ml-auto` and consumed the trailing flex space.
		return (
			<>
				{editItem}
				<TooltipProvider>
					<DropdownMenuSub>
						<DropdownMenuSubTrigger
							className="gap-2"
							aria-label={tDownload("format.aria")}
						>
							<DownloadIcon
								className="size-4"
								aria-hidden="true"
							/>
							<span className="flex-1">
								{tDownload("action")}
							</span>
							<Tooltip>
								<TooltipTrigger asChild>
									<InfoIcon
										className="size-3.5 shrink-0 text-muted-foreground"
										aria-hidden="true"
									/>
								</TooltipTrigger>
								<TooltipContent side="left">
									{tDownload("extractedTextWarning")}
								</TooltipContent>
							</Tooltip>
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							<DropdownMenuItem
								onSelect={(e) => {
									e.preventDefault();
									void handleDownloadRow(ctx, "md");
								}}
							>
								{tDownload("format.markdown")}
							</DropdownMenuItem>
							<DropdownMenuItem
								onSelect={(e) => {
									e.preventDefault();
									void handleDownloadRow(ctx, "pdf");
								}}
							>
								{tDownload("format.pdf")}
							</DropdownMenuItem>
							<DropdownMenuItem
								onSelect={(e) => {
									e.preventDefault();
									void handleDownloadRow(ctx, "docx");
								}}
							>
								{tDownload("format.docx")}
							</DropdownMenuItem>
						</DropdownMenuSubContent>
					</DropdownMenuSub>
					<DropdownMenuSeparator />
				</TooltipProvider>
			</>
		);
	};

	const { data, isLoading, error } = useQuery(
		orpc.projects.contexts.list.queryOptions({
			input: { projectId, organizationId },
			// Bug #1039: poll while any context is still being processed so the
			// user sees PENDING/EXTRACTING → COMPLETED transition without manual
			// refresh. Stop polling once everything settled.
			//
			// `MAX_POLL_DURATION_MS` caps the polling at 5 minutes from the
			// row's `createdAt`. Without this, a context stuck in PENDING /
			// EXTRACTING (worker crash, lost workflow, etc.) keeps the list
			// polling every 2s indefinitely — at ~765 KB per response that
			// burned several MB per session for nothing. After the cap
			// elapses the row is treated as stale; the user can manually
			// re-sync (LINK rows) or re-upload (other types) to recover.
			refetchInterval: (query) => {
				const contexts = query.state.data?.contexts ?? [];
				const nowMs = Date.now();
				const hasFreshInProgress = contexts.some((ctx) => {
					if (
						ctx.extractionStatus !== "PENDING" &&
						ctx.extractionStatus !== "EXTRACTING"
					) {
						return false;
					}
					const createdAtMs = ctx.createdAt
						? new Date(ctx.createdAt).getTime()
						: nowMs;
					return !shouldStopPolling(createdAtMs, nowMs);
				});
				return hasFreshInProgress ? 2000 : false;
			},
		}),
	);

	const queryClient = useQueryClient();

	const deleteMutation = useMutation({
		mutationFn: (contextId: string) =>
			orpc.projects.contexts.delete.call({
				id: contextId,
				projectId,
				organizationId,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: orpc.projects.contexts.list.queryOptions({
					input: { projectId, organizationId },
				}).queryKey,
			});
		},
	});

	const contexts = data?.contexts ?? [];

	// Separate meeting transcripts, Notion docs, and Teams chats from other contexts
	const { otherContexts, transcriptGroups, notionGroup, teamsGroup } =
		useMemo(() => {
			const other: typeof contexts = [];
			const notionContexts: typeof contexts = [];
			const teamsContexts: typeof contexts = [];
			const transcriptsByMeeting = new Map<
				string,
				{ key: string; subject: string; transcripts: typeof contexts }
			>();

			for (const ctx of contexts) {
				const meta = (ctx.metadata ?? {}) as Record<string, unknown>;

				if (ctx.type === "MEETING_TRANSCRIPT") {
					const meetingMeta = meta as {
						meetingSubject?: string;
						meetingId?: string;
					};
					const groupKey =
						meetingMeta.meetingId ||
						meetingMeta.meetingSubject ||
						"Unknown Meeting";
					const subject =
						meetingMeta.meetingSubject || "Meeting Transcript";
					const existing = transcriptsByMeeting.get(groupKey);
					if (existing) {
						existing.transcripts.push(ctx);
					} else {
						transcriptsByMeeting.set(groupKey, {
							key: groupKey,
							subject,
							transcripts: [ctx],
						});
					}
				} else if (meta.provider === "notion") {
					notionContexts.push(ctx);
				} else if (meta.provider === "MICROSOFT_TEAMS") {
					teamsContexts.push(ctx);
				} else {
					other.push(ctx);
				}
			}

			// Sort transcripts within each group by meetingDate descending
			for (const group of transcriptsByMeeting.values()) {
				group.transcripts.sort((a, b) => {
					const dateA = (a.metadata as { meetingDate?: string })
						?.meetingDate;
					const dateB = (b.metadata as { meetingDate?: string })
						?.meetingDate;
					if (!dateA && !dateB) {
						return 0;
					}
					if (!dateA) {
						return 1;
					}
					if (!dateB) {
						return -1;
					}
					return (
						new Date(dateB).getTime() - new Date(dateA).getTime()
					);
				});
			}

			// Sort Notion docs by creation date descending
			notionContexts.sort(
				(a, b) =>
					new Date(b.createdAt).getTime() -
					new Date(a.createdAt).getTime(),
			);

			// Sort Teams chats by creation date descending
			teamsContexts.sort(
				(a, b) =>
					new Date(b.createdAt).getTime() -
					new Date(a.createdAt).getTime(),
			);

			return {
				otherContexts: other,
				transcriptGroups: Array.from(transcriptsByMeeting.values()),
				notionGroup: notionContexts.length > 0 ? notionContexts : null,
				teamsGroup: teamsContexts.length > 0 ? teamsContexts : null,
			};
		}, [contexts]);

	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
		new Set(),
	);
	const toggleGroup = (key: string) => {
		setExpandedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	};

	if (isLoading) {
		return (
			<div className="grid gap-4 sm:grid-cols-2">
				{[1, 2, 3, 4].map((i) => (
					<Skeleton key={i} className="h-32 w-full rounded-xl" />
				))}
			</div>
		);
	}

	if (error) {
		// Inline, contained error (FR-6 / AC5) — a bordered card rather than a
		// crash or full-page takeover. The transcript list shares this single
		// contexts query, so a list-load failure surfaces here for the whole
		// list (including the Meeting Transcripts group) without blocking the
		// rest of the project UI. Errors flow through the oRPC error pipeline so
		// Application Insights captures them via existing channels.
		return (
			<div
				className="rounded-xl border border-destructive/40 bg-destructive/5 p-6"
				role="alert"
				data-testid="contexts-list-error"
			>
				<p className="text-destructive">
					Failed to load contexts: {error.message}
				</p>
			</div>
		);
	}

	// Counted through the same predicate the row badges use. Counting raw
	// status tallied a row whose own badge reads "Not searchable" under Ready,
	// and left Needs Care — the counter whose entire job is surfacing rows that
	// want attention — reporting nothing to attend to.
	type ReadinessRow = {
		extractionStatus?: string | null;
		extractionError?: string | null;
		content?: string | null;
	};
	const notSearchableCount = contexts.filter((context) =>
		isStoredButNotSearchable(context as ReadinessRow),
	).length;
	const readyCount = contexts.filter(
		(context) =>
			(context as ReadinessRow).extractionStatus === "COMPLETED" &&
			!isStoredButNotSearchable(context as ReadinessRow),
	).length;
	const activeCount = contexts.filter((context) =>
		["PENDING", "EXTRACTING"].includes(
			(context as { extractionStatus?: string }).extractionStatus ||
				"PENDING",
		),
	).length;
	const failedCount =
		contexts.filter(
			(context) =>
				(context as ReadinessRow).extractionStatus === "FAILED" &&
				!isStoredButNotSearchable(context as ReadinessRow),
		).length + notSearchableCount;

	const totalBytesEstimate = contexts.reduce((sum, ctx) => {
		const row = ctx as unknown as RowContext;
		if (getContextClass(row) === "A") {
			return sum + (row.fileSize ?? 0);
		}
		return sum + (row.content?.length ?? 0);
	}, 0);

	return (
		<div className="space-y-6">
			<ProjectSectionHero
				eyebrow="Project Context"
				title="Reference material, research, and supporting signal"
				description="Bring in the files, links, notes, and integrations that make project recommendations more grounded and document generation more accurate."
				getStartedPageId="context"
				badges={
					<>
						<div className="rounded-full border border-border/60 bg-background/50 px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-muted-foreground">
							{contexts.length} context item
							{contexts.length !== 1 ? "s" : ""}
						</div>
						<div className="rounded-full border border-border/60 bg-background/50 px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-muted-foreground">
							Files, links, notes, and imports
						</div>
					</>
				}
				aside={
					<div className="flex h-full flex-col justify-between">
						<div>
							<p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
								Context Readiness
							</p>
							<div
								data-onboarding-target="context-readiness"
								className="mt-4 grid grid-cols-3 gap-3"
							>
								<div className="rounded-2xl border border-border/60 bg-background/50 p-3 text-center">
									<p
										className="text-2xl font-semibold tabular-nums text-foreground"
										data-testid="context-readiness-ready"
									>
										{readyCount}
									</p>
									<p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
										Ready
									</p>
								</div>
								<div className="rounded-2xl border border-border/60 bg-background/50 p-3 text-center">
									<p className="text-2xl font-semibold tabular-nums text-primary">
										{activeCount}
									</p>
									<p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
										Active
									</p>
								</div>
								<div className="rounded-2xl border border-border/60 bg-background/50 p-3 text-center">
									<p
										className="text-2xl font-semibold tabular-nums text-foreground/75"
										data-testid="context-readiness-failed"
									>
										{failedCount}
									</p>
									<p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
										Needs Care
									</p>
								</div>
							</div>
						</div>
						<div className="mt-6 rounded-2xl border border-border/60 bg-card/40 p-4">
							<p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
								Next Move
							</p>
							<p className="mt-2 text-sm text-foreground/85">
								Add raw source material here before regenerating
								documents or roadmaps so the outputs reflect the
								full project picture.
							</p>
							<div className="mt-4 flex flex-wrap items-center gap-2">
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											data-onboarding-target="context-add"
											onClick={() =>
												setUploaderOpen(true)
											}
											className="gap-2 border border-primary/20 bg-primary/12 text-primary hover:bg-primary/18"
											variant="ghost"
										>
											<PlusIcon className="size-4" />
											Add Context
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{t("addContext")}
									</TooltipContent>
								</Tooltip>
								<DownloadAllContextsButton
									projectId={projectId}
									organizationId={organizationId}
									totalContexts={contexts.length}
									totalBytesEstimate={totalBytesEstimate}
								/>
							</div>
						</div>
					</div>
				}
			/>

			<ContextSummaryPanel projectId={projectId} />

			{/* Contexts list */}
			{contexts.length === 0 ? (
				<div className="flex flex-col items-center justify-center rounded-[28px] border border-border/60 bg-card/40 py-16 backdrop-blur-sm">
					<div className="mb-4 rounded-2xl border border-primary/15 bg-primary/10 p-4 text-primary">
						<FolderIcon className="size-8 text-primary" />
					</div>
					<p className="mb-2 font-medium text-foreground/70">
						No context yet
					</p>
					<p className="mb-6 max-w-md text-center text-foreground/50 text-sm">
						Add files, links, or text to provide context for your
						project. This helps generate better, more accurate
						documents.
					</p>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								onClick={() => setUploaderOpen(true)}
								className="gap-2 border border-primary/20 bg-primary/12 text-primary hover:bg-primary/18"
								variant="ghost"
							>
								<SparklesIcon className="size-4" />
								Add First Context
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("addContext")}</TooltipContent>
					</Tooltip>
				</div>
			) : (
				<div className="space-y-4">
					{/* Integration groups: Meetings, Teams, Notion. The grid
					    always renders so the Meeting Transcripts empty state
					    (FR-5 / D6) can take the place of the meetings group
					    when no transcripts exist. */}
					<div className="grid gap-4 sm:grid-cols-2">
						{/* Meetings top-level group (contains meeting sub-groups) */}
						{transcriptGroups.length > 0 &&
							(() => {
								const totalTranscripts =
									transcriptGroups.reduce(
										(sum, g) => sum + g.transcripts.length,
										0,
									);
								// #2170: a meeting somebody added from their own
								// calendar was never "synced" — nothing pulled it
								// in, a person put it there. Saying otherwise
								// hides the only fact that matters about it: it
								// is here because a teammate chose to share it.
								const importedTranscripts =
									transcriptGroups.reduce(
										(sum, g) =>
											sum +
											g.transcripts.filter(
												(t) =>
													(
														t.metadata as {
															origin?: string;
														} | null
													)?.origin ===
													"personal-import",
											).length,
										0,
									);
								const provenanceLabel =
									importedTranscripts === 0
										? "Synced from Microsoft Teams"
										: importedTranscripts ===
												totalTranscripts
											? "Added from a personal calendar"
											: `Synced from Microsoft Teams · ${importedTranscripts} added from a personal calendar`;
								const isMeetingsExpanded =
									expandedGroups.has("meetings-top");
								return (
									<div className="overflow-hidden rounded-xl border bg-card/50 backdrop-blur-sm">
										<button
											type="button"
											onClick={() =>
												toggleGroup("meetings-top")
											}
											className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-muted/40"
										>
											<div
												className={cn(
													"shrink-0 rounded-xl bg-gradient-to-br p-2.5",
													contextTypeConfig
														.MEETING_TRANSCRIPT
														.gradient,
												)}
											>
												<MicIcon className="size-5 text-white" />
											</div>
											<div className="min-w-0 flex-1">
												<div className="flex items-center gap-2">
													<h3 className="truncate font-semibold text-sm">
														Meeting Transcripts
													</h3>
													<Badge
														variant="outline"
														className="shrink-0 border-foreground/20 text-xs"
													>
														{
															transcriptGroups.length
														}{" "}
														meeting
														{transcriptGroups.length !==
														1
															? "s"
															: ""}{" "}
														· {totalTranscripts}{" "}
														transcript
														{totalTranscripts !== 1
															? "s"
															: ""}
													</Badge>
												</div>
												<p className="mt-1 text-foreground/50 text-xs">
													{provenanceLabel}
												</p>
											</div>
											<ChevronDownIcon
												className={cn(
													"size-4 shrink-0 text-muted-foreground transition-transform",
													isMeetingsExpanded &&
														"rotate-180",
												)}
											/>
										</button>

										{isMeetingsExpanded && (
											<div className="max-h-[32rem] overflow-y-auto border-t">
												{transcriptGroups.map(
													(group) => {
														const isSubExpanded =
															expandedGroups.has(
																group.key,
															);
														const latestDate = (
															group.transcripts[0]
																?.metadata as {
																meetingDate?: string;
															}
														)?.meetingDate;

														return (
															<div
																key={group.key}
																className="border-t first:border-t-0"
															>
																<button
																	type="button"
																	onClick={() =>
																		toggleGroup(
																			group.key,
																		)
																	}
																	className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30"
																>
																	<div className="min-w-0 flex-1">
																		<p className="text-sm font-medium truncate">
																			{
																				group.subject
																			}
																		</p>
																		<div className="mt-0.5 flex items-center gap-2 text-foreground/40 text-xs">
																			<span>
																				{
																					group
																						.transcripts
																						.length
																				}{" "}
																				transcript
																				{group
																					.transcripts
																					.length !==
																				1
																					? "s"
																					: ""}
																			</span>
																			{latestDate && (
																				<span>
																					·{" "}
																					{new Date(
																						latestDate,
																					).toLocaleDateString(
																						undefined,
																						{
																							month: "short",
																							day: "numeric",
																							year: "numeric",
																						},
																					)}
																				</span>
																			)}
																		</div>
																	</div>
																	<ChevronDownIcon
																		className={cn(
																			"size-3.5 shrink-0 text-muted-foreground transition-transform",
																			isSubExpanded &&
																				"rotate-180",
																		)}
																	/>
																</button>

																{isSubExpanded && (
																	<div className="border-t bg-muted/10">
																		{group.transcripts.map(
																			(
																				context,
																			) => {
																				const meta =
																					(context.metadata ??
																						{}) as {
																						meetingDate?: string;
																						speakerNames?: string[];
																						wasSummarized?: boolean;
																					};
																				const extractionStatus =
																					resolveExtractionStatus(
																						context as {
																							extractionStatus?: string;
																							extractionError?:
																								| string
																								| null;
																							content?:
																								| string
																								| null;
																						},
																					);
																				const ExtractionIcon =
																					extractionStatus.icon;
																				const meetingDate =
																					meta.meetingDate
																						? new Date(
																								meta.meetingDate,
																							).toLocaleDateString(
																								undefined,
																								{
																									weekday:
																										"short",
																									month: "short",
																									day: "numeric",
																									year: "numeric",
																								},
																							)
																						: "Unknown date";

																				return (
																					<div
																						key={
																							context.id
																						}
																						className="group/item flex items-center gap-3 border-t first:border-t-0 px-6 py-2.5 transition-colors hover:bg-muted/30"
																					>
																						<div className="min-w-0 flex-1">
																							<p className="text-xs font-medium">
																								{
																									meetingDate
																								}
																							</p>
																							<ContextSourceMetaLine
																								sourceType={
																									context.sourceType
																								}
																								aiInstructions={
																									context.aiInstructions
																								}
																							/>
																							<div className="mt-0.5 flex flex-wrap items-center gap-2 text-foreground/40 text-xs">
																								<span
																									className={cn(
																										"flex items-center gap-1",
																										extractionStatus.color,
																									)}
																								>
																									<ExtractionIcon
																										className={cn(
																											"size-3",
																											(
																												context as {
																													extractionStatus?: string;
																												}
																											)
																												.extractionStatus ===
																												"EXTRACTING" &&
																												"animate-spin",
																										)}
																									/>
																									{
																										extractionStatus.label
																									}
																								</span>
																								{context.embeddedAt && (
																									<span className="flex items-center gap-1 text-success">
																										<CheckCircleIcon className="size-3" />
																										Embedded
																									</span>
																								)}
																								{meta.speakerNames &&
																									meta
																										.speakerNames
																										.length >
																										0 && (
																										<span>
																											{
																												meta
																													.speakerNames
																													.length
																											}{" "}
																											participant
																											{meta
																												.speakerNames
																												.length !==
																											1
																												? "s"
																												: ""}
																										</span>
																									)}
																								{meta.wasSummarized && (
																									<span className="text-primary">
																										Summarized
																									</span>
																								)}
																							</div>
																						</div>
																						<div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/item:opacity-100">
																							<DropdownMenu>
																								<Tooltip>
																									<TooltipTrigger
																										asChild
																									>
																										<DropdownMenuTrigger
																											asChild
																										>
																											<Button
																												variant="ghost"
																												size="icon"
																												aria-label="More options"
																												className="size-7 bg-card/50 backdrop-blur-sm"
																												onClick={(
																													e,
																												) =>
																													e.stopPropagation()
																												}
																											>
																												<MoreVerticalIcon className="size-3.5" />
																											</Button>
																										</DropdownMenuTrigger>
																									</TooltipTrigger>
																									<TooltipContent>
																										{t(
																											"contextActions",
																										)}
																									</TooltipContent>
																								</Tooltip>
																								<DropdownMenuContent align="end">
																									<DropdownMenuItem
																										asChild
																									>
																										<Link
																											href={`${projectBasePath}/contexts/${context.id}`}
																											onClick={(
																												e,
																											) =>
																												e.stopPropagation()
																											}
																											data-testid={`transcript-view-${context.id}`}
																										>
																											<EyeIcon className="mr-2 size-4" />
																											View
																										</Link>
																									</DropdownMenuItem>
																									{renderDownloadMenuItem(
																										context as unknown as RowContext,
																									)}
																									<DestructiveTooltip
																										copy={
																											t.raw(
																												"deleteTranscriptContext",
																											) as {
																												label: string;
																												warning: string;
																											}
																										}
																									>
																										<DropdownMenuItem
																											className="text-destructive focus:text-destructive"
																											onClick={(
																												e,
																											) => {
																												e.stopPropagation();
																												deleteMutation.mutate(
																													context.id,
																												);
																											}}
																											disabled={
																												deleteMutation.isPending
																											}
																										>
																											<TrashIcon className="mr-2 size-4" />
																											{deleteMutation.isPending
																												? "Deleting..."
																												: "Delete"}
																										</DropdownMenuItem>
																									</DestructiveTooltip>
																								</DropdownMenuContent>
																							</DropdownMenu>
																						</div>
																					</div>
																				);
																			},
																		)}
																	</div>
																)}
															</div>
														);
													},
												)}
											</div>
										)}
									</div>
								);
							})()}

						{/* Meeting Transcripts empty state (FR-5 / D6 / AC4)
							    — replaces ONLY the meetings group when no
							    transcripts exist; deep-links to the project Teams
							    meeting-sync settings. */}
						{transcriptGroups.length === 0 && (
							<div
								className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-6"
								data-testid="meeting-transcripts-empty"
							>
								<div className="flex items-center gap-3">
									<div className="shrink-0 rounded-md border border-border bg-muted p-2 text-muted-foreground">
										<MicIcon
											className="size-5"
											aria-hidden="true"
										/>
									</div>
									<h3 className="font-semibold text-sm">
										Meeting Transcripts
									</h3>
								</div>
								<p className="text-muted-foreground text-sm">
									No meeting transcripts yet. Link a Microsoft
									Teams meeting to this project to start
									syncing transcripts.
								</p>
								<Button
									asChild
									variant="default"
									className="mt-1"
								>
									<Link
										href={`${projectBasePath}?tab=settings`}
										data-testid="meeting-transcripts-empty-cta"
									>
										Link a Teams meeting
									</Link>
								</Button>
							</div>
						)}

						{/* Teams chats group */}
						{teamsGroup && (
							<div className="overflow-hidden rounded-xl border bg-card/50 backdrop-blur-sm">
								<button
									type="button"
									onClick={() => toggleGroup("teams-chats")}
									className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-muted/40"
								>
									<div className="shrink-0 rounded-xl bg-gradient-to-br from-[#464EB8] to-[#6264A7] p-2.5">
										<MicrosoftTeamsIcon className="size-5 text-white" />
									</div>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<h3 className="truncate font-semibold text-sm">
												Teams Chats
											</h3>
											<Badge
												variant="outline"
												className="shrink-0 border-foreground/20 text-xs"
											>
												{teamsGroup.length} chat
												{teamsGroup.length !== 1
													? "s"
													: ""}
											</Badge>
										</div>
										<p className="mt-1 text-foreground/50 text-xs">
											Synced from Microsoft Teams
										</p>
									</div>
									<ChevronDownIcon
										className={cn(
											"size-4 shrink-0 text-muted-foreground transition-transform",
											expandedGroups.has("teams-chats") &&
												"rotate-180",
										)}
									/>
								</button>

								{expandedGroups.has("teams-chats") && (
									<div className="max-h-96 overflow-y-auto border-t">
										{teamsGroup.map((context) => {
											const meta = (context.metadata ??
												{}) as {
												chatTopic?: string;
												title?: string;
												chatType?: string;
												channelName?: string;
												teamName?: string;
												memberCount?: number;
											};
											const chatTitle =
												meta.chatTopic ||
												meta.title ||
												(meta.chatType === "channel" &&
												meta.channelName
													? `#${meta.channelName}`
													: "Teams Chat");

											return (
												<div
													key={context.id}
													className="group/item flex items-center gap-3 border-t first:border-t-0 px-4 py-3 transition-colors hover:bg-muted/30"
												>
													<div className="min-w-0 flex-1">
														<p className="text-sm font-medium truncate">
															{chatTitle}
														</p>
														<ContextSourceMetaLine
															sourceType={
																context.sourceType
															}
															aiInstructions={
																context.aiInstructions
															}
														/>
														<div className="mt-1 flex flex-wrap items-center gap-3 text-foreground/40 text-xs">
															<span>
																{formatDistanceToNow(
																	new Date(
																		context.createdAt,
																	),
																	{
																		addSuffix: true,
																	},
																)}
															</span>
															{meta.teamName && (
																<span>
																	{
																		meta.teamName
																	}
																</span>
															)}
															{context.embeddedAt && (
																<span className="flex items-center gap-1 text-success">
																	<CheckCircleIcon className="size-3" />
																	Embedded
																</span>
															)}
														</div>
													</div>
													<div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/item:opacity-100">
														<DropdownMenu>
															<Tooltip>
																<TooltipTrigger
																	asChild
																>
																	<DropdownMenuTrigger
																		asChild
																	>
																		<Button
																			variant="ghost"
																			size="icon"
																			aria-label="More options"
																			className="size-7 bg-card/50 backdrop-blur-sm"
																			onClick={(
																				e,
																			) =>
																				e.stopPropagation()
																			}
																		>
																			<MoreVerticalIcon className="size-3.5" />
																		</Button>
																	</DropdownMenuTrigger>
																</TooltipTrigger>
																<TooltipContent>
																	{t(
																		"contextActions",
																	)}
																</TooltipContent>
															</Tooltip>
															<DropdownMenuContent align="end">
																{renderDownloadMenuItem(
																	context as unknown as RowContext,
																)}
																<DestructiveTooltip
																	copy={
																		t.raw(
																			"deleteTeamsContext",
																		) as {
																			label: string;
																			warning: string;
																		}
																	}
																>
																	<DropdownMenuItem
																		className="text-destructive focus:text-destructive"
																		onClick={(
																			e,
																		) => {
																			e.stopPropagation();
																			deleteMutation.mutate(
																				context.id,
																			);
																		}}
																		disabled={
																			deleteMutation.isPending
																		}
																	>
																		<TrashIcon className="mr-2 size-4" />
																		{deleteMutation.isPending
																			? "Deleting..."
																			: "Delete"}
																	</DropdownMenuItem>
																</DestructiveTooltip>
															</DropdownMenuContent>
														</DropdownMenu>
													</div>
												</div>
											);
										})}
									</div>
								)}
							</div>
						)}

						{/* Notion documents group */}
						{notionGroup && (
							<div className="overflow-hidden rounded-xl border bg-card/50 backdrop-blur-sm">
								<button
									type="button"
									onClick={() =>
										toggleGroup("notion-documents")
									}
									className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-muted/40"
								>
									<div className="shrink-0 rounded-xl bg-gradient-to-br from-stone-500 to-stone-700 p-2.5">
										<NotionIcon className="size-5 text-white" />
									</div>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<h3 className="truncate font-semibold text-sm">
												Notion Documents
											</h3>
											<Badge
												variant="outline"
												className="shrink-0 border-foreground/20 text-xs"
											>
												{notionGroup.length} page
												{notionGroup.length !== 1
													? "s"
													: ""}
											</Badge>
										</div>
										<p className="mt-1 text-foreground/50 text-xs">
											Imported from Notion workspace
										</p>
									</div>
									<ChevronDownIcon
										className={cn(
											"size-4 shrink-0 text-muted-foreground transition-transform",
											expandedGroups.has(
												"notion-documents",
											) && "rotate-180",
										)}
									/>
								</button>

								{expandedGroups.has("notion-documents") && (
									<div className="max-h-96 overflow-y-auto border-t">
										{notionGroup.map((context) => {
											const meta = (context.metadata ??
												{}) as {
												sourceTitle?: string;
												sourceUrl?: string;
											};
											const contextTitle =
												meta.sourceTitle ||
												context.sourceTitle ||
												"Untitled";

											return (
												<div
													key={context.id}
													className="group/item flex items-center gap-3 border-t first:border-t-0 px-4 py-3 transition-colors hover:bg-muted/30"
												>
													<div className="min-w-0 flex-1">
														<p className="text-sm font-medium truncate">
															{contextTitle}
														</p>
														<ContextSourceMetaLine
															sourceType={
																context.sourceType
															}
															aiInstructions={
																context.aiInstructions
															}
														/>
														<div className="mt-1 flex flex-wrap items-center gap-3 text-foreground/40 text-xs">
															<span>
																{formatDistanceToNow(
																	new Date(
																		context.createdAt,
																	),
																	{
																		addSuffix: true,
																	},
																)}
															</span>
															{context.embeddedAt && (
																<span className="flex items-center gap-1 text-success">
																	<CheckCircleIcon className="size-3" />
																	Embedded
																</span>
															)}
															{meta.sourceUrl && (
																<a
																	href={
																		meta.sourceUrl
																	}
																	target="_blank"
																	rel="noopener noreferrer"
																	className="flex items-center gap-1 text-primary hover:underline"
																	onClick={(
																		e,
																	) =>
																		e.stopPropagation()
																	}
																>
																	<ExternalLinkIcon className="size-3" />
																	Open in
																	Notion
																</a>
															)}
														</div>
													</div>
													<div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/item:opacity-100">
														<DropdownMenu>
															<Tooltip>
																<TooltipTrigger
																	asChild
																>
																	<DropdownMenuTrigger
																		asChild
																	>
																		<Button
																			variant="ghost"
																			size="icon"
																			aria-label="More options"
																			className="size-7 bg-card/50 backdrop-blur-sm"
																			onClick={(
																				e,
																			) =>
																				e.stopPropagation()
																			}
																		>
																			<MoreVerticalIcon className="size-3.5" />
																		</Button>
																	</DropdownMenuTrigger>
																</TooltipTrigger>
																<TooltipContent>
																	{t(
																		"contextActions",
																	)}
																</TooltipContent>
															</Tooltip>
															<DropdownMenuContent align="end">
																{renderDownloadMenuItem(
																	context as unknown as RowContext,
																)}
																<DestructiveTooltip
																	copy={
																		t.raw(
																			"deleteNotionContext",
																		) as {
																			label: string;
																			warning: string;
																		}
																	}
																>
																	<DropdownMenuItem
																		className="text-destructive focus:text-destructive"
																		onClick={(
																			e,
																		) => {
																			e.stopPropagation();
																			deleteMutation.mutate(
																				context.id,
																			);
																		}}
																		disabled={
																			deleteMutation.isPending
																		}
																	>
																		<TrashIcon className="mr-2 size-4" />
																		{deleteMutation.isPending
																			? "Deleting..."
																			: "Delete"}
																	</DropdownMenuItem>
																</DestructiveTooltip>
															</DropdownMenuContent>
														</DropdownMenu>
													</div>
												</div>
											);
										})}
									</div>
								)}
							</div>
						)}
					</div>

					{/* Other context items */}
					{/* `grid-cols-[minmax(0,1fr)]` caps the single-column mobile
					    layout so a card with a long unbroken title (e.g. a raw
					    URL) can't grow the column past the container; `sm:grid-cols-2`
					    already uses `minmax(0,1fr)` columns above the breakpoint. */}
					<div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
						{otherContexts.map((context, index) => {
							// Editorial LINK card branch.
							if (context.type === "LINK") {
								return (
									<UrlContextCard
										key={context.id}
										context={
											context as unknown as UrlContextRowFields
										}
										projectId={projectId}
										onDelete={(id) =>
											deleteMutation.mutate(id)
										}
										deletePending={deleteMutation.isPending}
										deleteCopy={
											t.raw("deleteContext") as {
												label: string;
												warning: string;
											}
										}
										onDownload={() =>
											handleDownloadRow(
												context as unknown as RowContext,
												"md",
											)
										}
									/>
								);
							}

							const baseConfig =
								contextTypeConfig[
									context.type as keyof typeof contextTypeConfig
								] || contextTypeConfig.FILE;
							const extractionStatus = resolveExtractionStatus(
								context as {
									extractionStatus?: string;
									extractionError?: string | null;
									content?: string | null;
								},
							);
							const ExtractionIcon = extractionStatus.icon;

							// Get metadata from context
							const metadata =
								(context.metadata as {
									title?: string;
									description?: string;
									sourceUrl?: string;
									chatTopic?: string;
									chatType?: string;
									teamName?: string;
									channelName?: string;
									memberCount?: number;
									provider?: string;
									documentTag?: string;
									sourceTitle?: string;
									source?: string;
								}) || {};
							const isIntegration =
								context.type === "INTEGRATION";

							// Not every INTEGRATION context means the same thing.
							// Google Docs run the full extraction pipeline and
							// carry a real `extractionStatus` (including FAILED);
							// backlog and channel integrations are live links
							// whose ingest is owned elsewhere, so their status
							// column stays PENDING forever and reporting it
							// would mislead in the other direction.
							//
							// This replaces a hardcoded violet "Live" chip shown
							// for every integration: it hid a failed Google Doc
							// behind a word implying all was well, and collided
							// with the URL sources' genuine "Live" refresh mode.
							const hasExtractionLifecycle =
								!isIntegration ||
								metadata.source === "google-docs";

							// Use provider-specific config for integrations, fall back to base
							const providerOverride =
								isIntegration && metadata.provider
									? integrationProviderConfig[
											metadata.provider
										]
									: undefined;
							const Icon =
								providerOverride?.icon ?? baseConfig.icon;
							const cardGradient =
								providerOverride?.gradient ??
								baseConfig.gradient;
							const cardLightBg =
								providerOverride?.lightBg ?? baseConfig.lightBg;
							const badgeLabel =
								providerOverride?.badgeLabel ??
								(isIntegration
									? metadata.provider || "Integration"
									: baseConfig.label);

							const title =
								metadata.chatTopic ||
								metadata.title ||
								metadata.sourceTitle ||
								context.sourceTitle ||
								(isIntegration
									? (providerOverride?.defaultTitle ??
										"Integration")
									: context.type);

							// Derive a description for integration contexts from available metadata
							let description = metadata.description;
							if (!description && isIntegration) {
								if (
									metadata.provider === "SLACK" &&
									metadata.channelName
								) {
									description = `#${metadata.channelName}`;
								} else if (
									metadata.provider === "MICROSOFT_TEAMS"
								) {
									if (
										metadata.chatType === "channel" &&
										metadata.teamName &&
										metadata.channelName
									) {
										description = `${metadata.teamName} · #${metadata.channelName}`;
									} else if (
										metadata.chatType === "channel" &&
										metadata.teamName
									) {
										description = `${metadata.teamName} channel`;
									} else if (metadata.memberCount != null) {
										description = `Group chat · ${metadata.memberCount} members`;
									} else {
										description =
											"Microsoft Teams conversation";
									}
								}
							}
							const sourceUrl =
								metadata.sourceUrl ||
								(context as { sourceUrl?: string }).sourceUrl;

							return (
								<div
									key={context.id}
									className={cn(
										"group relative overflow-hidden rounded-xl border bg-card/50 backdrop-blur-sm transition-all",
										"hover:border-primary/30 hover:shadow-lg",
										`animate-stagger-${Math.min(index + 1, 5)}`,
									)}
								>
									{/* Gradient background on hover */}
									<div
										className={cn(
											"absolute inset-0 bg-gradient-to-br opacity-0 transition-opacity group-hover:opacity-100",
											cardLightBg,
										)}
									/>

									<div className="relative z-10 p-4">
										<div className="flex items-start justify-between gap-3">
											<div className="flex items-start gap-3 flex-1 min-w-0">
												{/* Icon with gradient */}
												<div
													className={cn(
														"shrink-0 rounded-xl bg-gradient-to-br p-2.5 transition-transform group-hover:scale-110",
														cardGradient,
													)}
												>
													<Icon className="size-5 text-white" />
												</div>

												{/* Content */}
												<div className="min-w-0 flex-1">
													<div className="flex items-center gap-2">
														<h3 className="truncate font-semibold text-sm">
															{title}
														</h3>
														<Badge
															variant="outline"
															className="shrink-0 border-foreground/20 text-xs"
														>
															{badgeLabel}
														</Badge>
													</div>

													<ContextSourceMetaLine
														sourceType={
															context.sourceType
														}
														aiInstructions={
															context.aiInstructions
														}
													/>
													{description && (
														<p className="mt-1 line-clamp-2 text-foreground/50 text-sm">
															{description}
														</p>
													)}

													{/* Meta info */}
													<div className="mt-2 flex flex-wrap items-center gap-3 text-foreground/40 text-xs">
														{/* Live connections report "Connected"; anything
														    with a real extraction pipeline reports its
														    actual status. */}
														{!hasExtractionLifecycle ? (
															<span className="flex items-center gap-1 text-success">
																<CheckCircleIcon className="size-3" />
																Connected
															</span>
														) : (
															<span
																className={cn(
																	"flex items-center gap-1",
																	extractionStatus.color,
																)}
															>
																<ExtractionIcon
																	className={cn(
																		"size-3",
																		(
																			context as {
																				extractionStatus?: string;
																			}
																		)
																			.extractionStatus ===
																			"EXTRACTING" &&
																			"animate-spin",
																	)}
																/>
																{
																	extractionStatus.label
																}
															</span>
														)}

														{/* Importing as document badge (tagged but document not yet created) */}
														{metadata.documentTag && (
															<span className="flex animate-pulse items-center gap-1 text-highlight">
																<SparklesIcon className="size-3" />
																Importing as{" "}
																{
																	metadata.documentTag
																}
																...
															</span>
														)}

														{/* Embedded status. Was hidden for every integration,
														    which suppressed it for Google Docs — the one
														    integration that really does get embedded. */}
														{context.embeddedAt && (
															<span className="flex items-center gap-1 text-success">
																<CheckCircleIcon className="size-3" />
																Embedded
															</span>
														)}

														{/* Created time */}
														{context.createdAt && (
															<span>
																{formatDistanceToNow(
																	typeof context.createdAt ===
																		"string"
																		? new Date(
																				context.createdAt,
																			)
																		: context.createdAt,
																)}{" "}
																ago
															</span>
														)}
													</div>

													{/* Source URL */}
													{sourceUrl && (
														<a
															href={sourceUrl}
															target="_blank"
															rel="noopener noreferrer"
															className="mt-2 flex items-center gap-1 text-primary text-xs hover:underline"
															onClick={(e) =>
																e.stopPropagation()
															}
														>
															<ExternalLinkIcon className="size-3" />
															<span className="truncate max-w-[200px]">
																{sourceUrl}
															</span>
														</a>
													)}
												</div>
											</div>

											{/* Actions - visible on hover */}
											<div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
												<DropdownMenu>
													<Tooltip>
														<TooltipTrigger asChild>
															<DropdownMenuTrigger
																asChild
															>
																<Button
																	variant="ghost"
																	size="icon"
																	aria-label="More options"
																	className="size-8 bg-card/50 backdrop-blur-sm"
																	onClick={(
																		e,
																	) =>
																		e.stopPropagation()
																	}
																>
																	<MoreVerticalIcon className="size-4" />
																</Button>
															</DropdownMenuTrigger>
														</TooltipTrigger>
														<TooltipContent>
															{t(
																"contextActions",
															)}
														</TooltipContent>
													</Tooltip>
													<DropdownMenuContent align="end">
														{renderDownloadMenuItem(
															context as unknown as RowContext,
														)}
														<DestructiveTooltip
															copy={
																t.raw(
																	"deleteContext",
																) as {
																	label: string;
																	warning: string;
																}
															}
														>
															<DropdownMenuItem
																className="text-destructive focus:text-destructive"
																onClick={(
																	e,
																) => {
																	e.stopPropagation();
																	deleteMutation.mutate(
																		context.id,
																	);
																}}
																disabled={
																	deleteMutation.isPending
																}
															>
																<TrashIcon className="mr-2 size-4" />
																{deleteMutation.isPending
																	? "Deleting..."
																	: "Delete"}
															</DropdownMenuItem>
														</DestructiveTooltip>
													</DropdownMenuContent>
												</DropdownMenu>
											</div>
										</div>
									</div>
								</div>
							);
						})}
					</div>
				</div>
			)}

			{/* Context uploader dialog */}
			<ContextUploaderDialog
				projectId={projectId}
				open={uploaderOpen}
				onOpenChange={setUploaderOpen}
			/>

			{/* Source details dialog (#1888) — ONE instance outside every
			    Radix menu tree; row menus flip `detailsTarget` to open it. */}
			<ContextSourceDetailsDialog
				open={detailsTarget !== null}
				onOpenChange={(open) => {
					if (!open) {
						setDetailsTarget(null);
					}
				}}
				projectId={projectId}
				contextId={detailsTarget?.contextId ?? ""}
				sourceName={detailsTarget?.sourceName}
				initialSourceType={detailsTarget?.initialSourceType ?? null}
				initialAiInstructions={
					detailsTarget?.initialAiInstructions ?? null
				}
			/>
		</div>
	);
}
