"use client";

import {
	detectPMTypeFromUrl,
	normalizeAdoWebUrl,
	pmDetectedTypeDisplayName,
} from "@repo/utils";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useMutation } from "@tanstack/react-query";
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
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertTriangleIcon,
	ArrowDownToLineIcon,
	ArrowUpFromLineIcon,
	ChevronDownIcon,
	CloudIcon,
	CloudOffIcon,
	ExternalLinkIcon,
	Loader2Icon,
	PauseIcon,
	PlayIcon,
	RotateCcwIcon,
	SettingsIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { orpcClient } from "../../../../../shared/lib/orpc-client";
import { buildProjectSettingsRoute } from "../../../lib/stories/routes";
import type { PmSyncStatus } from "../../../lib/stories/types";
import { ConflictResolveDialog } from "../ConflictResolveDialog";
import { isPmTicketMissingError } from "./PmSyncFailureBadge";
import { PmSyncFailureSidePanel } from "./PmSyncFailureSidePanel";
import { useInvalidatePmSyncState } from "./use-invalidate-pm-sync-state";

export interface PmSyncChipProps {
	storyId: string;
	projectId: string;
	organizationId: string | null;
	itemType: "story" | "bug";
	identifier?: string;
	fabricTitle: string;
	fabricDescription: string;
	fabricUpdatedAt?: string | Date | null;
	fabricAuthor?: string | null;
	fabricSource?:
		| "MANUAL"
		| "AI_BACKLOG_UPDATE"
		| "AI_MATURATION"
		| "CONFLICT_RESOLUTION"
		| "PM_PULL"
		| null;
	pmAutoSyncEnabled: boolean;
	externalId: string | null;
	externalUrl: string | null;
	lastPmSyncStatus: PmSyncStatus | null;
	lastPmSyncError?: string | null;
	lastPmSyncAttemptAt?: Date | string | null;
	/** `undefined` while pmCapabilities is loading → render nothing. */
	hasPmIntegration: boolean | undefined;
	pmToolName: string;
	className?: string;
}

type ChipStatus =
	| "synced"
	| "notsynced"
	| "paused"
	| "failed"
	| "conflict"
	| "notconfigured";

/** Validate + normalize a stored PM-tool URL to a safe http(s) web URL. */
function getValidExternalUrl(url: string | null | undefined): string | null {
	if (!url) {
		return null;
	}
	const normalized = normalizeAdoWebUrl(url);
	try {
		const p = new URL(normalized);
		if (p.protocol === "http:" || p.protocol === "https:") {
			return normalized;
		}
	} catch {
		/* not absolute */
	}
	return null;
}

/** Short card reference (e.g. "#1514", "#95", "PROJ-1") from the URL tail. */
function cardRef(url: string | null): string | null {
	if (!url) {
		return null;
	}
	try {
		const seg = new URL(url).pathname.split("/").filter(Boolean).pop();
		if (!seg) {
			return null;
		}
		return /^\d+$/.test(seg) ? `#${seg}` : seg;
	} catch {
		return null;
	}
}

/**
 * Single PM-sync chip for the feature editor. ONE chip shows the status
 * (Synced / Not synced / Paused / PM sync failed / Conflict) with a hover
 * tooltip explaining auto-sync; clicking it opens a dropdown with everything
 * behind it — open the card, push (force/overwrite — or "Start syncing" to
 * create when unlinked), pull, pause/resume auto-sync, and review the problem
 * (→ the failure panel / conflict dialog). Replaces the separate cloud toggle
 * + status badges in the editor so the row never shows two or three elements.
 */
export function PmSyncChip({
	storyId,
	projectId,
	organizationId,
	itemType,
	identifier,
	fabricTitle,
	fabricDescription,
	fabricUpdatedAt,
	fabricAuthor,
	fabricSource,
	pmAutoSyncEnabled,
	externalId,
	externalUrl,
	lastPmSyncStatus,
	lastPmSyncError = null,
	lastPmSyncAttemptAt = null,
	hasPmIntegration,
	pmToolName,
	className,
}: PmSyncChipProps) {
	const { basePath } = useOrganizationContext();
	const tChip = useTranslations("tooltips.stories.pmSyncChip");

	const [failurePanelOpen, setFailurePanelOpen] = useState(false);
	const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
	const [confirm, setConfirm] = useState<"push" | "pull" | "migrate" | null>(
		null,
	);

	const invalidate = useInvalidatePmSyncState(projectId);

	const settingsHref = buildProjectSettingsRoute(basePath, projectId);
	const validUrl = getValidExternalUrl(externalUrl);
	const ref = cardRef(validUrl);
	const linkTool =
		pmDetectedTypeDisplayName(detectPMTypeFromUrl(externalUrl)) ??
		pmToolName;

	// --- mutations -----------------------------------------------------------
	const toggleAutoSync = useMutation({
		mutationFn: async (next: boolean) =>
			orpcClient.projects.stories.update({
				projectId,
				storyId,
				organizationId,
				pmAutoSyncEnabled: next,
			}),
		onSuccess: (_d, next) => {
			toast.success(next ? "Auto-sync resumed" : "Auto-sync paused");
			invalidate();
		},
		onError: (e) =>
			toast.error("Could not update auto-sync", {
				description: e instanceof Error ? e.message : undefined,
			}),
	});

	const syncMutation = useMutation({
		mutationFn: async (vars: {
			direction: "push" | "pull";
			overrideMismatch?: boolean;
		}) =>
			orpcClient.projects.stories.sync({
				projectId,
				storyId,
				organizationId,
				direction: vars.direction,
				overrideMismatch: vars.overrideMismatch,
			}),
		onSuccess: (_d, vars) => {
			invalidate();
			toast.success(
				vars.direction === "push"
					? `Pushed to ${pmToolName}`
					: `Pulled from ${pmToolName}`,
			);
		},
		onError: (error, vars) => {
			const code = (
				error as { data?: { errorCode?: string } } | undefined
			)?.data?.errorCode;
			if (
				code === "PM_TOOL_MISMATCH" &&
				vars.direction === "push" &&
				!vars.overrideMismatch
			) {
				setConfirm("migrate");
				return;
			}
			// Read-only mode: the push was blocked by the
			// project-level toggle, not by a sync failure.
			if (code === "PROJECT_READ_ONLY") {
				toast.warning("Project is in Read-only mode", {
					description:
						error instanceof Error ? error.message : String(error),
				});
				return;
			}
			toast.error("Failed to sync", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const retryMutation = useMutation({
		mutationFn: async () =>
			orpcClient.projects.stories.retryPmSync({
				projectId,
				storyId,
				itemType,
				pushAnyway: false,
				organizationId,
			}),
		onSuccess: (res) => {
			// Read-only mode: the enqueue is skipped server-side
			// with `reason: "read-only-mode"` — don't claim the sync was queued.
			if (!res.enqueued && res.reason === "read-only-mode") {
				toast.warning("Project is in Read-only mode", {
					description:
						"The sync was not queued — outbound writes to connected sources are disabled for this project.",
				});
				return;
			}
			toast.success("Sync queued");
			invalidate();
		},
		onError: (e) =>
			toast.error("Failed to queue sync", {
				description: e instanceof Error ? e.message : String(e),
			}),
	});

	const recreateMutation = useMutation({
		mutationFn: async () =>
			orpcClient.projects.stories.retryPmSync({
				projectId,
				storyId,
				itemType,
				unlinkFirst: true,
				organizationId,
			}),
		onSuccess: (res) => {
			if (!res.enqueued && res.reason === "read-only-mode") {
				toast.warning("Project is in Read-only mode", {
					description:
						"The re-create was not queued — outbound writes to connected sources are disabled for this project.",
				});
				return;
			}
			toast.success(`Re-creating in ${pmToolName}…`);
			invalidate();
		},
		onError: (e) =>
			toast.error("Failed to re-create", {
				description: e instanceof Error ? e.message : String(e),
			}),
	});

	if (hasPmIntegration === undefined) {
		return null;
	}

	const status: ChipStatus = !hasPmIntegration
		? "notconfigured"
		: lastPmSyncStatus === "FAILED"
			? "failed"
			: lastPmSyncStatus === "CONFLICT"
				? "conflict"
				: !pmAutoSyncEnabled
					? "paused"
					: externalId
						? "synced"
						: "notsynced";

	// A deleted-card 404 has no live card to link to.
	const cardGone =
		status === "failed" && isPmTicketMissingError(lastPmSyncError);
	const showCardLink = !!validUrl && !cardGone;

	const META: Record<
		ChipStatus,
		{ label: string; icon: typeof CloudIcon; cls: string }
	> = {
		synced: {
			label: "Synced",
			icon: CloudIcon,
			cls: "text-secondary border-secondary/30 bg-secondary/10 hover:bg-secondary/15",
		},
		notsynced: {
			label: "Not synced",
			icon: CloudIcon,
			cls: "text-muted-foreground border-border hover:bg-accent",
		},
		paused: {
			label: "Paused",
			icon: CloudOffIcon,
			cls: "text-muted-foreground border-border hover:bg-accent",
		},
		failed: {
			label: "PM sync failed",
			icon: CloudOffIcon,
			cls: "text-destructive border-destructive/35 bg-destructive/5 hover:bg-destructive/10",
		},
		conflict: {
			label: "Conflict",
			icon: AlertTriangleIcon,
			cls: "text-highlight border-highlight/40 bg-highlight/5 hover:bg-highlight/10 ring-1 ring-highlight/30",
		},
		notconfigured: {
			label: "PM tool not set",
			icon: CloudOffIcon,
			cls: "text-destructive border-destructive/35 bg-destructive/5 hover:bg-destructive/10",
		},
	};
	const meta = META[status];
	const Icon = meta.icon;
	const chipTip = tChip(status, { pmToolName });
	const busy =
		toggleAutoSync.isPending ||
		syncMutation.isPending ||
		retryMutation.isPending ||
		recreateMutation.isPending;

	const openCard = () => {
		if (validUrl) {
			window.open(validUrl, "_blank", "noopener,noreferrer");
		}
	};
	// Push: a linked card is overwritten (confirm); an unlinked item is created
	// directly ("Start syncing"). Pull always overwrites local (confirm).
	const onPush = () =>
		externalId
			? setConfirm("push")
			: syncMutation.mutate({ direction: "push" });
	const onPull = () => setConfirm("pull");

	return (
		<div
			className={cn("inline-flex items-center", className)}
			data-testid="pm-sync-chip"
		>
			<DropdownMenu>
				{/* The chip's visible text (status label + card ref) already names
					the control, so there is no `aria-label` here — the previous one
					replaced that visible text in the accessible name, which breaks
					WCAG 2.5.3 Label in Name. The advisory copy is a tooltip
					description instead. */}
				<Tooltip>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								disabled={busy}
								data-status={status}
								className={cn(
									"inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1",
									"text-[11px] font-medium uppercase tracking-[0.06em] whitespace-nowrap",
									"transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
									"disabled:opacity-70 disabled:cursor-default cursor-pointer",
									meta.cls,
								)}
							>
								{busy ? (
									<Loader2Icon
										className="size-3.5 animate-spin"
										aria-hidden="true"
									/>
								) : (
									<Icon
										className="size-3.5"
										aria-hidden="true"
									/>
								)}
								{/* Icon-only on a phone. This chip is ~170px of a
									360px row and it was starving the breadcrumb's
									project name beside it. `sr-only` rather than
									`hidden` keeps the label in the accessibility
									tree, so the button's accessible name is
									unchanged — an `aria-label` standing in for
									hidden visible text is exactly what the note
									above rules out. */}
								<span className="sr-only sm:not-sr-only">
									{meta.label}
								</span>
								{ref && showCardLink ? (
									<span className="sr-only sm:not-sr-only font-normal normal-case opacity-70 tabular-nums">
										· {ref}
									</span>
								) : null}
								<ChevronDownIcon
									className="size-3 opacity-60"
									aria-hidden="true"
								/>
							</button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<TooltipContent>{chipTip}</TooltipContent>
				</Tooltip>

				<DropdownMenuContent align="end" className="min-w-56">
					{status === "notconfigured" ? (
						<DropdownMenuItem asChild>
							<a href={settingsHref}>
								<SettingsIcon
									className="size-4 mr-2"
									aria-hidden="true"
								/>
								Configure PM tool
							</a>
						</DropdownMenuItem>
					) : (
						<>
							{showCardLink ? (
								<DropdownMenuItem onClick={openCard}>
									<ExternalLinkIcon
										className="size-4 mr-2"
										aria-hidden="true"
									/>
									Open {linkTool} card
									{ref ? (
										<span className="ml-auto text-xs text-muted-foreground tabular-nums">
											{ref}
										</span>
									) : null}
								</DropdownMenuItem>
							) : null}

							<DropdownMenuItem onClick={onPush}>
								<ArrowUpFromLineIcon
									className="size-4 mr-2"
									aria-hidden="true"
								/>
								{externalId
									? `Push to ${pmToolName}`
									: `Start syncing — push to ${pmToolName}`}
								{externalId ? (
									<span className="ml-auto text-xs text-muted-foreground">
										overwrite
									</span>
								) : null}
							</DropdownMenuItem>

							{externalId ? (
								<DropdownMenuItem onClick={onPull}>
									<ArrowDownToLineIcon
										className="size-4 mr-2"
										aria-hidden="true"
									/>
									Pull from {pmToolName}
								</DropdownMenuItem>
							) : null}

							<DropdownMenuItem
								onClick={() =>
									toggleAutoSync.mutate(!pmAutoSyncEnabled)
								}
							>
								{pmAutoSyncEnabled ? (
									<PauseIcon
										className="size-4 mr-2"
										aria-hidden="true"
									/>
								) : (
									<PlayIcon
										className="size-4 mr-2"
										aria-hidden="true"
									/>
								)}
								{pmAutoSyncEnabled
									? "Pause auto-sync"
									: "Resume auto-sync"}
							</DropdownMenuItem>

							{status === "failed" ? (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										className="text-destructive focus:text-destructive"
										onClick={() =>
											setFailurePanelOpen(true)
										}
									>
										<RotateCcwIcon
											className="size-4 mr-2"
											aria-hidden="true"
										/>
										Review problem &amp; Retry
									</DropdownMenuItem>
								</>
							) : null}
							{status === "conflict" ? (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										className="text-highlight focus:text-highlight"
										onClick={() =>
											setConflictDialogOpen(true)
										}
									>
										<AlertTriangleIcon
											className="size-4 mr-2"
											aria-hidden="true"
										/>
										Review &amp; resolve
									</DropdownMenuItem>
								</>
							) : null}
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>

			{/* Failure side panel — Retry re-creates a deleted card under the hood. */}
			<PmSyncFailureSidePanel
				open={failurePanelOpen}
				onOpenChange={setFailurePanelOpen}
				pmToolName={pmToolName}
				error={lastPmSyncError}
				attemptedAt={lastPmSyncAttemptAt}
				onRetry={() => {
					retryMutation.mutate();
					setFailurePanelOpen(false);
				}}
				isRetrying={retryMutation.isPending}
				onUnlinkRecreate={() => {
					recreateMutation.mutate();
					setFailurePanelOpen(false);
				}}
				isUnlinking={recreateMutation.isPending}
				onRelink={() => {
					syncMutation.mutate({
						direction: "push",
						overrideMismatch: true,
					});
					setFailurePanelOpen(false);
				}}
				isRelinking={syncMutation.isPending}
				settingsHref={settingsHref}
			/>

			{/* Conflict resolve — self-fetches its preview on open. */}
			<ConflictResolveDialog
				open={conflictDialogOpen}
				onOpenChange={setConflictDialogOpen}
				projectId={projectId}
				organizationId={organizationId}
				itemType={itemType}
				entityId={storyId}
				fabricTitle={fabricTitle}
				fabricDescription={fabricDescription}
				fabricUpdatedAt={fabricUpdatedAt}
				fabricAuthor={fabricAuthor}
				fabricSource={fabricSource}
				identifier={identifier}
				settingsHref={settingsHref}
				onResolved={invalidate}
			/>

			{/* Push / Pull / migrate confirmations. */}
			<AlertDialog
				open={confirm !== null}
				onOpenChange={(o) => !o && setConfirm(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{confirm === "pull"
								? `Pull from ${pmToolName}?`
								: confirm === "migrate"
									? `Migrate this item to ${pmToolName}?`
									: `Push to ${pmToolName}?`}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{confirm === "pull"
								? `This overwrites the Fabric title and description with the latest from ${pmToolName}. This cannot be undone.`
								: confirm === "migrate"
									? `This item is currently linked to a different PM tool. Pushing now creates a new item in ${pmToolName} and drops the old link. The previous item is not deleted.`
									: `This overwrites the current content of the linked ${pmToolName} card with this editor. This cannot be undone.`}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (confirm === "pull") {
									syncMutation.mutate({ direction: "pull" });
								} else if (confirm === "migrate") {
									syncMutation.mutate({
										direction: "push",
										overrideMismatch: true,
									});
								} else {
									syncMutation.mutate({ direction: "push" });
								}
								setConfirm(null);
							}}
						>
							{confirm === "pull"
								? "Pull & overwrite"
								: confirm === "migrate"
									? "Push & relink"
									: "Push & overwrite"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
