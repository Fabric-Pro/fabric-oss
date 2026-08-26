"use client";

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
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SlackIcon } from "../../../workflows/lib/plugins/slack/icon";
import { BacklogChangeProposal } from "./BacklogChangeProposal";
import { failureClassToCopy } from "./lib/failure-class-copy";

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
	pmConfig?: {
		mcpConfigId: string;
		containerId: string;
		additionalContext?: Record<string, string>;
	};
};

type ProposalStatus =
	| "PENDING"
	| "APPROVED"
	| "APPLIED"
	| "REJECTED"
	| "FAILED"
	| "SUPERSEDED"
	| "BACKLOG";

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
};

type PendingProposalDetail = PendingProposalRow & {
	projectId: string;
	proposal: unknown;
	userId: string | null;
	organizationId: string | null;
};

type ProposalJson = {
	summary?: string;
	contextSummary?: string;
	changes?: Record<string, unknown>[];
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

/**
 * Pick the right monitor's pendingProposals namespace for approve/reject
 * based on the proposal's `source` value (the enum from `schema.prisma`:
 * `SLACK_CHANNEL`, `TEAMS_CHANNEL`, `TEAMS_CHAT`).
 *
 * Background: prior to the chat-thread-image-attachments feature the inbox
 * called teamsChannelMonitor.approve for every source; this worked because
 * `createStoryFromProposal` is source-agnostic and the approve procedure
 * did not yet touch any per-source resources. Once the orchestrator was
 * wired (FR-18) the per-monitor approve procedures each pull credentials
 * for their own integration (Slack bot token vs Microsoft Graph token) and
 * each filter `sourceMetadata.attachments` to refs matching THEIR source.
 * Dispatching to the wrong endpoint silently drops the attachments —
 * verified live during PR validation.
 */
function endpointForSource(source: string) {
	switch (source) {
		case "SLACK_CHANNEL":
			return orpcClient.projects.slackChannelMonitor.pendingProposals;
		case "TEAMS_CHAT":
			return orpcClient.projects.teamsChatMonitor.pendingProposals;
		default:
			// Default keeps the previous behavior for unknown future sources —
			// the Teams channel monitor's list/get/count endpoints are
			// source-agnostic, so falling through here at least surfaces the
			// proposal rather than throwing.
			return orpcClient.projects.teamsChannelMonitor.pendingProposals;
	}
}

const PROPOSAL_CONFLICT_MESSAGE =
	"This proposal has already been approved or rejected perhaps by another user.";

/**
 * Detect the "already actioned by another reviewer" conflict thrown by the
 * approve/reject procedures (oRPC `CONFLICT`). Falls back to a message match so
 * it still works if the client surfaces the error without a `code`.
 */
function isAlreadyResolvedConflict(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	if ((error as { code?: unknown }).code === "CONFLICT") {
		return true;
	}
	const message = (error as { message?: unknown }).message;
	return (
		typeof message === "string" &&
		message.includes("already been approved or rejected")
	);
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

/** The full transcript text the auto-analyze activity stores for in-app viewing. */
function meetingTranscriptFromMetadata(
	metadata: Record<string, unknown> | null,
): string | null {
	const v = metadata?.transcript;
	return typeof v === "string" && v.trim().length > 0 ? v : null;
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
		default:
			return "bg-muted text-muted-foreground border-foreground/10";
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
 * Build a deep-link to the original message/thread for the proposal.
 *
 * - TEAMS_CHANNEL / TEAMS_CHAT: source metadata already holds a full
 *   `threadRootWebLink` (or `channelWebUrl` fallback).
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

	if (source === "AI_UPDATE_SIDEBAR") {
		// The AI Update flow has no channel — the badge is a compact
		// product-label so the user can tell sidebar-originated rows
		// apart from channel-monitor rows in the inbox at a glance.
		return (
			<span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
				<SparklesIcon className="size-3 text-muted-foreground" />
				AI Update
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
		return (
			<span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
				<HashIcon className="size-3" />
				{channelName
					? `Posted in ${channelName}`
					: "Posted in Teams chat"}
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
}: Props) {
	const queryClient = useQueryClient();
	const t = useTranslations("projects.decisionPrecheck");
	const [selectedProposalId, setSelectedProposalId] = useState<string | null>(
		null,
	);
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

	const listQueryKey = [
		"teams-channel-monitor-pending-proposals",
		projectId,
		organizationId,
	];
	// Rejected rows are fetched separately (stored as status ["BACKLOG"]) so the
	// active list stays lean; this backs the dedicated "Rejected proposals" list
	// and is keyed distinctly by the trailing "backlog" segment.
	const backlogQueryKey = [
		"teams-channel-monitor-pending-proposals",
		projectId,
		organizationId,
		"backlog",
	];

	const listQuery = useQuery({
		queryKey: listQueryKey,
		queryFn: async () => {
			const result =
				await orpcClient.projects.teamsChannelMonitor.pendingProposals.list(
					{
						projectId,
						organizationId,
						status: ["PENDING", "FAILED"],
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
	});

	const invalidateAll = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: listQueryKey });
		queryClient.invalidateQueries({
			queryKey: [
				"teams-channel-monitor-pending-proposals-count",
				projectId,
				organizationId,
			],
		});
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
		// Keep the Rejected list and Roadmap archive-button count fresh so moving a
		// proposal into or out of Rejected reflects immediately.
		queryClient.invalidateQueries({ queryKey: backlogQueryKey });
		queryClient.invalidateQueries({
			queryKey: [
				"projects.backlog.proposals.backlogCount",
				projectId,
				organizationId,
			],
		});
		// Approving a proposal can create or update UserStory rows that the
		// Roadmap reads from `projects.stories.list`. Invalidate it so the
		// new/updated features appear without a manual page refresh.
		queryClient.invalidateQueries({
			queryKey: orpc.projects.stories.list.queryKey({
				input: { projectId, organizationId },
			}),
		});
	}, [queryClient, listQueryKey, backlogQueryKey, projectId, organizationId]);

	const approveMutation = useMutation({
		mutationFn: async (payload: {
			proposalId: string;
			source: string;
			approvedChanges: unknown[];
			syncToPM: boolean;
		}) => {
			return await endpointForSource(payload.source).approve({
				projectId,
				organizationId,
				proposalId: payload.proposalId,
				// The approve procedure will handle its own Zod validation
				// on the change shape; we pass whatever BacklogChangeProposal
				// produced after normalization.
				approvedChanges: payload.approvedChanges as never,
				// Explicit user choice from the proposal-review checkbox. Pass
				// the boolean verbatim (never undefined): the approve procedure
				// treats `undefined` as "sync if a PM tool is configured", so an
				// explicit `false` is required to honor an unchecked box.
				syncToPM: payload.syncToPM,
				// Lets the checkbox govern UPDATE-change sync too (CREATE
				// resolves the config server-side). Undefined when no PM tool.
				pmConfig,
			});
		},
		onSuccess: (result) => {
			if (result?.status === "failed") {
				toast.error("Proposal approval failed", {
					description:
						result.errors?.join("\n") ??
						"Some changes could not be applied.",
				});
			} else if (result?.skipped && result.skipped.length > 0) {
				// Some CREATEs collided with existing roadmap items by
				// title and were not duplicated. Surface so the PM knows
				// the approval did not produce every row they expected.
				const skippedList = result.skipped
					.map((s) => `${s.existingIdentifier} (${s.title})`)
					.join(", ");
				const anyCreated = (result.createdStoryIds?.length ?? 0) > 0;
				toast.success(
					anyCreated
						? "Proposal approved — some items already on the roadmap"
						: "Proposal approved — all items were already on the roadmap",
					{
						description: `${result.skipped.length} already existed: ${skippedList}`,
					},
				);
			} else {
				toast.success("Proposal approved");
			}
			invalidateAll();
			// Return to list view
			setSelectedProposalId(null);
		},
		onError: (error) => {
			if (isAlreadyResolvedConflict(error)) {
				// A second reviewer raced us — refresh the now-stale row and
				// tell the PM why nothing changed (DEC-09 / FR-13).
				toast.error(PROPOSAL_CONFLICT_MESSAGE);
				invalidateAll();
				setSelectedProposalId(null);
				return;
			}
			toast.error("Failed to approve proposal", {
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
			if (isAlreadyResolvedConflict(error)) {
				// A second reviewer raced us — refresh the now-stale row and
				// tell the PM why nothing changed (DEC-09 / FR-13).
				toast.error(PROPOSAL_CONFLICT_MESSAGE);
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
		mutationFn: async (payload: { proposalId: string; source: string }) => {
			return await endpointForSource(payload.source).backlog({
				projectId,
				organizationId,
				proposalId: payload.proposalId,
			});
		},
		onSuccess: () => {
			toast.success("Moved to Rejected", {
				description:
					"Find it anytime in Rejected proposals on your roadmap.",
			});
			invalidateAll();
			setSelectedProposalId(null);
		},
		onError: (error) => {
			if (isAlreadyResolvedConflict(error)) {
				// A second reviewer already actioned it — refresh the now-stale
				// row and explain why nothing changed.
				toast.error(PROPOSAL_CONFLICT_MESSAGE);
				invalidateAll();
				setSelectedProposalId(null);
				return;
			}
			toast.error("Failed to move proposal to Rejected", {
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
			invalidateAll();
		},
		onError: (error) => {
			toast.error("Failed to retry proposal", {
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
	const pendingRows = proposals.filter((p) => p.status === "PENDING");
	const failedRows = proposals.filter((p) => p.status === "FAILED");
	// Rejected rows (stored as BACKLOG) come from their own query and are never
	// mixed into the active `proposals` list, so the Pending/Failed groups and
	// every active count exclude rejected proposals.
	const backlogRows = backlogQuery.data ?? [];

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
	const headerHasChannel = headerSources.some(
		(s) => s !== "AI_UPDATE_SIDEBAR",
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
		: headerHasAiUpdate && !headerHasChannel
			? {
					eyebrow: "From AI Update",
					title: "Pending AI Update changes",
					description:
						"Review and apply the backlog changes proposed by your AI Update run.",
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
							"Review and approve proposals surfaced from your monitored meeting transcripts, Teams, and Slack channels.",
					};
	const HeaderIcon = isBacklogView
		? ArchiveIcon
		: headerHasAiUpdate && !headerHasChannel
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
			if (backlogRows.length === 0) {
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
							<h3 className="font-serif text-2xl font-normal leading-tight text-foreground">
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
				<div className="space-y-2">
					{backlogRows.map((proposal) => (
						<ProposalRow
							key={proposal.id}
							proposal={proposal}
							onSelect={() => setSelectedProposalId(proposal.id)}
						/>
					))}
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
						<h3 className="font-serif text-2xl font-normal leading-tight text-foreground">
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

		return (
			<div className="space-y-6">
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
		const metadata =
			(detail.sourceMetadata as Record<string, unknown> | null) ?? null;
		const channelName = channelNameFromMetadata(metadata);
		const threadLink = threadLinkFromMetadata(detail.source, metadata);
		const isFailed = detail.status === "FAILED";
		const provider = providerLabel(detail.source);
		const meetingSubject = meetingSubjectFromMetadata(metadata);
		const meetingDate = formatMeetingBadgeDate(metadata?.meetingDate);
		const meetingTranscript = meetingTranscriptFromMetadata(metadata);
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

				{(channelName || threadLink) && (
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
									: "Based on a thread in"}
							</span>
							{channelName && (
								<span className="font-medium text-foreground">
									#{channelName}
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
												className="inline-flex items-center gap-1 text-primary hover:underline"
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
					</div>
				)}

				{detail.source === "MONITORED_MEETING" && (
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
						{meetingTranscript && (
							<details className="mt-2">
								<summary className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-primary hover:underline">
									<FileTextIcon
										className="size-3"
										aria-hidden="true"
									/>
									See original transcript
								</summary>
								<pre className="mt-2 max-h-64 overflow-auto overscroll-contain whitespace-pre-wrap rounded-md border border-foreground/10 bg-background p-2 text-xs text-foreground/80">
									{meetingTranscript}
								</pre>
							</details>
						)}
					</div>
				)}

				{isFailed && (
					<div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs space-y-2">
						<div className="flex items-start gap-2 text-destructive">
							<AlertTriangleIcon
								className="size-4 shrink-0 mt-0.5"
								aria-hidden="true"
							/>
							<p className="text-sm font-medium">
								{failureClassToCopy(detail.errorClass)}
							</p>
						</div>
						{(detail.errorMessage || detail.applyError) && (
							<details className="text-xs">
								<summary className="cursor-pointer text-destructive/80 hover:text-destructive">
									Show details
								</summary>
								<pre className="mt-2 whitespace-pre-wrap text-destructive/80">
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
					applyProgressMsg={
						approveMutation.isPending
							? "Submitting proposal..."
							: undefined
					}
					onApprove={(approvedChanges, syncToPM) => {
						approveMutation.mutate({
							proposalId: detail.id,
							source: detail.source,
							approvedChanges,
							syncToPM,
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

				<p className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
					Open a proposal to draft its description and acceptance
					criteria through your project's prompt — and to switch it
					between Bug and Feature. Proposals you approve without
					opening are drafted on approve.
				</p>
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
						<SheetTitle className="font-serif text-2xl font-normal leading-tight">
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
									: proposal.status}
					</span>
					<span className="text-xs text-muted-foreground">
						{createdLabel}
					</span>
				</div>
				<p className="line-clamp-2 text-sm text-foreground/80">
					{stripMarkdown(proposal.summary)}
				</p>
				<div className="text-xs text-muted-foreground">
					{proposal.changeCount} change
					{proposal.changeCount !== 1 ? "s" : ""}
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
	const failureCopy = failureClassToCopy(proposal.errorClass);
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
					{proposal.changeCount} change
					{proposal.changeCount !== 1 ? "s" : ""}
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
					<summary className="cursor-pointer text-destructive/80 hover:text-destructive">
						Show details
					</summary>
					<pre className="mt-2 whitespace-pre-wrap text-destructive/80">
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
