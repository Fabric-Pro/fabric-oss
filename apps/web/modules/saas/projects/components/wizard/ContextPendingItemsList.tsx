"use client";

/**
 * ContextPendingItemsList — wizard pending-items list.
 *
 * Renders inline cards for items added during the wizard session,
 * mirroring `ProjectContextsList`'s post-creation row visual. Lives below
 * the "Add Context" CTA in `BasicInfoStep` (mounted in Group 9).
 *
 * Empty state: `null` — no list, no empty-card placeholder — until the
 * user adds the first item. Keeps Step 1 visually clean.
 *
 * Polling: 2s interval while any row is PENDING/EXTRACTING, capped at
 * 5min from `createdAt` per `MAX_POLL_DURATION_MS` reused from
 * `ProjectContextsList`. Cap protects against stuck rows (worker crash,
 * lost workflow) burning ~765 KB per response indefinitely.
 *
 * Row-card extraction trade-off (spec §16, planning note
 * `group-8-card-extraction.md`): the LINK row reuses the exported
 * `<UrlContextCard />` from `ProjectContextsList.tsx` verbatim — zero
 * duplication. FILE / TEXT / INTEGRATION rows are COPIED here as a
 * simplified inline card markup with the TODO below — the post-creation
 * source's "Other" branch is 250+ lines of inline JSX that references the
 * parent's `deleteMutation` + `renderDownloadMenuItem` + `handleDownloadRow`
 * closures; extracting that would explode the API surface (see planning
 * note for the audit).
 *
 * TODO(future-spec): extract `<ProjectContextCard />` from
 * `ProjectContextsList.tsx` once `renderDownloadMenuItem` and the delete /
 * retry handlers are abstracted into shared hooks. Tracked as a §17
 * follow-up in `2026-05-23-unified-context-uploader-wizard/spec.md`.
 *
 * Editorial aesthetic (CLAUDE.md): no glassmorphism, no gradient pills, no
 * hardcoded hex, no `backdrop-blur` on new chrome. Status pills use
 * semantic tokens (`text-success`, `text-destructive`, `text-highlight`)
 * mirroring the LINK `LinkStatusRow` pattern. Persistent animations gated
 * by `motion-safe:`.
 *
 * Accessibility:
 * each row is keyboard-reachable; delete/retry buttons carry `aria-label`s;
 * status pills carry `role="status"` + `aria-label` mirroring visible
 * text so screen-reader announcements match the visible copy.
 */

import { TruncatedText } from "@shared/components/TruncatedText";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	AlertCircleIcon,
	CheckCircleIcon,
	Loader2Icon,
	RefreshCwIcon,
	TrashIcon,
} from "lucide-react";
import { toast } from "sonner";
import { getContextIcon } from "../context-icon";
import {
	MAX_POLL_DURATION_MS,
	shouldStopPolling,
	UrlContextCard,
	type UrlContextRowFields,
} from "../ProjectContextsList";

type Props = {
	projectId: string;
	organizationId: string | null;
};

// ── Status pill config — mirrors `extractionStatusConfig` in
// `ProjectContextsList.tsx` for visual parity. Semantic-token colors only;
// no chip backgrounds (matches the inline-text rhythm used by the LINK
// card's `LinkStatusRow`). Each entry produces a screen-reader-friendly
// label so the `aria-label` matches the visible copy 1:1.
const STATUS_PILLS: Record<
	"PENDING" | "EXTRACTING" | "COMPLETED" | "FAILED",
	{
		Icon: typeof Loader2Icon;
		colorClass: string;
		label: string;
		spin: boolean;
	}
> = {
	PENDING: {
		Icon: Loader2Icon,
		colorClass: "text-muted-foreground",
		label: "Pending",
		spin: false,
	},
	EXTRACTING: {
		Icon: Loader2Icon,
		colorClass: "text-highlight",
		label: "Processing…",
		spin: true,
	},
	COMPLETED: {
		Icon: CheckCircleIcon,
		colorClass: "text-success",
		label: "Ready",
		spin: false,
	},
	FAILED: {
		Icon: AlertCircleIcon,
		colorClass: "text-destructive",
		label: "Failed",
		spin: false,
	},
};

const TYPE_LABEL: Record<string, string> = {
	FILE: "File",
	LINK: "Link",
	TEXT: "Text",
	IMAGE: "Image",
	SPREADSHEET: "Spreadsheet",
	DOCUMENT: "Document",
	INTEGRATION: "Integration",
	MEETING_TRANSCRIPT: "Transcript",
	SLACK_HUDDLE_NOTES: "Huddle Notes",
};

type RowFields = {
	id: string;
	type: string;
	sourceTitle?: string | null;
	sourceUrl?: string | null;
	originalFilename?: string | null;
	extractionStatus?: string | null;
	extractionError?: string | null;
	createdAt: Date | string;
	metadata?: unknown;
};

function getDisplayTitle(row: RowFields): string {
	const meta = (row.metadata ?? {}) as {
		title?: string;
		sourceTitle?: string;
		chatTopic?: string;
		channelName?: string;
	};
	return (
		meta.chatTopic ||
		meta.title ||
		meta.sourceTitle ||
		row.sourceTitle ||
		row.originalFilename ||
		row.sourceUrl ||
		TYPE_LABEL[row.type] ||
		row.type
	);
}

/**
 * Status pill — semantic-token colored text + small icon. Mirrors the
 * inline-text rhythm of the LINK card's `LinkStatusRow`. Carries an
 * `aria-label` mirroring the visible text so SR users hear the same status
 * the sighted user sees (per spec §7.8).
 */
function StatusPill({
	status,
	error,
}: {
	status: string | null | undefined;
	error: string | null | undefined;
}) {
	const key = (status ?? "PENDING") as keyof typeof STATUS_PILLS;
	const config = STATUS_PILLS[key] ?? STATUS_PILLS.PENDING;
	const { Icon, colorClass, label, spin } = config;
	// FAILED rows surface `extractionError` in the visible label + the
	// `aria-label` so SR users get the same context as the visible tooltip.
	const visibleLabel = key === "FAILED" && error ? `Failed: ${error}` : label;

	const pillContent = (
		<span
			className={cn("flex items-center gap-1 text-xs", colorClass)}
			role="status"
			aria-label={visibleLabel}
			data-testid={`status-pill-${key.toLowerCase()}`}
		>
			<Icon
				className={cn(
					"size-3.5 shrink-0",
					spin && "motion-safe:animate-spin",
				)}
				aria-hidden="true"
			/>
			<span className="truncate">
				{key === "FAILED" ? "Failed" : label}
			</span>
		</span>
	);

	// FAILED → tooltip carries the full `extractionError` so the user can
	// triage without leaving Step 1. Matches the post-creation surface's
	// pattern of attaching the error to the red-badged card.
	if (key === "FAILED" && error) {
		return (
			<Tooltip delayDuration={150}>
				<TooltipTrigger asChild>{pillContent}</TooltipTrigger>
				<TooltipContent side="top" className="max-w-xs">
					{error}
				</TooltipContent>
			</Tooltip>
		);
	}
	return pillContent;
}

/**
 * "Other" card — covers FILE / TEXT / IMAGE / SPREADSHEET / DOCUMENT /
 * INTEGRATION / MEETING_TRANSCRIPT rows. LINK rows are routed to the
 * shared `<UrlContextCard />` upstream so we don't reimplement that
 * cluster. Retry behavior per spec §7.5:
 *   - LINK row: handled by `<UrlContextCard />` (Sync now in the More menu).
 *     Not rendered here.
 *   - FILE row: re-upload (delete + add again). The retry button on a
 *     FAILED FILE row deletes the row; the user re-adds via the dialog.
 *     (Surfacing "delete to retry" inline matches the spec's "FILE row
 *     uses re-upload (delete + add again)" guidance.)
 *   - INTEGRATION row: respective re-sync procedure. Surfaced here as a
 *     toast hint pointing the user back to the dialog because the picker
 *     dialogs (Slack / Notion / Teams) own the re-add flow.
 */
function OtherContextCard({
	row,
	onDelete,
	onRetry,
	deletePending,
}: {
	row: RowFields;
	onDelete: () => void;
	onRetry?: () => void;
	deletePending: boolean;
}) {
	// Resolve the row icon from type + provider so INTEGRATION rows show their
	// brand logo (Teams/Slack/Notion/Google Docs/PM tool) instead of a generic
	// chat bubble — mirrors the Add Context dialog's per-source tab icons.
	const provider =
		typeof (row.metadata as Record<string, unknown> | null)?.provider ===
		"string"
			? ((row.metadata as Record<string, unknown>).provider as string)
			: null;
	const Icon = getContextIcon(row.type, provider);
	const label = TYPE_LABEL[row.type] ?? row.type;
	const title = getDisplayTitle(row);
	const createdAt =
		typeof row.createdAt === "string"
			? new Date(row.createdAt)
			: row.createdAt;
	const status = (row.extractionStatus ?? "PENDING") as
		| "PENDING"
		| "EXTRACTING"
		| "COMPLETED"
		| "FAILED";
	const showRetry = status === "FAILED" && onRetry !== undefined;

	return (
		<div
			className="group relative overflow-hidden rounded-xl border border-border bg-card motion-safe:transition-colors hover:border-primary/30"
			data-testid={`pending-row-${row.id}`}
			data-context-type={row.type}
		>
			<div className="flex items-start gap-3 p-4">
				<div
					className="shrink-0 rounded-md border border-border bg-muted p-2 text-primary"
					aria-hidden="true"
				>
					<Icon className="size-5" />
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
							{label}
						</Badge>
					</div>

					<div
						className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-foreground/50 text-xs"
						data-testid="pending-row-status"
					>
						<StatusPill
							status={row.extractionStatus}
							error={row.extractionError}
						/>
						{createdAt && (
							<span>
								Added{" "}
								{formatDistanceToNow(createdAt, {
									addSuffix: true,
								})}
							</span>
						)}
					</div>
				</div>

				<div className="flex shrink-0 items-center gap-1">
					{showRetry && onRetry && (
						<Tooltip delayDuration={150}>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="size-8"
									aria-label={`Retry ${title}`}
									onClick={onRetry}
									data-testid={`pending-row-retry-${row.id}`}
								>
									<RefreshCwIcon
										className="size-3.5"
										aria-hidden="true"
									/>
								</Button>
							</TooltipTrigger>
							<TooltipContent side="top">Retry</TooltipContent>
						</Tooltip>
					)}
					<Tooltip delayDuration={150}>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="size-8 text-destructive hover:text-destructive"
								aria-label={`Delete ${title}`}
								onClick={onDelete}
								disabled={deletePending}
								data-testid={`pending-row-delete-${row.id}`}
							>
								<TrashIcon
									className="size-3.5"
									aria-hidden="true"
								/>
							</Button>
						</TooltipTrigger>
						<TooltipContent side="top">Delete</TooltipContent>
					</Tooltip>
				</div>
			</div>
		</div>
	);
}

export function ContextPendingItemsList({ projectId, organizationId }: Props) {
	const queryClient = useQueryClient();

	// Same 2s poll + 5min cap as `ProjectContextsList`.
	// Reuses `MAX_POLL_DURATION_MS` + `shouldStopPolling` exported from
	// `ProjectContextsList.tsx` so the cap stays single-source-of-truth.
	const { data } = useQuery(
		orpc.projects.contexts.list.queryOptions({
			input: { projectId, organizationId },
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

	const deleteMutation = useMutation({
		mutationFn: (contextId: string) =>
			orpcClient.projects.contexts.delete({
				id: contextId,
				projectId,
				organizationId,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: orpc.projects.contexts.list.queryKey({
					input: { projectId, organizationId },
				}),
			});
		},
		onError: (error: unknown) => {
			const message =
				error instanceof Error ? error.message : "Delete failed";
			toast.error(message);
		},
	});

	const contexts = (data?.contexts ?? []) as Array<RowFields>;

	// Empty state: render `null` — no list, no empty-card placeholder — until
	// the user adds the first item. Spec §7.5: keeps Step 1 visually clean.
	if (contexts.length === 0) {
		return null;
	}

	return (
		<ul
			// `grid-cols-[minmax(0,1fr)]` caps the column at the list width so a
			// card with a long unbroken title (e.g. a raw URL) can't grow the
			// column past the container and push content off-screen.
			className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-3"
			aria-label="Added context items"
			data-testid="pending-items-list"
		>
			{contexts.map((row) => (
				<li key={row.id}>
					{row.type === "LINK" ? (
						<UrlContextCard
							context={row as unknown as UrlContextRowFields}
							projectId={projectId}
							onDelete={(id) => deleteMutation.mutate(id)}
							deletePending={deleteMutation.isPending}
							deleteCopy={{
								label: "Delete URL source",
								warning:
									"This will stop the crawl and remove all indexed pages.",
							}}
						/>
					) : (
						<OtherContextCard
							row={row}
							onDelete={() => deleteMutation.mutate(row.id)}
							deletePending={deleteMutation.isPending}
							// FAILED FILE rows: spec §7.5 says "FILE row uses
							// re-upload (delete + add again)" — the retry
							// button deletes the row; the user re-adds via
							// the dialog. FAILED INTEGRATION rows route through
							// the picker dialogs' own re-add flow on delete.
							// For both, we surface the retry control as a
							// shortcut to the delete action with a toast hint
							// so the user knows to re-pick from the dialog.
							onRetry={
								row.extractionStatus === "FAILED"
									? () => {
											deleteMutation.mutate(row.id);
											toast.info(
												"Removed — re-add it via the Add Context dialog.",
											);
										}
									: undefined
							}
						/>
					)}
				</li>
			))}
		</ul>
	);
}

// Re-export the polling cap from the source module so test suites can
// assert against a single constant without importing from
// `ProjectContextsList` themselves.
export { MAX_POLL_DURATION_MS };
