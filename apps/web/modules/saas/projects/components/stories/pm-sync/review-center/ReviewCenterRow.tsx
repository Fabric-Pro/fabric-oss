"use client";

import { pmDetectedTypeDisplayName } from "@repo/utils";
import { orpcClient } from "@shared/lib/orpc-client";
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
import { Checkbox } from "@ui/components/checkbox";
import {
	DestructiveTooltip,
	type DestructiveTooltipCopy,
} from "@ui/components/destructive-tooltip";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	CheckIcon,
	Link2OffIcon,
	Loader2Icon,
	RotateCcwIcon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { ConflictResolveDialog } from "../../ConflictResolveDialog";
import { PmToolBrandIcon } from "../pm-tool-brand-icon";
import { ViewInPmToolLink } from "../ViewInPmToolLink";

export type ReviewCenterItem = {
	id: string;
	type: "conflict" | "failure" | "pull-drift";
	entityType: "EPIC" | "FEATURE" | "STORY";
	entityId: string;
	identifier: string;
	title: string;
	pmTool: string | null;
	/**
	 * Entity's stored PM-tool card URL, for the "View in {tool}" link. Null when
	 * the entity is unlinked (or the link was cleared after a FLAG_MISSING unlink).
	 */
	externalUrl: string | null;
	summary: string;
	/**
	 * Fabric-side description, supplied by `get-review-center-items` so the
	 * conflict Resolve dialog can render the diff without a second round-trip.
	 * Empty string when the entity has no description.
	 */
	fabricDescription: string;
	/**
	 * Fabric-side last-updated timestamp (ISO 8601), supplied by
	 * `get-review-center-items` so the Resolve dialog can show "Updated {when}"
	 * on the Fabric column. Null when unavailable. Author is intentionally
	 * absent — Fabric entities track no `updatedBy` (separate follow-up).
	 */
	fabricUpdatedAt: string | null;
	/**
	 * Fabric-side last-editor display name + edit provenance (UserStory only),
	 * from `get-review-center-items`, so the Resolve dialog can show author and
	 * a source label. Null for system/AI edits (author), pre-feature rows, and
	 * non-UserStory entities.
	 */
	fabricAuthor: string | null;
	fabricSource:
		| "MANUAL"
		| "AI_BACKLOG_UPDATE"
		| "AI_MATURATION"
		| "CONFLICT_RESOLUTION"
		| "PM_PULL"
		| null;
	/**
	 * Pull-drift discriminator. Only meaningful when `type === "pull-drift"`:
	 * `CONTENT_DRIFT` rows open the unified Resolve dialog (in pull-drift mode);
	 * `HIDE`/`UNHIDE`/`FLAG_MISSING` rows keep the Accept / Reject actions. Null
	 * on conflict/failure rows.
	 */
	proposedAction: "HIDE" | "UNHIDE" | "FLAG_MISSING" | "CONTENT_DRIFT" | null;
	/**
	 * PM work-item type derived from the underlying story's `kind`
	 * (`BUG → "bug"`, else `"story"`), supplied by `get-review-center-items`.
	 * Threaded into `retryPmSync` so a BUG retries as the correct PM work-item
	 * type instead of defaulting to `"story"` and re-failing.
	 */
	itemType: "story" | "bug";
};

/** Maps the row's `entityType` to the dialog's `itemType`. Bugs surface as
 * STORY rows (Chunk A logs bugs as STORY) and resolve via the same UserStory
 * path, so STORY → "story" covers both. */
const ENTITY_TYPE_TO_ITEM_TYPE = {
	EPIC: "epic",
	FEATURE: "feature",
	STORY: "story",
} as const satisfies Record<
	ReviewCenterItem["entityType"],
	"epic" | "feature" | "story"
>;

type Props = {
	item: ReviewCenterItem;
	projectId: string;
	organizationId: string | null;
	/** Invalidates both `reviewCenter.items` and `reviewCenter.count`. */
	onActioned: () => void;
};

type RowProps = Props & {
	/**
	 * Bulk-selection wiring. Only Failures rows are bulk-selectable,
	 * so the panel passes these props on the Failures tab only; Conflicts and
	 * Sync Drift rows never receive them and so never render a checkbox.
	 */
	selectable?: boolean;
	selected?: boolean;
	onToggleSelect?: (id: string, next: boolean) => void;
};

/**
 * A single Review Center row. The action button is chosen by `item.type` and
 * wires to the EXISTING surface for that type — nothing is rebuilt:
 *
 * - `conflict`   → `ConflictResolveDialog` (Resolve)
 * - `failure`    → `projects.stories.retryPmSync` (Retry)
 * - `pull-drift` → `projects.pmStateChanges.review` (Accept / Reject)
 *
 * On success of any action the row invalidates the badge count + the grouped
 * list via `onActioned`.
 */
export function ReviewCenterRow({
	item,
	projectId,
	organizationId,
	onActioned,
	selectable = false,
	selected = false,
	onToggleSelect,
}: RowProps) {
	const t = useTranslations("tooltips.stories");
	const pmToolLabel = item.pmTool
		? (pmDetectedTypeDisplayName(item.pmTool) ?? item.pmTool)
		: null;

	return (
		<li className="rounded-lg border border-border bg-card p-3 space-y-2">
			<div className="flex items-start justify-between gap-3">
				{selectable && onToggleSelect && (
					<Checkbox
						checked={selected}
						onCheckedChange={(next) =>
							onToggleSelect(item.id, next === true)
						}
						aria-label={t("reviewSelectRow", {
							identifier: item.identifier,
						})}
						className="mt-0.5 shrink-0"
					/>
				)}
				<div className="min-w-0 space-y-0.5">
					<p className="text-sm font-medium text-foreground truncate">
						<span className="font-mono">{item.identifier}</span>
						{" — "}
						{item.title}
					</p>
					<p className="text-xs text-muted-foreground line-clamp-2">
						{item.summary}
					</p>
				</div>
				{pmToolLabel && (
					<span className="flex shrink-0 items-center gap-1 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
						<PmToolBrandIcon
							pmToolType={item.pmTool}
							className="size-3.5"
						/>
						{pmToolLabel}
					</span>
				)}
			</div>

			<div className="flex items-center justify-end gap-2 pt-1">
				<ViewInPmToolLink
					externalUrl={item.externalUrl}
					pmTool={item.pmTool}
					className="mr-auto"
				/>
				<ReviewCenterRowAction
					item={item}
					projectId={projectId}
					organizationId={organizationId}
					onActioned={onActioned}
				/>
			</div>
		</li>
	);
}

function ReviewCenterRowAction({
	item,
	projectId,
	organizationId,
	onActioned,
}: Props) {
	if (item.type === "conflict") {
		return (
			<ConflictRowAction
				item={item}
				projectId={projectId}
				organizationId={organizationId}
				onActioned={onActioned}
			/>
		);
	}
	if (item.type === "failure") {
		return (
			<FailureRowAction
				item={item}
				projectId={projectId}
				organizationId={organizationId}
				onActioned={onActioned}
			/>
		);
	}
	return (
		<PullDriftRowAction
			item={item}
			projectId={projectId}
			organizationId={organizationId}
			onActioned={onActioned}
		/>
	);
}

function ConflictRowAction({
	item,
	projectId,
	organizationId,
	onActioned,
}: Props) {
	const t = useTranslations("tooltips.stories");
	const [open, setOpen] = useState(false);
	const [dismissing, setDismissing] = useState(false);

	// Dismiss is the always-available terminal state for a conflict whose PM card
	// the Resolve dialog can't load (e.g. the card was deleted → the dialog 404s
	// and hides its resolve actions). It clears the CONFLICT flag directly,
	// independent of the PM tool, so the item always has a one-click way out.
	const handleDismiss = async () => {
		setDismissing(true);
		try {
			await orpcClient.projects.stories.dismissPmSyncConflict({
				projectId,
				storyId: item.entityId,
				itemType: item.itemType,
				organizationId: organizationId ?? null,
			});
			toast.success("Conflict dismissed");
			onActioned();
		} catch (error) {
			toast.error("Failed to dismiss conflict", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		} finally {
			setDismissing(false);
		}
	};

	return (
		<>
			<Button
				variant="outline"
				size="sm"
				className="h-7 text-xs"
				onClick={() => setOpen(true)}
				disabled={dismissing}
				aria-label={`Resolve sync conflict for ${item.identifier}`}
			>
				Resolve
			</Button>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className="h-7 text-xs"
						onClick={handleDismiss}
						disabled={dismissing}
						aria-label={`Dismiss sync conflict for ${item.identifier}`}
					>
						{dismissing ? (
							<Loader2Icon
								className="size-3 mr-1 animate-spin"
								aria-hidden
							/>
						) : (
							<XIcon className="size-3 mr-1" aria-hidden />
						)}
						Dismiss
					</Button>
				</TooltipTrigger>
				<TooltipContent>{t("reviewConflictDismiss")}</TooltipContent>
			</Tooltip>
			<ConflictResolveDialog
				open={open}
				onOpenChange={setOpen}
				projectId={projectId}
				organizationId={organizationId}
				itemType={ENTITY_TYPE_TO_ITEM_TYPE[item.entityType]}
				entityId={item.entityId}
				identifier={item.identifier}
				fabricTitle={item.title}
				fabricDescription={item.fabricDescription}
				fabricUpdatedAt={item.fabricUpdatedAt}
				fabricAuthor={item.fabricAuthor}
				fabricSource={item.fabricSource}
				onResolved={onActioned}
			/>
		</>
	);
}

function FailureRowAction({
	item,
	projectId,
	organizationId,
	onActioned,
}: Props) {
	const t = useTranslations("tooltips.stories");
	const [retrying, setRetrying] = useState(false);
	const [dismissing, setDismissing] = useState(false);
	const busy = retrying || dismissing;

	// D6: with no resolvable PM tool there is nothing to retry against, so the
	// Retry control is disabled (rather than offering a no-op). The only in-scope
	// FE signal is a null `pmTool`; stale-tool rows keep a resolvable tool and
	// stay enabled, retrying against the currently-configured tool. Dismiss needs
	// no PM tool (it only clears the local failure flag), so it stays enabled.
	const hasResolvableTool = item.pmTool != null;

	const handleRetry = async () => {
		setRetrying(true);
		try {
			await orpcClient.projects.stories.retryPmSync({
				projectId,
				storyId: item.entityId,
				itemType: item.itemType,
				pushAnyway: false,
				organizationId: organizationId ?? null,
			});
			toast.success("Sync queued");
			onActioned();
		} catch (error) {
			toast.error("Failed to queue sync", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		} finally {
			setRetrying(false);
		}
	};

	const handleDismiss = async () => {
		setDismissing(true);
		try {
			await orpcClient.projects.stories.dismissPmSyncFailure({
				projectId,
				storyId: item.entityId,
				itemType: item.itemType,
				organizationId: organizationId ?? null,
			});
			toast.success("Failure dismissed");
			onActioned();
		} catch (error) {
			toast.error("Failed to dismiss failure", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		} finally {
			setDismissing(false);
		}
	};

	const retryButton = (
		<Button
			variant="outline"
			size="sm"
			className="h-7 text-xs"
			onClick={handleRetry}
			disabled={busy || !hasResolvableTool}
			aria-label={`Retry sync for ${item.identifier}`}
		>
			{retrying ? (
				<Loader2Icon className="size-3 mr-1 animate-spin" aria-hidden />
			) : (
				<RotateCcwIcon className="size-3 mr-1" aria-hidden />
			)}
			Retry
		</Button>
	);

	// A disabled <button> suppresses pointer/focus events, so a Radix tooltip on
	// it never opens. Wrap the trigger in a span so the disabled-state copy stays
	// reachable on hover (frontend/tooltips.md disabled-state guidance); the
	// `aria-label` remains the screen-reader fallback for the control itself.
	const retryControl = hasResolvableTool ? (
		retryButton
	) : (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="inline-flex">{retryButton}</span>
			</TooltipTrigger>
			<TooltipContent>{t("reviewRetryDisabledNoTool")}</TooltipContent>
		</Tooltip>
	);

	// Dismiss is the always-available terminal state for a stuck failure (a
	// deleted PM card, a persistent error) that Retry can't resolve — it clears
	// the failure from the queue without touching the PM tool. (For a deleted
	// card whose link should be severed for good, the FLAG_MISSING recovery row
	// offers Unlink instead.)
	return (
		<>
			{retryControl}
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className="h-7 text-xs"
						onClick={handleDismiss}
						disabled={busy}
						aria-label={`Dismiss failed sync for ${item.identifier}`}
					>
						{dismissing ? (
							<Loader2Icon
								className="size-3 mr-1 animate-spin"
								aria-hidden
							/>
						) : (
							<XIcon className="size-3 mr-1" aria-hidden />
						)}
						Dismiss
					</Button>
				</TooltipTrigger>
				<TooltipContent>{t("reviewFailureDismiss")}</TooltipContent>
			</Tooltip>
		</>
	);
}

function PullDriftRowAction({
	item,
	projectId,
	organizationId,
	onActioned,
}: Props) {
	// Content drift is reconciled through the unified Resolve dialog (Apply
	// ADO→Fabric / Keep Fabric / AI merge / Dismiss), not the binary
	// Accept/Reject used by HIDE/UNHIDE/FLAG_MISSING state transitions.
	if (item.proposedAction === "CONTENT_DRIFT") {
		return (
			<ContentDriftRowAction
				item={item}
				projectId={projectId}
				organizationId={organizationId}
				onActioned={onActioned}
			/>
		);
	}

	// FLAG_MISSING (the upstream card was deleted) gets explicit recovery verbs
	// — Unlink / Re-push / Dismiss — instead of the binary Accept/Reject used by
	// HIDE/UNHIDE.
	if (item.proposedAction === "FLAG_MISSING") {
		return (
			<FlagMissingRowAction
				item={item}
				projectId={projectId}
				organizationId={organizationId}
				onActioned={onActioned}
			/>
		);
	}

	return (
		<StateTransitionRowAction
			item={item}
			projectId={projectId}
			organizationId={organizationId}
			onActioned={onActioned}
		/>
	);
}

function ContentDriftRowAction({
	item,
	projectId,
	organizationId,
	onActioned,
}: Props) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button
				variant="outline"
				size="sm"
				className="h-7 text-xs"
				onClick={() => setOpen(true)}
				aria-label={`Resolve content drift for ${item.identifier}`}
			>
				Resolve
			</Button>
			<ConflictResolveDialog
				open={open}
				onOpenChange={setOpen}
				mode="pull-drift"
				pendingChangeId={item.id}
				projectId={projectId}
				organizationId={organizationId}
				itemType={ENTITY_TYPE_TO_ITEM_TYPE[item.entityType]}
				entityId={item.entityId}
				identifier={item.identifier}
				fabricTitle={item.title}
				fabricDescription={item.fabricDescription}
				fabricUpdatedAt={item.fabricUpdatedAt}
				fabricAuthor={item.fabricAuthor}
				fabricSource={item.fabricSource}
				onResolved={onActioned}
			/>
		</>
	);
}

function StateTransitionRowAction({
	item,
	projectId,
	organizationId,
	onActioned,
}: Props) {
	const [busy, setBusy] = useState<"APPROVED" | "DISMISSED" | null>(null);

	const isHide = item.proposedAction === "HIDE";
	const isUnhide = item.proposedAction === "UNHIDE";
	const acceptLabel = isHide ? "Hide" : isUnhide ? "Unhide" : "Accept";
	const rejectLabel = isHide
		? "Keep visible"
		: isUnhide
			? "Keep hidden"
			: "Reject";
	const acceptTooltip = isHide
		? "Hide this story — its ticket reached a terminal status"
		: isUnhide
			? "Unhide this story — its ticket was reopened"
			: "Apply the PM tool's change";
	const rejectTooltip = isHide
		? "Keep this story visible on the board"
		: isUnhide
			? "Keep this story hidden"
			: "Dismiss the PM tool's change";
	const acceptAria = isHide
		? `Hide ${item.identifier}`
		: isUnhide
			? `Unhide ${item.identifier}`
			: `Accept state change for ${item.identifier}`;
	const rejectAria = isHide
		? `Keep ${item.identifier} visible`
		: isUnhide
			? `Keep ${item.identifier} hidden`
			: `Reject state change for ${item.identifier}`;

	const review = async (decision: "APPROVED" | "DISMISSED") => {
		setBusy(decision);
		try {
			await orpcClient.projects.pmStateChanges.review({
				projectId,
				id: item.id,
				decision,
				organizationId: organizationId ?? null,
			});
			toast.success(
				decision === "APPROVED"
					? "State change accepted"
					: "State change rejected",
			);
			onActioned();
		} catch (error) {
			toast.error("Failed to review state change", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		} finally {
			setBusy(null);
		}
	};

	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						className="h-7 text-xs"
						onClick={() => review("APPROVED")}
						disabled={busy !== null}
						aria-label={acceptAria}
					>
						{busy === "APPROVED" ? (
							<Loader2Icon
								className="size-3 mr-1 animate-spin"
								aria-hidden
							/>
						) : (
							<CheckIcon className="size-3 mr-1" aria-hidden />
						)}
						{acceptLabel}
					</Button>
				</TooltipTrigger>
				<TooltipContent>{acceptTooltip}</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className="h-7 text-xs"
						onClick={() => review("DISMISSED")}
						disabled={busy !== null}
						aria-label={rejectAria}
					>
						{busy === "DISMISSED" ? (
							<Loader2Icon
								className="size-3 mr-1 animate-spin"
								aria-hidden
							/>
						) : (
							<XIcon className="size-3 mr-1" aria-hidden />
						)}
						{rejectLabel}
					</Button>
				</TooltipTrigger>
				<TooltipContent>{rejectTooltip}</TooltipContent>
			</Tooltip>
		</>
	);
}

/**
 * FLAG_MISSING recovery triad — the upstream PM card was deleted, so the row
 * offers three explicit verbs:
 *
 * - **Unlink** (destructive) — the existing FLAG_MISSING `APPROVED` review path,
 *   which runs `applyPmUnlink`: the sync link is cleared, the Fabric item kept.
 * - **Re-push** (informational — the old link is already dead, so there is no
 *   data loss) — confirm AlertDialog → `retryPmSync({ unlinkFirst: true })`,
 *   which severs the dead link and CREATEs a fresh card.
 * - **Dismiss** (destructive) — `review({ decision: "DISMISSED" })`; no confirm
 *   dialog (low-stakes, durable, the proposal row is retained).
 */
function FlagMissingRowAction({
	item,
	projectId,
	organizationId,
	onActioned,
}: Props) {
	const t = useTranslations("tooltips.stories");
	const [busy, setBusy] = useState<
		"APPROVED" | "DISMISSED" | "REPUSH" | null
	>(null);
	const [confirmRepush, setConfirmRepush] = useState(false);

	const pmToolLabel = item.pmTool
		? (pmDetectedTypeDisplayName(item.pmTool) ?? item.pmTool)
		: "your PM tool";

	const review = async (decision: "APPROVED" | "DISMISSED") => {
		setBusy(decision);
		try {
			await orpcClient.projects.pmStateChanges.review({
				projectId,
				id: item.id,
				decision,
				organizationId: organizationId ?? null,
			});
			toast.success(
				decision === "APPROVED" ? "Unlinked" : "Proposal dismissed",
			);
			onActioned();
		} catch (error) {
			toast.error("Failed to update proposal", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		} finally {
			setBusy(null);
		}
	};

	const handleRepush = async () => {
		setBusy("REPUSH");
		try {
			await orpcClient.projects.stories.retryPmSync({
				projectId,
				storyId: item.entityId,
				itemType: item.itemType,
				unlinkFirst: true,
				pushAnyway: false,
				organizationId: organizationId ?? null,
			});
			toast.success("Re-push queued");
			onActioned();
		} catch (error) {
			toast.error("Failed to re-push", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		} finally {
			setBusy(null);
			setConfirmRepush(false);
		}
	};

	return (
		<>
			<DestructiveTooltip
				copy={t.raw("reviewUnlink") as DestructiveTooltipCopy}
			>
				<Button
					variant="outline"
					size="sm"
					className="h-7 text-xs"
					onClick={() => review("APPROVED")}
					disabled={busy !== null}
					aria-label={`Unlink ${item.identifier}`}
				>
					{busy === "APPROVED" ? (
						<Loader2Icon
							className="size-3 mr-1 animate-spin"
							aria-hidden
						/>
					) : (
						<Link2OffIcon className="size-3 mr-1" aria-hidden />
					)}
					Unlink
				</Button>
			</DestructiveTooltip>

			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						className="h-7 text-xs"
						onClick={() => setConfirmRepush(true)}
						disabled={busy !== null}
						aria-label={`Re-push ${item.identifier}`}
					>
						{busy === "REPUSH" ? (
							<Loader2Icon
								className="size-3 mr-1 animate-spin"
								aria-hidden
							/>
						) : (
							<RotateCcwIcon
								className="size-3 mr-1"
								aria-hidden
							/>
						)}
						Re-push
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					{t("reviewRepush", { tool: pmToolLabel })}
				</TooltipContent>
			</Tooltip>

			<DestructiveTooltip
				copy={t.raw("reviewDismiss") as DestructiveTooltipCopy}
			>
				<Button
					variant="ghost"
					size="sm"
					className="h-7 text-xs"
					onClick={() => review("DISMISSED")}
					disabled={busy !== null}
					aria-label={`Dismiss ${item.identifier}`}
				>
					{busy === "DISMISSED" ? (
						<Loader2Icon
							className="size-3 mr-1 animate-spin"
							aria-hidden
						/>
					) : (
						<XIcon className="size-3 mr-1" aria-hidden />
					)}
					Dismiss
				</Button>
			</DestructiveTooltip>

			<AlertDialog
				open={confirmRepush}
				onOpenChange={(open) => !open && setConfirmRepush(false)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{`Re-push to ${pmToolLabel}?`}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("reviewRepushConfirmBody", {
								tool: pmToolLabel,
							})}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={(event) => {
								// Keep the dialog mounted while the async push runs;
								// `handleRepush` closes it in its `finally`.
								event.preventDefault();
								handleRepush();
							}}
						>
							Re-push
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
