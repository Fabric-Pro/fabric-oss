"use client";

/**
 * LinkContextManagePanel — URL Context Sources right-side action cluster.
 *
 * PM simplification (post-staging feedback): the LINK card used to carry a
 * persistent toolbar at the bottom with scope/refresh chips, a Re-sync CTA,
 * a content-preview eye, an open-full-view arrow, and a More menu. After
 * shipping that to staging the PM asked us to strip it back to two
 * affordances on the same row as the title:
 *
 *  1. Eye icon → navigates straight to the dedicated full-view page
 *     (`/app/[slug]/projects/[id]/contexts/[contextId]`). The preview
 *     drawer that the eye used to open is gone entirely — the full view
 *     is now the only deep-dive surface.
 *  2. More options dropdown with exactly two items:
 *     - Sync now (fires `resyncUrlSource`)
 *     - Delete (fires the parent's `onDelete` handler)
 *
 * Scope / cadence / max-pages / label editing all moved to the full-view
 * page's right sidebar (see `UrlSourcePageView.tsx`) where the user has
 * the room — and the cost-warning context — to make the change deliberately.
 *
 * Both buttons render as small icon-only ghost buttons (size 8x8) so the
 * cluster matches Meeting-Transcripts / Backlog cards' right-side affordance.
 *
 * Editorial aesthetic (CLAUDE.md):
 *  - No gradient pills, no glassmorphism, no hardcoded hex.
 *  - Semantic tokens only (`text-muted-foreground`, `text-destructive`, etc.).
 *  - `motion-safe:` gates every transition.
 */

import { useAnalytics } from "@analytics";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { DestructiveTooltip } from "@ui/components/destructive-tooltip";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	DownloadIcon,
	EyeIcon,
	MoreVerticalIcon,
	RefreshCwIcon,
	TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
	ContextSourceDetailsDialog,
	EditSourceDetailsMenuItem,
} from "./ContextSourceDetailsDialog";

export type LinkContextScope = "SINGLE_PAGE" | "PATH_PREFIX";
export type LinkContextRefreshMode =
	| "ONCE"
	| "DAILY"
	| "WEEKLY"
	| "MONTHLY"
	| "LIVE";

type Props = {
	contextId: string;
	projectId: string;
	/** Deletes this LINK context. Wired to the More-menu's destructive item. */
	onDelete?: () => void;
	/** Disables the More-menu's Delete item while a delete is in flight. */
	deletePending?: boolean;
	/** Copy for the destructive-tooltip wrapper. */
	deleteCopy?: { label: string; warning: string };
	/**
	 * Fires the same download flow used by sibling context cards.
	 * When omitted, the Download menu item is hidden (legacy callers).
	 */
	onDownload?: () => void;
	/**
	 * When true, Sync / Download / Delete are all locked because the row is
	 * mid-crawl. Matches the lockdown rule enforced server-side by the
	 * `resyncUrlSourceProcedure` and `deleteContext` CONFLICT guards — keeps
	 * the visible UI honest if a stale tab is showing pre-crawl state.
	 */
	isCrawling?: boolean;
	/** Context Source Type Labeling (#1888) — feeds the Edit-details item. */
	sourceType?: string | null;
	aiInstructions?: string | null;
	/** Card title, shown in the edit dialog header. */
	sourceName?: string;
};

export function LinkContextManagePanel({
	contextId,
	projectId,
	onDelete,
	deletePending,
	deleteCopy,
	onDownload,
	isCrawling = false,
	sourceType,
	aiInstructions,
	sourceName,
}: Props) {
	const { organizationId, organizationSlug } = useOrganizationContext();
	const queryClient = useQueryClient();
	const { trackEvent } = useAnalytics();
	const t = useTranslations("tooltips.contextSources.urlSource");

	// Build the dedicated full-view route once. Works in both personal
	// (`/app/projects/...`) and org-scoped (`/app/{slug}/projects/...`) routes.
	const fullViewHref = organizationSlug
		? `/app/${organizationSlug}/projects/${projectId}/contexts/${contextId}`
		: `/app/projects/${projectId}/contexts/${contextId}`;

	const [detailsOpen, setDetailsOpen] = useState(false);

	const resyncMutation = useMutation({
		mutationFn: () =>
			orpcClient.projects.contexts.resyncUrlSource({
				contextId,
				projectId,
				organizationId,
			}),
		onSuccess: () => {
			toast.success("Re-sync started");
			trackEvent("project_context_url_resynced", {
				trigger: "manual",
				projectId,
				organizationId,
			});
			queryClient.invalidateQueries({
				queryKey: orpc.projects.contexts.list.queryKey({
					input: { projectId, organizationId },
				}),
			});
		},
		onError: (error: unknown) => {
			const message =
				error instanceof Error ? error.message : "Re-sync failed";
			toast.error(message);
		},
	});

	return (
		<div
			className="flex shrink-0 items-center gap-1"
			data-testid="link-card-actions"
		>
			<Tooltip delayDuration={150}>
				<TooltipTrigger asChild>
					<Button
						asChild
						variant="ghost"
						size="icon"
						className="size-8"
					>
						<Link
							href={fullViewHref}
							aria-label="View URL source"
							data-testid="link-card-open-full-view"
						>
							<EyeIcon className="size-3.5" aria-hidden="true" />
						</Link>
					</Button>
				</TooltipTrigger>
				<TooltipContent side="top">{t("openFullView")}</TooltipContent>
			</Tooltip>

			<DropdownMenu>
				<Tooltip delayDuration={150}>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="size-8"
								aria-label="More options"
								data-testid="link-card-more"
							>
								<MoreVerticalIcon
									className="size-3.5"
									aria-hidden="true"
								/>
							</Button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<TooltipContent side="top">
						{t("moreOptions")}
					</TooltipContent>
				</Tooltip>
				<DropdownMenuContent align="end">
					<EditSourceDetailsMenuItem
						testId={`context-edit-details-${contextId}`}
						onOpen={() => setDetailsOpen(true)}
					/>
					<DropdownMenuItem
						onClick={(e) => {
							e.stopPropagation();
							if (isCrawling) {
								return;
							}
							resyncMutation.mutate();
						}}
						disabled={resyncMutation.isPending || isCrawling}
						data-testid="link-card-sync-now"
					>
						<RefreshCwIcon
							className="mr-2 size-4"
							aria-hidden="true"
						/>
						{resyncMutation.isPending
							? "Syncing…"
							: isCrawling
								? "Already processing"
								: "Sync now"}
					</DropdownMenuItem>
					{onDownload && (
						<DropdownMenuItem
							onClick={(e) => {
								e.stopPropagation();
								if (isCrawling) {
									return;
								}
								onDownload();
							}}
							disabled={isCrawling}
							data-testid="link-card-download"
						>
							<DownloadIcon
								className="mr-2 size-4"
								aria-hidden="true"
							/>
							{isCrawling
								? "Cancel processing to download"
								: "Download"}
						</DropdownMenuItem>
					)}
					{onDelete &&
						(deleteCopy ? (
							<DestructiveTooltip copy={deleteCopy}>
								<DropdownMenuItem
									className="text-destructive focus:text-destructive"
									onClick={(e) => {
										e.stopPropagation();
										if (isCrawling) {
											return;
										}
										onDelete();
									}}
									disabled={deletePending || isCrawling}
									data-testid="link-card-delete"
								>
									<TrashIcon className="mr-2 size-4" />
									{deletePending
										? "Deleting..."
										: isCrawling
											? "Cancel processing to delete"
											: "Delete"}
								</DropdownMenuItem>
							</DestructiveTooltip>
						) : (
							<DropdownMenuItem
								className="text-destructive focus:text-destructive"
								onClick={(e) => {
									e.stopPropagation();
									if (isCrawling) {
										return;
									}
									onDelete();
								}}
								disabled={deletePending || isCrawling}
								data-testid="link-card-delete"
							>
								<TrashIcon className="mr-2 size-4" />
								{deletePending
									? "Deleting..."
									: isCrawling
										? "Cancel processing to delete"
										: "Delete"}
							</DropdownMenuItem>
						))}
				</DropdownMenuContent>
			</DropdownMenu>

			{/* Source details dialog (#1888) — lives OUTSIDE the Radix menu,
			    which unmounts its content (and anything inside it) on close. */}
			<ContextSourceDetailsDialog
				open={detailsOpen}
				onOpenChange={setDetailsOpen}
				projectId={projectId}
				contextId={contextId}
				sourceName={sourceName}
				initialSourceType={sourceType ?? null}
				initialAiInstructions={aiInstructions ?? null}
			/>
		</div>
	);
}
