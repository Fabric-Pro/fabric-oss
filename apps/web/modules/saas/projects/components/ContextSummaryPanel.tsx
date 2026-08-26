"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Progress } from "@ui/components/progress";
import { Skeleton } from "@ui/components/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { formatDistanceToNow } from "date-fns";
import {
	AlertTriangleIcon,
	EyeIcon,
	InfoIcon,
	LoaderIcon,
	RefreshCwIcon,
	SparklesIcon,
	XIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import {
	SummarySourceSelectionDialog,
	type SummarySources,
} from "./SummarySourceSelectionDialog";

// Client mirror of the server `FABRIC_FEATURE_CONTEXT_SUMMARIZATION` flag —
// opt-in, default OFF. Read as a literal so Next.js inlines it at build time.
const CONTEXT_SUMMARIZATION_ENABLED =
	process.env.NEXT_PUBLIC_FABRIC_FEATURE_CONTEXT_SUMMARIZATION === "true";

// Client mirror of the code-repo source gate (same flags as the Atlas / code
// understanding UI). Off ⇒ the source picker hides the "code repo" option.
const CODE_REPO_SOURCE_ENABLED =
	process.env.NEXT_PUBLIC_FABRIC_FEATURE_ATLAS === "true" ||
	process.env.NEXT_PUBLIC_FABRIC_FEATURE_CODE_UNDERSTANDING === "true";

// Project roles that may trigger a summarization run. Mirrors the admin gate
// other project-settings controls use in `ProjectDetails` and the server's
// `PROJECT_SETTINGS_EDIT` permission on `summarizeContextProcedure` — editors
// and viewers see the read-only surface only.
const ADMIN_ROLES = new Set([
	"owner",
	"admin",
	"project_admin",
	"PROJECT_ADMIN",
]);

function toDate(value: Date | string): Date {
	return typeof value === "string" ? new Date(value) : value;
}

/**
 * Context-tab surface for compressed project history: an admin trigger, a live
 * poll/status indicator, a "Summary" badge, and a read-only view of the
 * generated summary. Renders nothing unless the client feature flag is on; the
 * inner component holds the hooks so the flag gate stays before any hook call.
 */
export function ContextSummaryPanel({ projectId }: { projectId: string }) {
	if (!CONTEXT_SUMMARIZATION_ENABLED) {
		return null;
	}
	return <ContextSummaryPanelInner projectId={projectId} />;
}

function ContextSummaryPanelInner({ projectId }: { projectId: string }) {
	const t = useTranslations("projects.contextSummary");
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();
	// The full-page reader lives at the project route + `/context-summary`;
	// pathname is the project detail path in both the account and org trees.
	const pathname = usePathname();

	const projectQuery = useQuery(
		orpc.projects.get.queryOptions({
			input: { id: projectId, organizationId },
		}),
	);
	const isAdmin = ADMIN_ROLES.has(projectQuery.data?.project?.userRole ?? "");

	const statusQuery = useQuery(
		orpc.projects.contexts.summaryStatus.queryOptions({
			input: { projectId, organizationId },
			// Poll while a run is in flight; stop once it settles or is absent.
			refetchInterval: (query) => {
				const status = query.state.data?.status;
				return status === "PENDING" || status === "GENERATING"
					? 4000
					: false;
			},
		}),
	);

	const [sourceDialogOpen, setSourceDialogOpen] = useState(false);

	const invalidateStatus = () =>
		queryClient.invalidateQueries({
			queryKey: orpc.projects.contexts.summaryStatus.queryOptions({
				input: { projectId, organizationId },
			}).queryKey,
		});

	const summarizeMutation = useMutation({
		mutationFn: (sources: SummarySources) =>
			orpc.projects.contexts.summarize.call({
				projectId,
				organizationId,
				sources,
			}),
		onSuccess: () => {
			setSourceDialogOpen(false);
			invalidateStatus();
		},
		onError: () => {
			toast.error(t("error"));
		},
	});

	const cancelMutation = useMutation({
		mutationFn: () =>
			orpc.projects.contexts.cancelSummary.call({
				projectId,
				organizationId,
			}),
		onSuccess: () => invalidateStatus(),
		onError: () => toast.error(t("cancel.error")),
	});

	// Server flag off (or no access): keep the Context tab clean rather than
	// surfacing a broken card.
	if (statusQuery.isError) {
		return null;
	}

	if (statusQuery.isLoading) {
		return <Skeleton className="h-24 w-full rounded-xl" />;
	}

	const status = statusQuery.data?.status ?? null;
	const summary = statusQuery.data?.summary ?? null;
	const isRunning = status === "PENDING" || status === "GENERATING";
	const triggerPending = summarizeMutation.isPending || isRunning;

	const triggerButton = (label: string) => {
		if (!isAdmin) {
			return (
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>
							{/* Wrapper span keeps the tooltip reachable while the
							    button itself is disabled for non-admins. */}
							<span className="inline-flex">
								<Button
									type="button"
									variant="ghost"
									disabled
									className="gap-2 border border-primary/20 bg-primary/12 text-primary"
								>
									<SparklesIcon
										className="size-4"
										aria-hidden="true"
									/>
									{label}
								</Button>
							</span>
						</TooltipTrigger>
						<TooltipContent>{t("empty.adminOnly")}</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			);
		}
		return (
			<Button
				type="button"
				variant="ghost"
				onClick={() => setSourceDialogOpen(true)}
				disabled={triggerPending}
				className="gap-2 border border-primary/20 bg-primary/12 text-primary hover:bg-primary/18"
			>
				<SparklesIcon className="size-4" aria-hidden="true" />
				{label}
			</Button>
		);
	};

	const progress = summary?.progress ?? null;

	return (
		<section
			className="rounded-xl border border-border bg-card p-4"
			aria-labelledby="context-summary-heading"
			data-testid="context-summary-panel"
			data-onboarding-target="context-summary"
		>
			<div className="flex flex-wrap items-start gap-3">
				<div
					className="shrink-0 rounded-md border border-border bg-muted p-2 text-primary"
					aria-hidden="true"
				>
					<SparklesIcon className="size-5" />
				</div>

				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5">
						<p
							id="context-summary-heading"
							className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground"
						>
							{t("eyebrow")}
						</p>
						<TooltipProvider>
							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										aria-label={t("info.aria")}
										className="inline-flex text-muted-foreground/70 motion-safe:transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
									>
										<InfoIcon
											className="size-3.5"
											aria-hidden="true"
										/>
									</button>
								</TooltipTrigger>
								<TooltipContent className="max-w-xs text-xs leading-relaxed">
									{t("info.body")}
								</TooltipContent>
							</Tooltip>
						</TooltipProvider>
					</div>

					{/* Status line — aria-live so the running → completed / failed
					    transition is announced without a manual refresh. */}
					<div className="mt-1" aria-live="polite">
						{isRunning ? (
							<div className="max-w-md space-y-1.5">
								<p className="flex items-center gap-2 text-foreground/80 text-sm">
									<LoaderIcon
										className="size-4 shrink-0 text-primary motion-safe:animate-spin"
										aria-hidden="true"
									/>
									{progress
										? t("generating.progress", {
												percent: progress.percent,
											})
										: t("generating.status")}
								</p>
								{progress && (
									<>
										<Progress
											value={progress.percent}
											className="h-1.5"
											aria-label={t("generating.status")}
										/>
										{progress.planned > 0 && (
											<p className="text-muted-foreground text-xs">
												{t("generating.sources", {
													processed:
														progress.processed,
													planned: progress.planned,
												})}
											</p>
										)}
									</>
								)}
							</div>
						) : status === "COMPLETED" && summary ? (
							<div className="flex flex-wrap items-center gap-2 text-foreground/80 text-sm">
								<span>
									{t("completed.status", {
										time: formatDistanceToNow(
											toDate(summary.updatedAt),
											{ addSuffix: true },
										),
										count: summary.coveredContextCount,
									})}
								</span>
								<Badge variant="secondary">
									{t("completed.badge")}
								</Badge>
							</div>
						) : status === "FAILED" ? (
							<div className="text-sm">
								<p className="flex items-center gap-2 text-foreground/80">
									<AlertTriangleIcon
										className="size-4 shrink-0 text-destructive"
										aria-hidden="true"
									/>
									{t("failed.status")}
								</p>
								{summary?.error && (
									<p className="mt-1 text-muted-foreground text-xs">
										{summary.error}
									</p>
								)}
							</div>
						) : status === "CANCELLED" ? (
							<p className="text-muted-foreground text-sm">
								{t("cancel.status")}
							</p>
						) : (
							<p className="text-muted-foreground text-sm">
								{t("empty.description")}
							</p>
						)}
					</div>
				</div>

				{/* Action cluster — state-specific, admin-gated where it mutates. */}
				<div className="flex shrink-0 flex-wrap items-center gap-2">
					{isRunning && isAdmin && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => cancelMutation.mutate()}
							disabled={cancelMutation.isPending}
							className="gap-2 text-muted-foreground hover:text-destructive"
						>
							<XIcon className="size-4" aria-hidden="true" />
							{t("cancel.action")}
						</Button>
					)}
					{status === "COMPLETED" && summary && (
						<>
							<Button
								asChild
								variant="outline"
								size="sm"
								className="gap-2"
							>
								<Link href={`${pathname}/context-summary`}>
									<EyeIcon
										className="size-4"
										aria-hidden="true"
									/>
									{t("completed.view")}
								</Link>
							</Button>
							{isAdmin && (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => setSourceDialogOpen(true)}
									disabled={triggerPending}
									className="gap-2 text-muted-foreground hover:text-foreground"
								>
									<RefreshCwIcon
										className="size-4"
										aria-hidden="true"
									/>
									{t("completed.resummarize")}
								</Button>
							)}
						</>
					)}
					{status === "FAILED" && triggerButton(t("failed.retry"))}
					{status === "CANCELLED" && triggerButton(t("empty.action"))}
					{status === null && triggerButton(t("empty.action"))}
				</div>
			</div>

			<SummarySourceSelectionDialog
				open={sourceDialogOpen}
				onOpenChange={setSourceDialogOpen}
				codeRepoEnabled={CODE_REPO_SOURCE_ENABLED}
				pending={summarizeMutation.isPending}
				onConfirm={(sources) => summarizeMutation.mutate(sources)}
			/>
		</section>
	);
}
