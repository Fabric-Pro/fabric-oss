"use client";

import { PROPOSAL_SOURCE_LABELS } from "../../lib/stories/proposal-source-labels";

/**
 * PendingBacklogProposalsInbox
 *
 * Side drawer shown from the Roadmap for reviewing backlog proposals that
 * were auto-generated from monitored Teams channels, Teams chats, Slack
 * channels, and auto-analyzed monitored-meeting transcripts. The list groups
 * PENDING rows first, then FAILED rows. Clicking
 * a row expands into the existing `<BacklogChangeProposal>` UI for diff
 * review + approve/reject. Approve/reject mutations dispatch to the
 * monitor-specific endpoint matching the proposal's `source` so each
 * source's orchestrator (Slack url_private download vs Teams hostedContents
 * download) runs against the right ref set.
 */

import {
	countDistinctDecisions,
	extractDecisionPrecheck,
} from "@repo/agent-types";
import type {
	AttachmentWarning,
	PendingAttachmentRef,
} from "@repo/integrations";
import { useBasePath } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { stripMarkdown } from "@ui/lib/strip-markdown";
import { formatDistanceToNow } from "date-fns";
import {
	AlertTriangleIcon,
	ArchiveIcon,
	ArrowLeftIcon,
	CalendarIcon,
	CheckCircle2Icon,
	ChevronRightIcon,
	ExternalLinkIcon,
	FileTextIcon,
	HashIcon,
	InboxIcon,
	Loader2Icon,
	RefreshCwIcon,
	SparklesIcon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { SlackIcon } from "../../../workflows/lib/plugins/slack/icon";
import {
	buildStoryCleanSpecRoute,
	buildStoryDetailsRoute,
} from "../../lib/stories/routes";
import { BacklogChangeProposal } from "./BacklogChangeProposal";
import { failureClassToCopy } from "./lib/failure-class-copy";
import {
	ProposalInboxSearch,
	ProposalSearchNoMatches,
} from "./ProposalInboxSearch";
import { MergedIntoNote } from "./ProposalItemNotes";
import {
	type ApproveOutcome,
	approveClosesDetail,
	approveHeldBackToast,
	approveOutcomeToast,
	approveRefusalTitle,
	heldBackToast,
	proposalConflictMessage,
} from "./proposal-approve-outcome";
import {
	endpointForSource,
	invalidateProposalInboxQueries,
	type ProposalApprovalRequest,
	type ProposalPmConfig,
	ROADMAP_RECOMMENDATION_SOURCE,
	requestProposalApproval,
} from "./proposal-inbox-client";
import {
	filterProposalsByQuery,
	type ProposalInboxItem,
} from "./proposal-inbox-search";
import {
	changeCountLabel,
	deriveProposalItemState,
	type PendingItemAction,
	type ProposalApplication,
	type ProposalDuplicateResolution,
	type ResolvedProposalItem,
	type RestoredProposalItem,
} from "./proposal-item-state";
import { isApplyInFlight } from "./proposal-status";
import { startProposalTicketReview } from "./proposal-ticket-review";
import {
	isRecurringErrorSource,
	RecurringErrorSourceBadge,
	RecurringErrorSourcePanel,
} from "./RecurringErrorSource";
import { useBoardStoryIds } from "./useBoardStoryIds";
import { useProposalDuplicateFlags } from "./useProposalDuplicateFlags";

type Props = {
	projectId: string;
	organizationId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * Initial focus when the sheet mounts. `"failed"` auto-scrolls the Failed
	 * group into view. `"backlog"` turns the drawer into a dedicated Rejected
	 * list — only rejected proposals, its own "Rejected proposals" header, no
	 * Pending / Failed groups — opened from the Roadmap archive icon. Defaults
	 * to `"all"` (the active review queue).
	 */
	defaultFilter?: "all" | "failed" | "backlog";
	/**
	 * Proposal to open directly, from a `?proposal=<id>` deep link. Selected on
	 * open rather than filtered for, because the linked proposal has usually
	 * already been APPLIED and so is absent from the review queue — the detail
	 * view fetches it by id regardless.
	 */
	initialProposalId?: string | null;
	/**
	 * Whether the project has a PM tool (Fizzy / ADO / GitLab / Jira)
	 * configured. When true, the proposal-review UI shows the "Also sync to
	 * {PM Tool}" checkbox so the reviewer can opt the approved proposal into
	 * the PM push. Sourced from the Roadmap's `pmCapabilities` query.
	 */
	hasPMTool?: boolean;
	/** Display name of the configured PM tool, for the checkbox label. */
	pmToolName?: string;
	/**
	 * PM-tool target forwarded to the approve procedure so that, when the
	 * reviewer enables sync, UPDATE changes reach the PM tool via the
	 * backlog-apply workflow. (CREATE changes resolve the config server-side
	 * and don't need this.) Mirrors what `BacklogChat` (AI Update) passes.
	 */
	pmConfig?: ProposalPmConfig;
	/**
	 * `project.roadmap.aiRecommendedLifecycleEnabled` (Fizzy #2211). When on,
	 * accepting a Roadmap recommendation batch also says how to remove the
	 * batch later.
	 */
	aiRecommendedLifecycleEnabled?: boolean;
	/**
	 * Client-side navigation within the app. With it, an update can be
	 * reviewed line by line on its ticket ("Review line by line").
	 */
	navigate?: (href: string) => void;
};

/**
 * How often, and for how long, an accepted recommendation batch is watched
 * until its apply finishes (about three minutes, then it gives up and
 * refreshes anyway).
 */
const APPLY_WATCH_INTERVAL_MS = 2_000;
const APPLY_WATCH_MAX_POLLS = 90;

/** The post-accept notice carries about 60 words; the global 5s is too short. */
const ACCEPTED_NOTICE_DURATION_MS = 12_000;

const RECOMMENDATION_ENTRY_POINT_LABELS: Record<string, string> = {
	EMPTY_ROADMAP: "Start Building Your Roadmap",
	MATURE_ROADMAP: "Recommend Features from Context",
	DO_BOTH_AFTER_PULL: "Do both, after the pull",
};

type ProposalStatus =
	| "PENDING"
	| "APPROVED"
	| "APPLYING"
	| "APPLIED"
	| "REJECTED"
	| "FAILED"
	| "SUPERSEDED"
	| "BACKLOG";

function filenameFromMetadata(
	metadata: Record<string, unknown> | null,
): string | null {
	if (!metadata) {
		return null;
	}
	const name =
		(metadata.originalFilename as string | undefined) ??
		(metadata.documentTitle as string | undefined);
	return typeof name === "string" && name.length > 0 ? name : null;
}

type PendingProposalRow = {
	id: string;
	source: string;
	status: ProposalStatus;
	summary: string;
	changeCount: number;
	sourceMetadata: Record<string, unknown> | null;
	applyError: string | null;
	// Failure-classification columns added by the sync-failure-retry
	// migration. Legacy FAILED rows (channel-monitor flows pre-migration)
	// arrive with these as null; the renderer falls back to `applyError`
	// + the `default` copy via `failureClassToCopy(null)`.
	errorClass?: string | null;
	errorMessage?: string | null;
	failedAt?: string | Date | null;
	createdAt: string | Date;
	reviewedAt: string | Date | null;
	appliedAt: string | Date | null;
	/** Each unresolved item's title and identifier, for search (list only). */
	items?: ProposalInboxItem[];
	/** The server's resolved items, each with its reason. */
	resolvedItems: ResolvedProposalItem[];
	/** Items still waiting for a decision. */
	remainingCount: number;
};

type PendingProposalDetail = PendingProposalRow & {
	/** The indexes this proposal actually created, from the application table. */
	createdChangeIndexes: number[];
	/** Identifies the content reviewed; an approve sends it back. */
	proposalRevision?: string;
	/** Update items whose ticket changed after the proposal was made. */
	targetChangedSinceProposalIndexes?: number[];
	/** The ticket bodies now of the update items whose body has no `from`. */
	updateTargetBodies?: Array<{
		changeIndex: number;
		description: string;
		acceptanceCriteria: string;
	}>;
	/** Update items an approval would hold back: no such ticket here. */
	heldBackUpdateIndexes?: number[];
	/** What each applied item created or updated. */
	applications?: ProposalApplication[];
	/** The existing ticket each duplicate-resolved item matched. */
	duplicateResolutions?: ProposalDuplicateResolution[];
	/** Items moved to Rejected and then restored from there. */
	restoredItems?: RestoredProposalItem[];
	/** Teams deep link to a chat proposal's source message, while the chat is linked. */
	teamsChatSourceLink?: string | null;
	projectId: string;
	proposal: unknown;
	userId: string | null;
	organizationId: string | null;
};

type ProposalJson = {
	summary?: string;
	contextSummary?: string;
	changes?: Record<string, unknown>[];
	/** Explore intake (plan Slice 6). */
	visionSuggestions?: {
		purpose?: string | null;
		coreActions?: string[] | null;
		cycle?: string | null;
	} | null;
};

/**
 * Read `sourceMetadata.attachments` defensively from the JSON payload.
 * Legacy rows (pre chat-thread-image-attachments feature) carry no
 * `attachments` key, so callers must treat missing / non-array as `[]`
 * per FR-27. We don't validate the shape of each entry here — the child
 * only consumes `.length` for the chip, and the orchestrator
 * (`attachPendingMediaToStory`) re-validates each ref at apply time.
 */
function readAttachments(
	metadata: Record<string, unknown> | null,
): PendingAttachmentRef[] {
	if (!metadata) {
		return [];
	}
	const raw = metadata.attachments;
	return Array.isArray(raw) ? (raw as PendingAttachmentRef[]) : [];
}

/**
 * Same defensive read for `sourceMetadata.attachmentWarnings`. The
 * orchestrator only writes this on approve, so PENDING rows almost
 * always see `[]` here; the chip appears once a previous approval
 * attempt produced skips/failures and the row re-entered the inbox
 * as `FAILED`.
 */
function readAttachmentWarnings(
	metadata: Record<string, unknown> | null,
): AttachmentWarning[] {
	if (!metadata) {
		return [];
	}
	const raw = metadata.attachmentWarnings;
	return Array.isArray(raw) ? (raw as AttachmentWarning[]) : [];
}

/** Meeting subject from a MONITORED_MEETING proposal's sourceMetadata. */
function meetingSubjectFromMetadata(
	metadata: Record<string, unknown> | null,
): string | null {
	const v = metadata?.meetingSubject;
	return typeof v === "string" && v.length > 0 ? v : null;
}

/** Format a meeting date for the badge / source panel (omit when absent/invalid). */
function formatMeetingBadgeDate(value: unknown): string | null {
	if (typeof value !== "string" && !(value instanceof Date)) {
		return null;
	}
	const d = new Date(value as string | Date);
	if (Number.isNaN(d.getTime())) {
		return null;
	}
	return d.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

/**
 * The source text the analyze activity stored for in-app viewing: the meeting
 * transcript, or the formatted Teams/Slack thread the proposal was drafted from.
 */
function transcriptFromMetadata(
	metadata: Record<string, unknown> | null,
): string | null {
	const v = metadata?.transcript;
	return typeof v === "string" && v.trim().length > 0 ? v : null;
}

function SourceTranscript({ label, text }: { label: string; text: string }) {
	return (
		<details className="mt-2">
			<summary className="inline-flex min-h-6 cursor-pointer items-center gap-1.5 text-xs text-primary hover:underline">
				<FileTextIcon className="size-3" aria-hidden="true" />
				{label}
			</summary>
			<pre className="mt-2 max-h-64 overflow-auto overscroll-contain whitespace-pre-wrap rounded-md border border-foreground/10 bg-background p-2 text-xs text-foreground/80">
				{text}
			</pre>
		</details>
	);
}

/**
 * Bug 1429 / Codex P1+D — the monitored-channel + monitored-meeting sources are
 * feature/bug-only (epic is not a supported proposal type there), so the shared
 * `BacklogChangeProposal` should normalize epic→feature for display + approve.
 * `AI_UPDATE_SIDEBAR` (the general AI Update flow) keeps `epic` first-class, so
 * it must NOT pass `forbidEpics`. `MONITORED_MEETING` is auto-analyzed
 * capture-as-is (`allowEpics:false`/`allowUpdates:false`), so it normalizes like
 * Slack/Teams. This inbox lists ALL source types, so the prop is gated
 * per-proposal on this allow-list.
 */
function isChannelMonitorSource(source: string): boolean {
	return (
		source === "TEAMS_CHANNEL" ||
		source === "TEAMS_CHAT" ||
		source === "SLACK_CHANNEL" ||
		source === "MONITORED_MEETING"
	);
}

function statusPillClasses(status: ProposalStatus): string {
	switch (status) {
		case "FAILED":
			return "bg-destructive/10 text-destructive border-destructive/30";
		case "PENDING":
			return "bg-highlight/15 text-highlight border-highlight/30";
		case "APPROVED":
		case "APPLYING":
			return "bg-success/10 text-success border-success/30";
		default:
			return "bg-muted text-muted-foreground border-foreground/10";
	}
}

/** Whether a proposal in this status has left the review queue. */
function leftReviewQueue(status: ProposalStatus): boolean {
	switch (status) {
		case "PENDING":
		case "APPROVED":
		case "APPLYING":
		case "FAILED":
			return false;
		case "APPLIED":
		case "REJECTED":
		case "SUPERSEDED":
		case "BACKLOG":
			return true;
		default: {
			const unhandled: never = status;
			return unhandled;
		}
	}
}

function channelNameFromMetadata(
	metadata: Record<string, unknown> | null,
): string | null {
	if (!metadata) {
		return null;
	}
	const name =
		(metadata.channelDisplayName as string | undefined) ??
		(metadata.channelName as string | undefined);
	return typeof name === "string" && name.length > 0 ? name : null;
}

/**
 * Where a monitored conversation took place: the channel name for Teams and
 * Slack channels, the chat topic for a Teams group chat (the chat monitor
 * stores `chatTopic`, never a channel name).
 */
function conversationNameFromMetadata(
	source: string,
	metadata: Record<string, unknown> | null,
): string | null {
	if (source !== "TEAMS_CHAT") {
		return channelNameFromMetadata(metadata);
	}
	const topic = metadata?.chatTopic;
	return typeof topic === "string" && topic.length > 0 ? topic : null;
}

/**
 * Build a deep-link to the original message/thread for the proposal.
 *
 * - TEAMS_CHANNEL / TEAMS_CHAT: source metadata already holds a full
 *   `threadRootWebLink` for channel messages. A chat message has none, so a
 *   chat proposal links to its root message through `teamsChatSourceLink`
 *   (built server-side from the linked chat), then to the chat's `chatWebUrl`.
 * - SLACK_CHANNEL: metadata typically has `channelId` and Slack `ts`
 *   (and optionally `threadTs`). The Slack permalink format strips the
 *   `.` from `ts` and prefixes with `p`, e.g. `1715724000.123456` →
 *   `p1715724000123456`. Without a workspace slug in metadata we fall
 *   back to the workspace-agnostic `slack.com/app_redirect` path which
 *   Slack resolves client-side once the user is signed in. Known v1
 *   limitation; the link may not open inline in every client.
 */
function threadLinkFromMetadata(
	source: string,
	metadata: Record<string, unknown> | null,
	teamsChatSourceLink: string | null,
): string | null {
	if (!metadata) {
		return null;
	}
	if (source === "SLACK_CHANNEL") {
		const channelId =
			(metadata.channelId as string | undefined) ??
			(metadata.slackChannelId as string | undefined);
		const ts =
			(metadata.threadTs as string | undefined) ??
			(metadata.ts as string | undefined) ??
			(metadata.messageTs as string | undefined);
		if (!channelId) {
			return null;
		}
		// Prefer an explicit pre-built permalink when the activity captured one.
		const explicit =
			(metadata.permalink as string | undefined) ??
			(metadata.threadRootWebLink as string | undefined);
		if (typeof explicit === "string" && explicit.length > 0) {
			return explicit;
		}
		if (!ts) {
			return null;
		}
		const tsCompact = ts.replace(".", "");
		// Workspace-agnostic redirect — Slack resolves to the signed-in
		// workspace. If the project ever stores a workspace slug in
		// metadata we can build the canonical
		// `https://<slug>.slack.com/archives/<channelId>/p<ts>` URL here.
		return `https://slack.com/app_redirect?channel=${channelId}&message_ts=${tsCompact}`;
	}
	// Default: Teams (channel + chat) — pre-built links live in metadata.
	const link =
		(metadata.threadRootWebLink as string | undefined) ??
		teamsChatSourceLink ??
		(metadata.chatWebUrl as string | undefined) ??
		(metadata.channelWebUrl as string | undefined);
	return typeof link === "string" && link.length > 0 ? link : null;
}

type ProposalSource =
	| "TEAMS_CHANNEL"
	| "TEAMS_CHAT"
	| "SLACK_CHANNEL"
	| "AI_UPDATE_SIDEBAR"
	| "MONITORED_MEETING"
	| string;

/**
 * Render a compact source badge for the proposal row + detail headers.
 * Routes each `PendingBacklogProposalSource` value to its own icon and
 * label so Teams / Slack / AI Update sidebar all render through the same
 * helper.
 */
function ProposalSourceBadge({
	source,
	sourceMetadata,
}: {
	source: ProposalSource;
	sourceMetadata: Record<string, unknown> | null;
}) {
	const channelName = channelNameFromMetadata(sourceMetadata);

	if (isRecurringErrorSource(source)) {
		return (
			<RecurringErrorSourceBadge
				source={source}
				sourceMetadata={sourceMetadata}
			/>
		);
	}

	if (source === "AI_UPDATE_SIDEBAR") {
		// The AI Update flow has no channel — the badge is a compact
		// product-label so the user can tell sidebar-originated rows
		// apart from channel-monitor rows in the inbox at a glance.
		return (
			<span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
				<SparklesIcon className="size-3 text-muted-foreground" />
				{PROPOSAL_SOURCE_LABELS.AI_UPDATE_SIDEBAR}
			</span>
		);
	}

	if (source === ROADMAP_RECOMMENDATION_SOURCE) {
		return (
			<span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
				<SparklesIcon
					className="size-3 text-muted-foreground"
					aria-hidden="true"
				/>
				{PROPOSAL_SOURCE_LABELS.ROADMAP_RECOMMENDATION}
			</span>
		);
	}

	if (source === "MONITORED_MEETING") {
		// Auto-analyzed monitored-meeting transcript: no channel, so prefer the
		// meeting subject + date from sourceMetadata for a recognizable label,
		// falling back to a generic label when absent.
		const meetingSubject = meetingSubjectFromMetadata(sourceMetadata);
		const meetingDate = formatMeetingBadgeDate(sourceMetadata?.meetingDate);
		const label = meetingSubject
			? meetingDate
				? `From ${meetingSubject} · ${meetingDate}`
				: `From ${meetingSubject}`
			: meetingDate
				? `Monitored meeting · ${meetingDate}`
				: "From a monitored meeting";
		return (
			<span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
				<CalendarIcon
					className="size-3 text-muted-foreground"
					aria-hidden="true"
				/>
				{label}
			</span>
		);
	}

	if (source === "SLACK_CHANNEL") {
		return (
			<span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
				<SlackIcon className="size-3 text-muted-foreground" />
				{channelName ? `Posted in #${channelName}` : "Posted in Slack"}
			</span>
		);
	}

	if (source === "TEAMS_CHAT") {
		const chatTopic = conversationNameFromMetadata(source, sourceMetadata);
		return (
			<span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
				<HashIcon className="size-3" />
				{chatTopic ? `Posted in ${chatTopic}` : "Posted in Teams chat"}
			</span>
		);
	}

	// Default: TEAMS_CHANNEL or any future provider — render channel name
	// without provider chrome so the badge stays compact.
	if (channelName) {
		return (
			<span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
				<HashIcon className="size-3" />
				{channelName}
			</span>
		);
	}
	return null;
}

function providerLabel(source: ProposalSource): string {
	switch (source) {
		case "SLACK_CHANNEL":
			return "Slack";
		case "TEAMS_CHAT":
			return "Microsoft Teams";
		case "TEAMS_CHANNEL":
			return "Microsoft Teams";
		case "MONITORED_MEETING":
			return "a monitored meeting";
		case "LOG_MONITOR":
			return "the application logs";
		case "INCIDENT_CLUSTER":
			return "the related bug reports";
		default:
			return "the source channel";
	}
}

export function PendingBacklogProposalsInbox({
	projectId,
	organizationId,
	open,
	onOpenChange,
	defaultFilter = "all",
	initialProposalId = null,
	hasPMTool = false,
	pmToolName,
	pmConfig,
	aiRecommendedLifecycleEnabled = false,
	navigate,
}: Props) {
	const queryClient = useQueryClient();
	const basePath = useBasePath();
	const t = useTranslations("projects.decisionPrecheck");
	const [selectedProposalId, setSelectedProposalId] = useState<string | null>(
		null,
	);
	// List search. Kept across list <-> detail navigation, cleared on close.
	const [searchQuery, setSearchQuery] = useState("");
	// Existing tickets the last approve matched instead of creating a
	// duplicate. The detail payload records no ticket for such an item, so
	// the result link comes from the approve response.
	const [skippedTargets, setSkippedTargets] = useState<{
		proposalId: string;
		byIndex: Map<number, string>;
	} | null>(null);
	// Confirm-dismiss dialog state — holds the proposal currently being
	// dismissed (after Retry, dismiss is the second action surfaced on
	// each FAILED row). `null` = closed.
	const [pendingDismiss, setPendingDismiss] = useState<{
		proposalId: string;
		source: string;
	} | null>(null);
	// Auto-scroll target when the banner opens the inbox with
	// `defaultFilter="failed"`. We scroll on first paint AFTER the list
	// query resolves; the ref lives across renders so the effect's
	// `scrollIntoView` runs against the freshly-mounted section.
	const failedSectionRef = useRef<HTMLElement | null>(null);
	const autoScrolledRef = useRef(false);

	// Reset detail view when drawer closes
	useEffect(() => {
		if (!open) {
			setSelectedProposalId(null);
			setSearchQuery("");
			setPendingDismiss(null);
			autoScrolledRef.current = false;
		}
	}, [open]);

	// Honour a deep link on open. Keyed on the id too, so following a second
	// link while the drawer is already open still lands on the new proposal.
	useEffect(() => {
		if (open && initialProposalId) {
			setSelectedProposalId(initialProposalId);
		}
	}, [open, initialProposalId]);

	const listQueryKey = useMemo(
		() => [
			"teams-channel-monitor-pending-proposals",
			projectId,
			organizationId,
		],
		[projectId, organizationId],
	);
	// Rejected rows are fetched separately (stored as status ["BACKLOG"]) so the
	// active list stays lean; this backs the dedicated "Rejected proposals" list
	// and is keyed distinctly by the trailing "backlog" segment.
	const backlogQueryKey = useMemo(
		() => [
			"teams-channel-monitor-pending-proposals",
			projectId,
			organizationId,
			"backlog",
		],
		[projectId, organizationId],
	);

	const listQuery = useQuery({
		queryKey: listQueryKey,
		queryFn: async () => {
			// Use the server review-inbox default so the list matches the badge count.
			const result =
				await orpcClient.projects.teamsChannelMonitor.pendingProposals.list(
					{
						projectId,
						organizationId,
					},
				);
			return (result ?? []) as PendingProposalRow[];
		},
		enabled: open,
	});

	// Rejected proposals list (stored as status ["BACKLOG"]). Same
	// source-agnostic list endpoint; only fetched while the drawer is open.
	const backlogQuery = useQuery({
		queryKey: backlogQueryKey,
		queryFn: async () => {
			const result =
				await orpcClient.projects.teamsChannelMonitor.pendingProposals.list(
					{
						projectId,
						organizationId,
						status: ["BACKLOG"],
					},
				);
			return (result ?? []) as PendingProposalRow[];
		},
		enabled: open,
	});

	const detailQuery = useQuery({
		queryKey: [
			"teams-channel-monitor-pending-proposal",
			projectId,
			organizationId,
			selectedProposalId,
		],
		queryFn: async () => {
			if (!selectedProposalId) {
				return null;
			}
			const result =
				await orpcClient.projects.teamsChannelMonitor.pendingProposals.get(
					{
						projectId,
						organizationId,
						proposalId: selectedProposalId,
					},
				);
			return result as PendingProposalDetail | null;
		},
		enabled: open && !!selectedProposalId,
		// An open proposal whose apply is still running is watched until it
		// settles: back in review with items left, or out of the queue.
		refetchInterval: (query) =>
			isApplyInFlight(query.state.data?.status)
				? APPLY_WATCH_INTERVAL_MS
				: false,
	});

	// Possible duplicates for the open proposal only, once it is known to be
	// in review. A duplicate note can open another proposal; the search is
	// cleared so the list behind it does not hide that proposal.
	const duplicateReview = useProposalDuplicateFlags({
		projectId,
		organizationId,
		proposalId: selectedProposalId,
		enabled:
			open &&
			detailQuery.data?.id === selectedProposalId &&
			detailQuery.data?.status === "PENDING",
	});
	// The board's tickets, so an update's target is linked only while it
	// still exists.
	const boardStoryIds = useBoardStoryIds({
		projectId,
		organizationId,
		enabled: open && !!detailQuery.data,
	});
	const openProposalFromDuplicate = useCallback((proposalId: string) => {
		setSearchQuery("");
		setSelectedProposalId(proposalId);
	}, []);

	// The accepted recommendation batch whose apply is still running. Its
	// items (and the Roadmap gates that key off them) only exist once the
	// apply workflow finishes, so the refresh has to wait for the row to
	// leave APPLYING rather than fire at dispatch. Deliberately not gated on
	// `open`: the reviewer usually closes the drawer right after accepting.
	const [watchedApply, setWatchedApply] = useState<{
		proposalId: string;
		/** Items the batch had already created before this accept. */
		createdBefore: number;
	} | null>(null);
	const watchedApplyId = watchedApply?.proposalId ?? null;
	const applyWatchPollsRef = useRef(0);
	// The accept the notice already spoke for; the settle effect can re-run
	// before the cleared watch commits.
	const notifiedApplyRef = useRef<typeof watchedApply>(null);
	const tAcceptedNotice = useTranslations(
		"projects.stories.aiRecommended.acceptedNotice",
	);
	const applyWatchQueryKey = useMemo(
		() => [
			"teams-channel-monitor-pending-proposal-apply-watch",
			projectId,
			organizationId,
			watchedApplyId,
		],
		[projectId, organizationId, watchedApplyId],
	);
	const applyWatchQuery = useQuery({
		queryKey: applyWatchQueryKey,
		queryFn: async () => {
			applyWatchPollsRef.current += 1;
			const row = watchedApplyId
				? await orpcClient.projects.teamsChannelMonitor.pendingProposals.get(
						{
							projectId,
							organizationId,
							proposalId: watchedApplyId,
						},
					)
				: null;
			const watched = row as {
				status?: string;
				createdChangeIndexes?: number[];
			} | null;
			const status = watched?.status ?? null;
			// Only a row that left APPROVED/APPLYING really finished; running
			// out of polls just stops watching.
			const finished = !isApplyInFlight(status);
			return {
				done:
					finished ||
					applyWatchPollsRef.current >= APPLY_WATCH_MAX_POLLS,
				finished,
				createdTotal: watched?.createdChangeIndexes?.length ?? null,
			};
		},
		enabled: !!watchedApplyId,
		refetchInterval: (query) =>
			query.state.data?.done === false ? APPLY_WATCH_INTERVAL_MS : false,
	});

	const invalidateAll = useCallback(() => {
		// The lists (review and Rejected), the badge count, the open proposal
		// (a per-item action or a partial apply leaves it open, so its locked
		// items refresh in place) and the possible-duplicate flags.
		invalidateProposalInboxQueries(queryClient, projectId, organizationId);
		// Keep the dedicated `proposals.failedCount` endpoint fresh so
		// retry / dismiss outcomes propagate to any count consumer without
		// a page reload.
		queryClient.invalidateQueries({
			queryKey: [
				"projects.backlog.proposals.failedCount",
				projectId,
				organizationId,
			],
		});
		// Approving a proposal can create or update UserStory rows that the
		// Roadmap reads from `projects.stories.board`. Invalidate it so the
		// new/updated features appear without a manual page refresh.
		queryClient.invalidateQueries({
			queryKey: orpc.projects.stories.board.queryKey({
				input: { projectId, organizationId },
			}),
		});
	}, [queryClient, projectId, organizationId]);

	// Resolves once the open proposal has been read again after an action.
	// The action's mutation awaits it, so the actions stay busy until the
	// item it decided shows as locked; a background refresh of the proposal
	// (the tab regaining focus, another view's action) never disables them.
	const refreshOpenProposal = useCallback(
		() =>
			queryClient.refetchQueries(
				{
					queryKey: [
						"teams-channel-monitor-pending-proposal",
						projectId,
						organizationId,
					],
					type: "active",
				},
				{ cancelRefetch: false },
			),
		[queryClient, projectId, organizationId],
	);

	// Close the detail once the open proposal leaves the review queue while
	// it is on screen (its last item resolved, or a running apply finished
	// it), and refresh the lists when a running apply settles. A proposal that
	// was already out of the queue when opened (a deep link) stays open.
	const detailSeenRef = useRef<{ id: string; status: ProposalStatus } | null>(
		null,
	);
	const detailId = detailQuery.data?.id ?? null;
	const detailStatus = detailQuery.data?.status ?? null;
	useEffect(() => {
		if (!detailId || !detailStatus) {
			detailSeenRef.current = null;
			return;
		}
		const previous = detailSeenRef.current;
		detailSeenRef.current = { id: detailId, status: detailStatus };
		if (
			!previous ||
			previous.id !== detailId ||
			previous.status === detailStatus
		) {
			return;
		}
		if (isApplyInFlight(previous.status)) {
			invalidateAll();
		}
		if (leftReviewQueue(detailStatus) && detailId === selectedProposalId) {
			setSelectedProposalId(null);
		}
	}, [detailId, detailStatus, selectedProposalId, invalidateAll]);

	const applyWatchSettled =
		!!watchedApplyId &&
		(applyWatchQuery.isError || applyWatchQuery.data?.done === true);
	useEffect(() => {
		if (!applyWatchSettled) {
			return;
		}
		// The post-accept notice (Fizzy #2211 FR12/13) waits for the apply to
		// finish and only speaks when this accept created something — the
		// items it describes as labeled AI Recommended exist by now.
		const outcome = applyWatchQuery.data;
		const createdNow =
			outcome?.finished && outcome.createdTotal !== null && watchedApply
				? outcome.createdTotal - watchedApply.createdBefore
				: 0;
		if (
			aiRecommendedLifecycleEnabled &&
			createdNow > 0 &&
			notifiedApplyRef.current !== watchedApply
		) {
			notifiedApplyRef.current = watchedApply;
			toast.success(tAcceptedNotice("title", { count: createdNow }), {
				description: tAcceptedNotice("body"),
				duration: ACCEPTED_NOTICE_DURATION_MS,
			});
		}
		queryClient.invalidateQueries({ queryKey: ["capability-gates"] });
		invalidateAll();
		// Drop the settled answer so a later accept of the same batch (the
		// items left behind) starts watching afresh instead of reading it.
		queryClient.removeQueries({
			queryKey: applyWatchQueryKey,
			exact: true,
		});
		setWatchedApply(null);
	}, [
		applyWatchSettled,
		applyWatchQuery.data,
		watchedApply,
		aiRecommendedLifecycleEnabled,
		tAcceptedNotice,
		queryClient,
		invalidateAll,
		applyWatchQueryKey,
	]);

	const rememberSkippedTargets = (
		proposalId: string,
		skipped:
			| Array<{ changeIndex?: number; existingId?: string }>
			| undefined,
	) => {
		const matched = (skipped ?? []).filter(
			(s): s is { changeIndex: number; existingId: string } =>
				typeof s.changeIndex === "number" && !!s.existingId,
		);
		if (matched.length === 0) {
			return;
		}
		setSkippedTargets((prev) => {
			const byIndex = new Map<number, string>(
				prev && prev.proposalId === proposalId ? prev.byIndex : [],
			);
			for (const s of matched) {
				byIndex.set(s.changeIndex, s.existingId);
			}
			return { proposalId, byIndex };
		});
	};

	const approveMutation = useMutation({
		mutationFn: async (
			payload: Omit<
				ProposalApprovalRequest,
				"projectId" | "organizationId" | "pmConfig"
			> & {
				/** Items the proposal had already created (a returned batch). */
				createdBefore?: number;
				/** Set when one item is approved on its own (row or dialog). */
				changeIndex?: number;
				itemTitle?: string;
				/** That item was the proposal's last undecided one. */
				lastItem?: boolean;
				/** The ticket that item updates, when it is an update. */
				targetStoryId?: string;
			},
		): Promise<ApproveOutcome> =>
			requestProposalApproval({
				projectId,
				organizationId,
				pmConfig,
				proposalId: payload.proposalId,
				source: payload.source,
				approvedChanges: payload.approvedChanges,
				approvedChangeIndexes: payload.approvedChangeIndexes,
				pmSyncOverrides: payload.pmSyncOverrides,
				syncToPM: payload.syncToPM,
				expectedProposalRevision: payload.expectedProposalRevision,
			}),
		onSuccess: async (result, variables) => {
			rememberSkippedTargets(variables.proposalId, result.skipped);
			const heldBack = approveHeldBackToast(result);
			if (heldBack) {
				toast.error(heldBack.title, {
					description: heldBack.description,
				});
			}
			const message = approveOutcomeToast(result, variables);
			if (message.variant === "error") {
				toast.error(message.title, {
					description: message.description,
				});
			} else {
				const { ticketId } = message;
				toast.success(message.title, {
					...(message.description
						? { description: message.description }
						: {}),
					// The proposal closes with this item, and its row link
					// with it: the toast offers the ticket instead.
					...(ticketId
						? {
								action: {
									label: "Open ticket",
									onClick: () =>
										window.open(
											buildStoryDetailsRoute(
												basePath,
												projectId,
												ticketId,
											),
											"_blank",
											"noopener,noreferrer",
										),
								},
							}
						: {}),
				});
			}
			if (
				result.status === "dispatched" &&
				variables.source === ROADMAP_RECOMMENDATION_SOURCE
			) {
				// An accepted batch changes what the Roadmap gates read. This
				// covers the dispatch; the watch above refreshes again once the
				// apply has actually created the items.
				queryClient.invalidateQueries({
					queryKey: ["capability-gates"],
				});
				applyWatchPollsRef.current = 0;
				setWatchedApply({
					proposalId: variables.proposalId,
					createdBefore: variables.createdBefore ?? 0,
				});
			}
			invalidateAll();
			// Stay on the proposal while it is still open (items left, or its
			// apply still running); the refreshed detail closes itself once
			// the proposal leaves the queue. A proposal that is done, or
			// whose last item was just approved, returns to the list.
			if (approveClosesDetail(result, variables)) {
				setSelectedProposalId(null);
				return;
			}
			await refreshOpenProposal();
		},
		onError: async (error, variables) => {
			const conflict = proposalConflictMessage(error);
			if (conflict) {
				// A second reviewer raced us, or the proposal changed since it
				// was opened — refresh the now-stale proposal and tell the PM
				// why nothing changed (DEC-09 / FR-13). The detail stays open
				// on the refreshed state; it closes itself if the proposal has
				// left the queue.
				toast.error(conflict);
				invalidateAll();
				await refreshOpenProposal();
				return;
			}
			// The server's message names what is wrong (e.g. an update whose
			// target is not in this project), so it is shown as is.
			const title = approveRefusalTitle(
				variables.changeIndex === undefined
					? null
					: (variables.itemTitle ?? "this item"),
			);
			toast.error(title, {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	const rejectMutation = useMutation({
		mutationFn: async (payload: { proposalId: string; source: string }) => {
			return await endpointForSource(payload.source).reject({
				projectId,
				organizationId,
				proposalId: payload.proposalId,
			});
		},
		onSuccess: () => {
			toast.success("Proposal rejected");
			invalidateAll();
			setSelectedProposalId(null);
		},
		onError: (error) => {
			const conflict = proposalConflictMessage(error);
			if (conflict) {
				// A second reviewer raced us — refresh the now-stale row and
				// tell the PM why nothing changed (DEC-09 / FR-13).
				toast.error(conflict);
				invalidateAll();
				setSelectedProposalId(null);
				return;
			}
			toast.error("Failed to reject proposal", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	// Move a PENDING proposal to the Rejected view (stored as BACKLOG;
	// source-agnostic and routed per source
	// only for symmetry with approve/reject). Behaves like reject in the UI
	// (returns to the list, refreshes counts) but the row is preserved and
	// re-surfaces in the Rejected list instead of disappearing.
	const backlogMutation = useMutation({
		mutationFn: async (payload: {
			proposalId: string;
			source: string;
			/** Set when one item is moved alone; the rest stay in review. */
			changeIndex?: number;
			itemTitle?: string;
		}) => {
			if (payload.changeIndex !== undefined) {
				return await orpcClient.projects.backlog.proposals.rejectItem({
					projectId,
					organizationId,
					proposalId: payload.proposalId,
					changeIndex: payload.changeIndex,
				});
			}
			return await endpointForSource(payload.source).backlog({
				projectId,
				organizationId,
				proposalId: payload.proposalId,
			});
		},
		onSuccess: async (_result, variables) => {
			const itemTitle = variables.itemTitle ?? "this item";
			const title =
				variables.changeIndex === undefined
					? "Moved to Rejected"
					: `Moved “${itemTitle}” to Rejected`;
			toast.success(title, {
				description:
					"Find it anytime in Rejected proposals on your roadmap.",
			});
			invalidateAll();
			// A single item leaves the rest of the proposal in review; the
			// refreshed detail closes itself if nothing is left.
			if (variables.changeIndex === undefined) {
				setSelectedProposalId(null);
				return;
			}
			await refreshOpenProposal();
		},
		onError: async (error, variables) => {
			const conflict = proposalConflictMessage(error);
			if (conflict) {
				// A second reviewer already actioned it, or the proposal
				// changed — refresh the now-stale row and explain why nothing
				// changed. The detail stays open on the refreshed state.
				toast.error(conflict);
				invalidateAll();
				await refreshOpenProposal();
				return;
			}
			const itemTitle = variables.itemTitle ?? "this item";
			const title =
				variables.changeIndex === undefined
					? "Failed to move proposal to Rejected"
					: `Couldn't move “${itemTitle}” to Rejected`;
			toast.error(title, {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	// Source-aware retry. AI Update sidebar proposals call the new
	// `proposals.retry` procedure (which re-invokes the workflow with
	// the dedup-guard idempotency invariant). Channel-monitor rows keep
	// using the per-source `approve` endpoint via the existing detail-
	// view approve flow — we don't expose a per-row Retry button on
	// channel-monitor rows because the user needs the diff-review surface
	// before re-approving (the approve endpoint validates the same
	// `approvedChanges` shape it did the first time around).
	const retryMutation = useMutation({
		mutationFn: async (payload: { proposalId: string }) => {
			return await orpcClient.projects.backlog.proposals.retry({
				projectId,
				organizationId,
				proposalId: payload.proposalId,
			});
		},
		onSuccess: (result) => {
			if (result?.workflowId === null) {
				// Full-dedup short-circuit — every change already existed
				// on the roadmap, no workflow restarted. Surface so the
				// user knows the row left the Failed group as APPLIED.
				toast.success(result.message ?? "Already on roadmap.");
			} else {
				toast.success("Retry queued.");
			}
			const heldBack = heldBackToast(result?.heldBack);
			if (heldBack) {
				toast.error(heldBack.title, {
					description: heldBack.description,
				});
			}
			invalidateAll();
		},
		onError: (error) => {
			toast.error("Couldn't retry proposal", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	const dismissMutation = useMutation({
		mutationFn: async (payload: { proposalId: string }) => {
			return await orpcClient.projects.backlog.proposals.dismiss({
				projectId,
				organizationId,
				proposalId: payload.proposalId,
			});
		},
		onSuccess: () => {
			toast.success("Dismissed.", {
				description: "See Sync History for the audit record.",
			});
			invalidateAll();
			setPendingDismiss(null);
		},
		onError: (error) => {
			toast.error("Failed to dismiss proposal", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
			setPendingDismiss(null);
		},
	});

	const proposals = listQuery.data ?? [];
	// The search narrows every group the list shows; counts in the group
	// headings follow it.
	const visibleProposals = filterProposalsByQuery(proposals, searchQuery);
	const pendingRows = visibleProposals.filter((p) => p.status === "PENDING");
	const inFlightRows = visibleProposals.filter(
		(p) => p.status === "APPROVED" || p.status === "APPLYING",
	);
	const failedRows = visibleProposals.filter((p) => p.status === "FAILED");
	// Rejected rows (stored as BACKLOG) come from their own query and are never
	// mixed into the active `proposals` list, so the Pending/Failed groups and
	// every active count exclude rejected proposals.
	const allBacklogRows = backlogQuery.data ?? [];
	const backlogRows = filterProposalsByQuery(allBacklogRows, searchQuery);
	const clearSearch = () => setSearchQuery("");

	// Source-aware sheet header. This inbox is a unified review/retry surface
	// for BOTH monitored-channel proposals AND AI Update sidebar proposals
	// (which land here for apply/retry). Hardcoding a "from monitored channels /
	// feature proposals" framing mislabels AI Update runs — the reported
	// confusion — so derive the header from the source(s) actually shown: the
	// selected proposal in detail view, or the union of sources in list view.
	const headerSelectedProposal = selectedProposalId
		? proposals.find((p) => p.id === selectedProposalId)
		: undefined;
	const headerSources = headerSelectedProposal
		? [headerSelectedProposal.source]
		: proposals.map((p) => p.source);
	const headerHasAiUpdate = headerSources.some(
		(s) => s === "AI_UPDATE_SIDEBAR",
	);
	const headerHasRecommendation = headerSources.some(
		(s) => s === ROADMAP_RECOMMENDATION_SOURCE,
	);
	const headerHasChannel = headerSources.some(
		(s) => s !== "AI_UPDATE_SIDEBAR" && s !== ROADMAP_RECOMMENDATION_SOURCE,
	);
	// Opened from the Roadmap archive icon: this drawer becomes a dedicated
	// Rejected list (stored as BACKLOG), not the active review queue.
	const isBacklogView = defaultFilter === "backlog";
	const headerContent = isBacklogView
		? {
				eyebrow: "Review archive",
				title: "Rejected proposals",
				description:
					"Proposals you moved to Rejected remain recoverable here. Restore and apply one when it becomes relevant, or delete it permanently.",
			}
		: headerHasRecommendation && !headerHasAiUpdate && !headerHasChannel
			? {
					eyebrow: "From project context",
					title: "Proposal Inbox",
					description:
						"Review the features Fabric recommended from your project context. Accept some now and come back for the rest.",
				}
			: headerHasAiUpdate && !headerHasChannel && !headerHasRecommendation
				? {
						eyebrow: "From AI Update",
						title: "Pending AI Update changes",
						description:
							"Review and apply the backlog changes proposed by your AI Update run.",
					}
				: headerHasRecommendation
					? {
							eyebrow: "Backlog proposals",
							title: "Proposal Inbox",
							description:
								"Review and apply backlog changes recommended from your project context, from AI Update, and from your monitored meeting transcripts, Teams, and Slack channels.",
						}
					: headerHasAiUpdate && headerHasChannel
						? {
								eyebrow: "Backlog proposals",
								title: "Proposal Inbox",
								description:
									"Review and apply backlog changes from AI Update and your monitored meeting transcripts, Teams, and Slack channels.",
							}
						: {
								eyebrow: "From monitored sources",
								title: "Proposal Inbox",
								description:
									"Review and approve proposals surfaced from your monitored meeting transcripts, Teams, and Slack channels, and from recurring errors.",
							};
	const HeaderIcon = isBacklogView
		? ArchiveIcon
		: (headerHasAiUpdate || headerHasRecommendation) && !headerHasChannel
			? SparklesIcon
			: InboxIcon;

	// Auto-scroll the Failed section into view when the inbox is opened
	// with `defaultFilter="failed"`. The effect only runs once per open
	// session; `autoScrolledRef` flips on scroll and resets on close
	// (effect above).
	useEffect(() => {
		if (!open || defaultFilter !== "failed") {
			return;
		}
		if (autoScrolledRef.current) {
			return;
		}
		if (listQuery.isLoading) {
			return;
		}
		if (failedRows.length === 0) {
			return;
		}
		const node = failedSectionRef.current;
		if (!node) {
			return;
		}
		const raf = requestAnimationFrame(() => {
			node.scrollIntoView({ behavior: "smooth", block: "start" });
			autoScrolledRef.current = true;
		});
		return () => cancelAnimationFrame(raf);
	}, [open, defaultFilter, listQuery.isLoading, failedRows.length]);

	const renderList = () => {
		// Dedicated Rejected list — opened from the Roadmap archive icon. Shows
		// only dismissed proposals as a clean list (no Pending/Failed sections).
		if (isBacklogView) {
			if (backlogQuery.isLoading) {
				return (
					<div className="flex items-center justify-center py-12 text-muted-foreground">
						<Loader2Icon className="mr-2 size-5 animate-spin" />
						Loading rejected proposals...
					</div>
				);
			}
			if (allBacklogRows.length === 0) {
				return (
					<div
						className="relative overflow-hidden rounded-lg border bg-muted p-10 text-center"
						style={{
							backgroundImage:
								"radial-gradient(circle, rgba(0,0,0,0.13) 1px, transparent 1px)",
							backgroundSize: "32px 32px",
						}}
					>
						<div className="relative z-10">
							<ArchiveIcon className="mx-auto mb-4 size-10 text-muted-foreground" />
							<h3 className="text-2xl font-semibold leading-tight text-foreground">
								No rejected proposals
							</h3>
							<p className="mt-2 text-sm text-muted-foreground">
								Proposals you move to Rejected appear here,
								where you can restore and apply or permanently
								delete them.
							</p>
						</div>
					</div>
				);
			}
			return (
				<div className="space-y-4">
					<ProposalInboxSearch
						value={searchQuery}
						onChange={setSearchQuery}
						matchCount={backlogRows.length}
						label="Search rejected proposals"
					/>
					{backlogRows.length === 0 ? (
						<ProposalSearchNoMatches
							query={searchQuery}
							onClear={clearSearch}
						/>
					) : (
						<div className="space-y-2">
							{backlogRows.map((proposal) => (
								<ProposalRow
									key={proposal.id}
									proposal={proposal}
									onSelect={() =>
										setSelectedProposalId(proposal.id)
									}
								/>
							))}
						</div>
					)}
				</div>
			);
		}

		if (listQuery.isLoading) {
			return (
				<div className="flex items-center justify-center py-12 text-muted-foreground">
					<Loader2Icon className="mr-2 size-5 animate-spin" />
					Loading proposals...
				</div>
			);
		}

		// "All caught up" when the active review queue is empty. Rejected proposals
		// have their own dedicated list (opened from the Roadmap archive icon), so
		// they no longer factor into this active-queue empty state.
		if (proposals.length === 0) {
			return (
				<div
					className="relative overflow-hidden rounded-lg border bg-muted p-10 text-center"
					style={{
						backgroundImage:
							"radial-gradient(circle, rgba(0,0,0,0.13) 1px, transparent 1px)",
						backgroundSize: "32px 32px",
					}}
				>
					<div className="relative z-10">
						<CheckCircle2Icon className="mx-auto mb-4 size-10 text-muted-foreground" />
						<h3 className="text-2xl font-semibold leading-tight text-foreground">
							All caught up
						</h3>
						<p className="mt-2 text-sm text-muted-foreground">
							No proposals awaiting review right now. We will let
							you know when monitored channels surface new feature
							ideas.
						</p>
					</div>
				</div>
			);
		}

		const visibleCount =
			pendingRows.length + inFlightRows.length + failedRows.length;
		return (
			<div className="space-y-6">
				<ProposalInboxSearch
					value={searchQuery}
					onChange={setSearchQuery}
					matchCount={visibleCount}
					label="Search proposals"
				/>
				{visibleCount === 0 && searchQuery.trim() !== "" && (
					<ProposalSearchNoMatches
						query={searchQuery}
						onClear={clearSearch}
					/>
				)}
				{pendingRows.length > 0 && (
					<section>
						<span className="editorial-label">
							Pending ({pendingRows.length})
						</span>
						<div className="mt-3 space-y-2">
							{pendingRows.map((proposal) => (
								<ProposalRow
									key={proposal.id}
									proposal={proposal}
									onSelect={() =>
										setSelectedProposalId(proposal.id)
									}
								/>
							))}
						</div>
					</section>
				)}
				{inFlightRows.length > 0 && (
					<section>
						<span className="editorial-label">
							Applying ({inFlightRows.length})
						</span>
						<div className="mt-3 space-y-2">
							{inFlightRows.map((proposal) => (
								<ProposalRow
									key={proposal.id}
									proposal={proposal}
									onSelect={() =>
										setSelectedProposalId(proposal.id)
									}
								/>
							))}
						</div>
					</section>
				)}
				{failedRows.length > 0 && (
					<section
						ref={failedSectionRef}
						aria-label="Failed proposals"
					>
						<span className="editorial-label">
							Failed ({failedRows.length})
						</span>
						<div className="mt-3 space-y-2">
							{failedRows.map((proposal) => (
								<FailedProposalRow
									key={proposal.id}
									proposal={proposal}
									onSelect={() =>
										setSelectedProposalId(proposal.id)
									}
									onRetry={() =>
										retryMutation.mutate({
											proposalId: proposal.id,
										})
									}
									onDismiss={() =>
										setPendingDismiss({
											proposalId: proposal.id,
											source: proposal.source,
										})
									}
									isRetrying={
										retryMutation.isPending &&
										retryMutation.variables?.proposalId ===
											proposal.id
									}
									isDismissing={
										dismissMutation.isPending &&
										dismissMutation.variables
											?.proposalId === proposal.id
									}
								/>
							))}
						</div>
					</section>
				)}
			</div>
		);
	};

	const renderDetail = () => {
		if (detailQuery.isLoading) {
			return (
				<div className="flex items-center justify-center py-12 text-muted-foreground">
					<Loader2Icon className="mr-2 size-5 animate-spin" />
					Loading proposal...
				</div>
			);
		}
		const detail = detailQuery.data;
		if (!detail) {
			return (
				<div className="py-8 text-center text-muted-foreground">
					Proposal not found.
				</div>
			);
		}

		const proposalJson = (detail.proposal ?? {}) as ProposalJson;
		const changes = proposalJson.changes ?? [];
		const summary = proposalJson.summary ?? detail.summary ?? "";
		const contextSummary = proposalJson.contextSummary ?? "";
		const visionSuggestions = proposalJson.visionSuggestions ?? null;
		const metadata =
			(detail.sourceMetadata as Record<string, unknown> | null) ?? null;
		const isTeamsChat = detail.source === "TEAMS_CHAT";
		const isMeeting = detail.source === "MONITORED_MEETING";
		const conversationName = conversationNameFromMetadata(
			detail.source,
			metadata,
		);
		const conversationLabel = isTeamsChat
			? (conversationName ?? "a Teams chat")
			: conversationName && `#${conversationName}`;
		const threadLink = threadLinkFromMetadata(
			detail.source,
			metadata,
			detail.teamsChatSourceLink ?? null,
		);
		const isFailed = detail.status === "FAILED";
		const provider = providerLabel(detail.source);
		const meetingSubject = meetingSubjectFromMetadata(metadata);
		const meetingDate = formatMeetingBadgeDate(metadata?.meetingDate);
		const transcript = transcriptFromMetadata(metadata);
		const conversationTranscript =
			isChannelMonitorSource(detail.source) && !isMeeting
				? transcript
				: null;
		// Async decision pre-check findings persisted alongside the proposal.
		// A stale/absent/ok result yields null so the banner and the per-change
		// notes render nothing.
		const decisionPrecheck = extractDecisionPrecheck(
			metadata?.decisionPrecheck,
		);
		const decisionConflictCount =
			decisionPrecheck?.status === "conflicts"
				? countDistinctDecisions(decisionPrecheck.findings)
				: 0;
		const filename = filenameFromMetadata(metadata);
		const isScopeDocument = detail.source === "SCOPE_DOCUMENT";
		const isInFlight =
			detail.status === "APPLYING" || detail.status === "APPROVED";
		const isRecommendation =
			detail.source === ROADMAP_RECOMMENDATION_SOURCE;
		// Locked = what the server counts as resolved: applied (of those, only
		// what the application table recorded was created; the rest were
		// already on the Roadmap) or moved to Rejected on its own. Only the
		// rest can be selected or actioned, so a resolved index is never
		// submitted twice.
		const itemState = deriveProposalItemState({
			resolvedItems: detail.resolvedItems,
			createdChangeIndexes: detail.createdChangeIndexes,
			applications: detail.applications,
			duplicateResolutions: detail.duplicateResolutions,
			restoredItems: detail.restoredItems,
			appliedReason: isRecommendation ? "accepted" : "applied",
			skippedTargets:
				skippedTargets?.proposalId === detail.id
					? skippedTargets.byIndex
					: undefined,
		});
		const acceptedCount = itemState.appliedCount;
		const alreadyOnRoadmapCount = itemState.alreadyOnRoadmapCount;
		// Items the proposal had already created before this approve.
		const createdBefore = detail.createdChangeIndexes.length;
		const approving = approveMutation.isPending
			? approveMutation.variables
			: undefined;
		const backlogging = backlogMutation.isPending
			? backlogMutation.variables
			: undefined;
		// The single-item action in flight on this proposal, if any.
		let pendingItemAction: PendingItemAction | null = null;
		if (
			approving?.proposalId === detail.id &&
			approving.changeIndex !== undefined
		) {
			pendingItemAction = {
				changeIndex: approving.changeIndex,
				action: "approve",
			};
		} else if (
			backlogging?.proposalId === detail.id &&
			backlogging.changeIndex !== undefined
		) {
			pendingItemAction = {
				changeIndex: backlogging.changeIndex,
				action: "reject",
			};
		}
		// A whole-proposal approve is collapsed to its "Approved N of M"
		// summary while it runs; once it answers, the view returns to the
		// (refreshed) items if the proposal is still open.
		const wholeApprovePending =
			approving?.proposalId === detail.id &&
			approving.changeIndex === undefined;
		const wholeApproveCount = approving?.approvedChangeIndexes?.length ?? 0;
		const actionsBusy =
			approveMutation.isPending ||
			backlogMutation.isPending ||
			rejectMutation.isPending;
		const entryPointLabel =
			typeof metadata?.entryPoint === "string"
				? (RECOMMENDATION_ENTRY_POINT_LABELS[metadata.entryPoint] ??
					null)
				: null;
		const requestedAt =
			typeof metadata?.requestedAt === "string"
				? new Date(metadata.requestedAt)
				: null;
		const hasRequestedAt =
			requestedAt !== null && !Number.isNaN(requestedAt.getTime());
		// A batch returns to review after an accept that partly failed; the
		// Failed group never sees it, so the reason is shown here (AC-15).
		const lastAcceptError =
			isRecommendation && detail.status === "PENDING"
				? (detail.errorMessage?.replace(/\.+$/, "") ?? null)
				: null;

		return (
			<div className="space-y-4">
				<div>
					<button
						type="button"
						onClick={() => setSelectedProposalId(null)}
						className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
					>
						<ArrowLeftIcon className="size-3.5" />
						{isBacklogView
							? "Back to Rejected proposals"
							: "Back to inbox"}
					</button>
				</div>

				{isScopeDocument && (
					<div className="rounded-lg border border-foreground/10 bg-muted/40 p-3 text-sm">
						<div className="flex flex-wrap items-center gap-2">
							<FileTextIcon className="size-3.5 text-muted-foreground" />
							<span className="text-muted-foreground">
								Extracted from scope document
							</span>
							{filename && (
								<span className="font-medium text-foreground">
									{filename}
								</span>
							)}
							{typeof metadata?.rowCount === "number" && (
								<span className="text-xs text-muted-foreground">
									{metadata.rowCount} line(s)
								</span>
							)}
						</div>
					</div>
				)}

				{isRecommendation && (
					<div className="space-y-1 rounded-lg border border-foreground/10 bg-muted/40 p-3 text-sm">
						<div className="flex flex-wrap items-center gap-2">
							<SparklesIcon
								className="size-3.5 text-muted-foreground"
								aria-hidden="true"
							/>
							<span className="font-medium text-foreground">
								Recommended from project context
							</span>
						</div>
						{(entryPointLabel || hasRequestedAt) && (
							<p className="text-xs text-muted-foreground">
								{entryPointLabel && `via ${entryPointLabel}`}
								{entryPointLabel && hasRequestedAt && " · "}
								{hasRequestedAt &&
									`requested ${formatDistanceToNow(
										requestedAt,
										{
											addSuffix: true,
										},
									)}`}
							</p>
						)}
						<p className="text-xs text-muted-foreground">
							{acceptedCount} of {detail.changeCount} accepted
							{alreadyOnRoadmapCount > 0 &&
								` · ${alreadyOnRoadmapCount} skipped, already on the Roadmap`}
						</p>
					</div>
				)}

				{lastAcceptError && (
					<div
						role="alert"
						className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
					>
						<AlertTriangleIcon
							className="mt-0.5 size-4 shrink-0"
							aria-hidden="true"
						/>
						<p>
							Some features from your last accept weren't created:{" "}
							{lastAcceptError}. They are still selectable below —
							accept them again.
						</p>
					</div>
				)}

				{isInFlight && (
					<div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success">
						<Loader2Icon className="size-4 motion-safe:animate-spin" />
						This proposal is being applied. Changes will appear on
						the roadmap when it finishes.
					</div>
				)}

				{(conversationName || threadLink || conversationTranscript) && (
					<div className="rounded-lg border border-foreground/10 bg-muted/40 p-3 text-sm">
						<div className="flex flex-wrap items-center gap-2">
							{detail.source === "SLACK_CHANNEL" ? (
								<SlackIcon className="size-3.5 text-muted-foreground" />
							) : (
								<HashIcon className="size-3.5 text-muted-foreground" />
							)}
							<span className="text-muted-foreground">
								{detail.source === "SLACK_CHANNEL"
									? "Posted in"
									: isTeamsChat
										? "Based on a conversation in"
										: "Based on a thread in"}
							</span>
							{conversationLabel && (
								<span className="font-medium text-foreground">
									{conversationLabel}
								</span>
							)}
							{threadLink && (
								<TooltipProvider>
									<Tooltip>
										<TooltipTrigger asChild>
											<a
												href={threadLink}
												target="_blank"
												rel="noopener noreferrer"
												className="inline-flex min-h-6 items-center gap-1 text-primary hover:underline"
												aria-label={`Open original message in ${provider}`}
											>
												<span className="text-xs">
													see original
												</span>
												<ExternalLinkIcon className="size-3" />
											</a>
										</TooltipTrigger>
										<TooltipContent>
											Open original message in {provider}
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
							)}
						</div>
						{conversationTranscript && (
							<SourceTranscript
								label="See original conversation"
								text={conversationTranscript}
							/>
						)}
					</div>
				)}

				{isMeeting && (
					<div className="rounded-lg border border-foreground/10 bg-muted/40 p-3 text-sm">
						<div className="flex flex-wrap items-center gap-2">
							<CalendarIcon
								className="size-3.5 text-muted-foreground"
								aria-hidden="true"
							/>
							<span className="text-muted-foreground">From</span>
							<span className="font-medium text-foreground">
								{meetingSubject ?? "a monitored meeting"}
							</span>
							{meetingDate && (
								<span className="text-muted-foreground">
									· {meetingDate}
								</span>
							)}
						</div>
						{transcript && (
							<SourceTranscript
								label="See original transcript"
								text={transcript}
							/>
						)}
					</div>
				)}

				<RecurringErrorSourcePanel
					source={detail.source}
					sourceMetadata={metadata}
				/>

				{isFailed && (
					<div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs space-y-2">
						<div className="flex items-start gap-2 text-destructive">
							<AlertTriangleIcon
								className="size-4 shrink-0 mt-0.5"
								aria-hidden="true"
							/>
							<p className="text-sm font-medium">
								{failureClassToCopy(detail.errorClass, detail)}
							</p>
						</div>
						{(detail.errorMessage || detail.applyError) && (
							<details className="text-xs">
								<summary className="cursor-pointer text-destructive hover:text-destructive">
									Show details
								</summary>
								<pre className="mt-2 whitespace-pre-wrap text-destructive">
									{detail.errorMessage ?? detail.applyError}
								</pre>
							</details>
						)}
					</div>
				)}

				{decisionConflictCount > 0 && (
					// biome-ignore lint/a11y/useSemanticElements: a proposal-level contradiction summary is a polite status region present on load, not a form output; <div role="status"> is the WAI-ARIA idiom and mirrors the destructive banner above.
					<div
						role="status"
						className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm"
					>
						<div className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
							<AlertTriangleIcon
								className="size-4 shrink-0 mt-0.5"
								aria-hidden="true"
							/>
							<p className="text-sm font-medium">
								{t("proposalBanner", {
									count: decisionConflictCount,
								})}
							</p>
						</div>
					</div>
				)}

				<BacklogChangeProposal
					// Per-proposal review state never carries over when a
					// duplicate note opens another proposal in place.
					key={detail.id}
					panel="feature-proposals"
					summary={summary}
					contextSummary={contextSummary}
					changes={changes}
					decisionConflicts={decisionPrecheck}
					// REQUIRED for in-review drafting: BacklogChangeProposal's
					// reformatBodyForKind no-ops without a projectId, so without
					// these the Feature/Bug toggle and the draft-on-open silently
					// did nothing in the inbox — the body never reformatted and the
					// reviewer only ever saw the analyzer's raw text.
					projectId={projectId}
					organizationId={organizationId}
					boardStoryIds={boardStoryIds}
					// Persisted, team-shared in-review drafts keyed by this
					// proposal id. The reviewer triggers drafting explicitly via
					// "Draft with AI"; either way the ticket is created through the
					// kind prompt at apply.
					proposalId={detail.id}
					// Show the "Also sync to {PM Tool}" checkbox when the
					// project has a PM tool configured, mirroring AI Update —
					// but default it OFF (below) so channel-monitor approvals
					// stay Fabric-only unless the reviewer opts in.
					hasPMTool={hasPMTool}
					pmToolName={pmToolName}
					defaultSyncToPM={false}
					visionSuggestions={visionSuggestions}
					// Scope persisted review state to the proposal id so a
					// PM who walks away mid-review and comes back to the
					// inbox lands on the same selection / reviewed-row /
					// per-field skip state they had before. AC #4 of the
					// AI-Update detail-review story.
					persistenceKey={`proposal:${detail.id}`}
					// Chat-thread image attachments — populated by the
					// Slack / Teams channel-monitor activities at
					// fetch-time and surfaced as the `📎 N` / `⚠ M`
					// chips on the proposal header. Legacy proposals
					// predating the feature carry no `attachments` key
					// and arrive here as `[]` via the defensive readers
					// above (FR-27).
					attachments={readAttachments(metadata)}
					attachmentWarnings={readAttachmentWarnings(metadata)}
					proposalStatus={detail.status}
					// Bug 1429 / Codex P1+D: gate epic->feature normalization
					// on the proposal SOURCE. The three monitored-channel
					// sources (Teams channel/chat + Slack) are feature/bug-
					// only, so normalize. AI_UPDATE_SIDEBAR rows also surface
					// in this inbox (e.g. FAILED general AI Update rows) and
					// keep `epic` first-class — they must NOT be rewritten.
					forbidEpics={isChannelMonitorSource(detail.source)}
					// A proposal stays open while any item is unresolved: what
					// was applied or moved to Rejected is locked, and each
					// other item can be decided on its own. A recommendation
					// batch also makes Features only, and every accepted item
					// is drafted through Clean Spec at apply.
					itemReview={{
						lockedReasons: itemState.lockedReasons,
						lockedTargets: itemState.lockedTargets,
						pendingItemAction,
						duplicateFlags: duplicateReview.flags,
						duplicateChecking: duplicateReview.checking,
						duplicateLoading: duplicateReview.loading,
						onOpenProposal: openProposalFromDuplicate,
						targetChangedIndexes: new Set(
							detail.targetChangedSinceProposalIndexes,
						),
						updateTargetBodies: new Map(
							(detail.updateTargetBodies ?? []).map((bodies) => [
								bodies.changeIndex,
								bodies,
							]),
						),
						heldBackUpdateIndexes: new Set(
							detail.heldBackUpdateIndexes,
						),
						onApproveItem: (
							approvedChange,
							syncToPM,
							pmSyncOverrides,
							changeIndex,
						) => {
							approveMutation.mutate({
								proposalId: detail.id,
								source: detail.source,
								approvedChanges: [approvedChange],
								approvedChangeIndexes: [changeIndex],
								pmSyncOverrides,
								syncToPM,
								expectedProposalRevision:
									detail.proposalRevision,
								createdBefore,
								changeIndex,
								itemTitle: approvedChange.title.to,
								lastItem: detail.remainingCount === 1,
								targetStoryId:
									approvedChange.action === "update"
										? approvedChange.existingId
										: undefined,
							});
						},
						onRejectItem: (changeIndex, itemTitle) => {
							backlogMutation.mutate({
								proposalId: detail.id,
								source: detail.source,
								changeIndex,
								itemTitle,
							});
						},
						onReviewOnTicket: navigate
							? (
									approvedChange,
									syncToPM,
									pmSyncOverrides,
									changeIndex,
								) => {
									if (
										approvedChange.action !== "update" ||
										!approvedChange.existingId
									) {
										return;
									}
									startProposalTicketReview({
										projectId,
										organizationId,
										storyId: approvedChange.existingId,
										proposalId: detail.id,
										source: detail.source,
										changeIndex,
										change: approvedChange,
										syncToPM,
										pmSyncOverrides,
										pmConfig,
										expectedProposalRevision:
											detail.proposalRevision,
									});
									navigate(
										buildStoryCleanSpecRoute(
											basePath,
											projectId,
											approvedChange.existingId,
										),
									);
								}
							: undefined,
					}}
					showSelectAll={isRecommendation}
					allowKindOverride={!isRecommendation}
					allowInReviewDrafting={!isRecommendation}
					approval={{
						state: wholeApprovePending ? "approved" : "reviewing",
						count: wholeApproveCount,
					}}
					actionsBusy={actionsBusy}
					applyProgressMsg={
						approveMutation.isPending
							? "Submitting proposal..."
							: undefined
					}
					onApprove={(
						approvedChanges,
						syncToPM,
						pmSyncOverrides,
						approvedChangeIndexes,
					) => {
						approveMutation.mutate({
							proposalId: detail.id,
							source: detail.source,
							approvedChanges,
							approvedChangeIndexes,
							pmSyncOverrides,
							syncToPM,
							expectedProposalRevision: detail.proposalRevision,
							createdBefore,
						});
					}}
					onReject={() => {
						rejectMutation.mutate({
							proposalId: detail.id,
							source: detail.source,
						});
					}}
					// Move to Rejected. The button is gated internally on
					// `proposalStatus === "PENDING"`, so a backlogged/failed row
					// opened here won't show it (approve/reject still do).
					onBacklog={() => {
						backlogMutation.mutate({
							proposalId: detail.id,
							source: detail.source,
						});
					}}
				/>

				{isRecommendation ? (
					<p className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
						Each feature you accept is written up through your
						project's feature specification prompt as it is created.
					</p>
				) : (
					<p className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
						Open a proposal to draft its description and acceptance
						criteria through your project's prompt — and to switch
						it between Bug and Feature. Proposals you approve
						without opening are drafted on approve.
					</p>
				)}
			</div>
		);
	};

	return (
		<>
			<Sheet open={open} onOpenChange={onOpenChange}>
				<SheetContent
					side="right"
					className="flex w-full max-w-2xl flex-col gap-0 p-0 sm:max-w-2xl"
				>
					<SheetHeader className="space-y-2 border-b border-border/60 px-6 py-5">
						<div className="flex items-center gap-2">
							<HeaderIcon className="size-4 text-muted-foreground" />
							<span className="editorial-label">
								{headerContent.eyebrow}
							</span>
						</div>
						<SheetTitle className="text-2xl font-semibold leading-tight">
							{headerContent.title}
						</SheetTitle>
						<SheetDescription>
							{headerContent.description}
						</SheetDescription>
					</SheetHeader>
					<div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
						{selectedProposalId ? renderDetail() : renderList()}
					</div>
				</SheetContent>
			</Sheet>
			<AlertDialog
				open={pendingDismiss !== null}
				onOpenChange={(o) => {
					if (!o) {
						setPendingDismiss(null);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Dismiss this proposal?
						</AlertDialogTitle>
						<AlertDialogDescription>
							Dismiss this failed proposal? A record will be kept
							in Sync History.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel
							disabled={dismissMutation.isPending}
							onClick={() => setPendingDismiss(null)}
						>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							disabled={dismissMutation.isPending}
							onClick={() => {
								if (pendingDismiss) {
									dismissMutation.mutate({
										proposalId: pendingDismiss.proposalId,
									});
								}
							}}
						>
							{dismissMutation.isPending ? (
								<>
									<Loader2Icon className="mr-2 size-4 animate-spin" />
									Dismissing…
								</>
							) : (
								"Dismiss"
							)}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

function ProposalRow({
	proposal,
	onSelect,
}: {
	proposal: PendingProposalRow;
	onSelect: () => void;
}) {
	const metadata =
		(proposal.sourceMetadata as Record<string, unknown> | null) ?? null;
	const filename = filenameFromMetadata(metadata);
	const isScopeDocument = proposal.source === "SCOPE_DOCUMENT";
	const createdLabel = formatDistanceToNow(new Date(proposal.createdAt), {
		addSuffix: true,
	});
	return (
		<button
			type="button"
			onClick={onSelect}
			className="group flex w-full items-start gap-3 rounded-lg border border-foreground/10 bg-card p-4 text-left transition-colors hover:bg-accent/50"
		>
			<div className="min-w-0 flex-1 space-y-2">
				<div className="flex flex-wrap items-center gap-2">
					<ProposalSourceBadge
						source={proposal.source}
						sourceMetadata={metadata}
					/>
					{isScopeDocument && filename && (
						<span className="max-w-[16rem] truncate text-xs text-foreground/70">
							{filename}
						</span>
					)}
					<span
						className={cn(
							"inline-flex items-center rounded-md border px-2 py-0.5 text-xs",
							statusPillClasses(proposal.status),
						)}
					>
						{proposal.status === "PENDING"
							? "Pending"
							: proposal.status === "FAILED"
								? "Failed"
								: proposal.status === "BACKLOG"
									? "Rejected"
									: isApplyInFlight(proposal.status)
										? "Applying"
										: proposal.status}
					</span>
					<span className="text-xs text-muted-foreground">
						{createdLabel}
					</span>
				</div>
				<p className="line-clamp-2 text-sm text-foreground/80">
					{stripMarkdown(proposal.summary)}
				</p>
				{proposal.status === "BACKLOG" && (
					<MergedIntoNote sourceMetadata={metadata} />
				)}
				<div className="text-xs text-muted-foreground">
					{changeCountLabel(proposal)}
				</div>
			</div>
			<ChevronRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
		</button>
	);
}

/**
 * Row variant for `status === "FAILED"`. Surfaces the plain-English copy
 * derived from `errorClass` (via `failureClassToCopy`) above the raw
 * `errorMessage` / `applyError` behind a "Show details" expander, and
 * exposes per-row Retry + Dismiss actions.
 *
 * Retry routing:
 *   - `source === "AI_UPDATE_SIDEBAR"` → the new
 *     `proposals.retry` procedure (workflow restart with the dedup-guard
 *     idempotency invariant; see `retryMutation` above).
 *   - channel-monitor sources (Teams / Slack) → the existing detail-
 *     view approve flow is the canonical retry path. We don't expose a
 *     per-row Retry button for those because re-approval needs the
 *     diff-review surface; we route the user to the detail view via
 *     the row click instead.
 *
 * Dismiss is exposed for every source — clicking surfaces a confirm
 * dialog at the parent level (`pendingDismiss` state) which on confirm
 * calls `proposals.dismiss` (PmSyncLog audit row + hard-delete).
 *
 * Accessibility: buttons are first-class — the outer container is a
 * `<div>`, not a `<button>`, so nested actions remain keyboard-
 * reachable without the parent capturing their clicks.
 */
function FailedProposalRow({
	proposal,
	onSelect,
	onRetry,
	onDismiss,
	isRetrying,
	isDismissing,
}: {
	proposal: PendingProposalRow;
	onSelect: () => void;
	onRetry: () => void;
	onDismiss: () => void;
	isRetrying: boolean;
	isDismissing: boolean;
}) {
	const metadata =
		(proposal.sourceMetadata as Record<string, unknown> | null) ?? null;
	const failedLabel = proposal.failedAt
		? formatDistanceToNow(new Date(proposal.failedAt), { addSuffix: true })
		: formatDistanceToNow(new Date(proposal.createdAt), {
				addSuffix: true,
			});
	const isSidebarSource = proposal.source === "AI_UPDATE_SIDEBAR";
	const failureCopy = failureClassToCopy(proposal.errorClass, proposal);
	const rawError = proposal.errorMessage ?? proposal.applyError;

	return (
		<div className="rounded-lg border border-destructive/30 bg-card p-4">
			<div className="flex flex-wrap items-center gap-2">
				<ProposalSourceBadge
					source={proposal.source}
					sourceMetadata={metadata}
				/>
				<span
					className={cn(
						"inline-flex items-center rounded-md border px-2 py-0.5 text-xs",
						statusPillClasses("FAILED"),
					)}
				>
					Failed
				</span>
				<span className="text-xs text-muted-foreground">
					{failedLabel}
				</span>
			</div>

			<button
				type="button"
				onClick={onSelect}
				className="mt-2 block w-full text-left"
			>
				<p className="line-clamp-2 text-sm text-foreground/80 hover:underline">
					{stripMarkdown(proposal.summary)}
				</p>
				<div className="mt-1 text-xs text-muted-foreground">
					{changeCountLabel(proposal)}
				</div>
			</button>

			<div className="mt-3 flex items-start gap-2 text-destructive">
				<AlertTriangleIcon
					className="size-4 shrink-0 mt-0.5"
					aria-hidden="true"
				/>
				<p className="text-sm">{failureCopy}</p>
			</div>

			{rawError && (
				<details className="mt-2 text-xs">
					<summary className="cursor-pointer text-destructive hover:text-destructive">
						Show details
					</summary>
					<pre className="mt-2 whitespace-pre-wrap text-destructive">
						{rawError}
					</pre>
				</details>
			)}

			<div className="mt-3 flex flex-wrap items-center gap-2">
				{isSidebarSource ? (
					<Button
						size="sm"
						variant="outline"
						onClick={onRetry}
						disabled={isRetrying}
						aria-label={
							isRetrying
								? "Retry in progress"
								: "Retry this failed proposal"
						}
					>
						{isRetrying ? (
							<>
								<Loader2Icon
									className="mr-2 size-3.5 animate-spin"
									aria-hidden="true"
								/>
								Retrying…
							</>
						) : (
							<>
								<RefreshCwIcon
									className="mr-2 size-3.5"
									aria-hidden="true"
								/>
								Retry
							</>
						)}
					</Button>
				) : (
					<Button
						size="sm"
						variant="outline"
						onClick={onSelect}
						aria-label="Open proposal to review and retry"
					>
						<RefreshCwIcon
							className="mr-2 size-3.5"
							aria-hidden="true"
						/>
						Review &amp; retry
					</Button>
				)}
				<Button
					size="sm"
					variant="ghost"
					onClick={onDismiss}
					disabled={isDismissing}
					aria-label="Dismiss this failed proposal"
				>
					{isDismissing ? (
						<>
							<Loader2Icon
								className="mr-2 size-3.5 animate-spin"
								aria-hidden="true"
							/>
							Dismissing…
						</>
					) : (
						<>
							<XIcon
								className="mr-2 size-3.5"
								aria-hidden="true"
							/>
							Dismiss
						</>
					)}
				</Button>
			</div>
		</div>
	);
}
