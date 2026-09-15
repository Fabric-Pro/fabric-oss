"use client";

/**
 * DiscoveryPanel (plan Slice 4)
 *
 * For DISCOVERY-track features: the latest discovery run's status, a link to
 * the integration contract document, the open questions the run posted
 * (story comments carrying `metadata.discoveryRunId`), and the human
 * sign-off button ("Mark contract complete") for project editors — the
 * sign-off that satisfies the readiness gate.
 *
 * Editorial restraint: tokens only, no ambient motion, typography carries
 * the hierarchy. Renders nothing for other tracks.
 */

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
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
import {
	AlertCircleIcon,
	CheckCircle2Icon,
	CircleDashedIcon,
	FileTextIcon,
	Loader2Icon,
	MessageSquareIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { toast } from "sonner";
import { orpcClient } from "../../../../shared/lib/orpc-client";
import type { DeliveryTrack } from "../../lib/stories/types";
import { InfoTip } from "./InfoTip";
import { invalidateStoryReadiness } from "./useStoryReadiness";

type Props = {
	projectId: string;
	storyId: string;
	organizationId?: string | null;
	deliveryTrack: DeliveryTrack;
	/**
	 * Whether the viewer may mark the contract complete. When omitted the
	 * panel derives it from the project role (owner / editor).
	 */
	canEdit?: boolean;
	className?: string;
};

type DiscoveryRunStatus =
	| "QUEUED"
	| "RUNNING"
	| "CONTRACT_READY"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED";

type DiscoveryRun = {
	id: string;
	status: DiscoveryRunStatus;
	documentId: string | null;
	error: string | null;
	createdAt: Date | string;
	document: {
		id: string;
		title: string;
		status: string;
		isActive: boolean;
	} | null;
};

type StoryComment = {
	id: string;
	content: string;
	metadata: unknown;
	createdAt: Date | string;
};

const ACTIVE_STATUSES: readonly DiscoveryRunStatus[] = ["QUEUED", "RUNNING"];

/** Comments posted by a discovery run (metadata.discoveryRunId). */
export function selectDiscoveryQuestions(
	comments: readonly StoryComment[],
	runId: string | null,
): Array<StoryComment & { blocking: boolean }> {
	const out: Array<StoryComment & { blocking: boolean }> = [];
	for (const comment of comments) {
		const meta = comment.metadata as
			| { discoveryRunId?: unknown; blocking?: unknown }
			| null
			| undefined;
		if (!meta || typeof meta.discoveryRunId !== "string") {
			continue;
		}
		if (runId && meta.discoveryRunId !== runId) {
			continue;
		}
		out.push({ ...comment, blocking: meta.blocking === true });
	}
	return out;
}

/** Strip the markdown prefix the activity adds so the list reads cleanly. */
function questionText(content: string): string {
	const head = content.split("Why it matters:")[0];
	return head
		.replace(/^\*\*Open question \(discovery\):\*\*\s*/i, "")
		.replace(/\(blocking\)\s*$/i, "")
		.trim();
}

function whyText(content: string): string | null {
	const index = content.indexOf("Why it matters:");
	if (index === -1) {
		return null;
	}
	return content.slice(index + "Why it matters:".length).trim() || null;
}

export function DiscoveryPanel({
	projectId,
	storyId,
	organizationId,
	deliveryTrack,
	canEdit,
	className,
}: Props) {
	const t = useTranslations("projects.stories.discovery");
	const tTips = useTranslations("tooltips.stories");
	const { basePath } = useOrganizationContext();
	const queryClient = useQueryClient();
	const enabled = deliveryTrack === "DISCOVERY";

	const runsQuery = useQuery({
		...orpc.projects.discovery.list.queryOptions({
			input: { projectId, storyId, organizationId },
		}),
		enabled,
		refetchInterval: (query) => {
			const latest = (
				query.state.data as { runs?: DiscoveryRun[] } | undefined
			)?.runs?.[0];
			return latest && ACTIVE_STATUSES.includes(latest.status)
				? 3_000
				: false;
		},
	});

	const commentsQuery = useQuery({
		...orpc.projects.stories.comments.list.queryOptions({
			input: { projectId, storyId, organizationId },
		}),
		enabled,
	});

	const projectQuery = useQuery({
		...orpc.projects.get.queryOptions({
			input: { id: projectId, organizationId },
		}),
		enabled: enabled && canEdit === undefined,
		staleTime: 60_000,
	});

	const latest = (runsQuery.data?.runs as DiscoveryRun[] | undefined)?.[0];
	const questions = useMemo(
		() =>
			selectDiscoveryQuestions(
				(commentsQuery.data?.comments ?? []) as StoryComment[],
				latest?.id ?? null,
			),
		[commentsQuery.data, latest?.id],
	);

	const role = (projectQuery.data as { userRole?: string } | undefined)
		?.userRole;
	const mayComplete =
		canEdit !== undefined ? canEdit : role === "owner" || role === "editor";

	const completeMutation = useMutation({
		mutationFn: async (documentId: string) =>
			await orpcClient.projects.discovery.markContractComplete({
				projectId,
				documentId,
				organizationId: organizationId ?? null,
			}),
		onSuccess: async () => {
			toast.success(t("toasts.contractCompleted"));
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: orpc.projects.discovery.list.queryKey({
						input: { projectId, storyId, organizationId },
					}),
				}),
				queryClient.invalidateQueries({
					queryKey: orpc.projects.documents.list.queryKey({
						input: { projectId, organizationId },
					}),
				}),
				invalidateStoryReadiness(queryClient, { projectId, storyId }),
			]);
		},
		onError: (error) => {
			toast.error(t("toasts.completeFailed"), {
				description: error instanceof Error ? error.message : undefined,
			});
		},
	});

	const cancelMutation = useMutation({
		mutationFn: async (runId: string) =>
			await orpcClient.projects.discovery.cancel({
				projectId,
				runId,
				organizationId: organizationId ?? null,
			}),
		onSuccess: async () => {
			toast.success(t("toasts.cancelled"));
			await queryClient.invalidateQueries({
				queryKey: orpc.projects.discovery.list.queryKey({
					input: { projectId, storyId, organizationId },
				}),
			});
		},
		onError: (error) => {
			toast.error(t("toasts.cancelFailed"), {
				description: error instanceof Error ? error.message : undefined,
			});
		},
	});

	if (!enabled) {
		return null;
	}

	const documentHref = latest?.documentId
		? `${basePath}/projects/${projectId}/documents/${latest.documentId}`
		: null;
	const isActive = latest ? ACTIVE_STATUSES.includes(latest.status) : false;
	const contractInReview =
		latest?.status === "CONTRACT_READY" &&
		latest.document?.status === "REVIEW";
	const contractComplete =
		latest?.document?.status === "COMPLETE" ||
		latest?.status === "COMPLETED";

	return (
		<section
			aria-label={t("panel.title")}
			className={cn(
				"border-b bg-muted/40 px-6 py-2.5 text-xs",
				className,
			)}
		>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="editorial-label inline-flex items-center gap-2 font-sans text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
					<span
						aria-hidden="true"
						className="inline-block h-3 w-px bg-primary"
					/>
					{t("panel.title")}
					<InfoTip label={tTips("discoveryPanelHelp")}>
						<p>{tTips("discoveryPanel")}</p>
						<p className="mt-1">{tTips("discoveryRun")}</p>
					</InfoTip>
				</span>

				{runsQuery.isPending ? (
					<span className="inline-flex items-center gap-1.5 text-muted-foreground">
						<CircleDashedIcon
							className="size-3.5"
							aria-hidden="true"
						/>
						{t("panel.loading")}
					</span>
				) : !latest ? (
					<span className="text-muted-foreground">
						{t("panel.noRuns")}
					</span>
				) : (
					<>
						<span
							className={cn(
								"inline-flex items-center gap-1.5 font-medium",
								contractComplete
									? "text-secondary"
									: latest.status === "FAILED"
										? "text-destructive"
										: "text-foreground",
							)}
						>
							{isActive ? (
								<Loader2Icon
									className="size-3.5 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : contractComplete ? (
								<CheckCircle2Icon
									className="size-3.5"
									aria-hidden="true"
								/>
							) : latest.status === "FAILED" ? (
								<AlertCircleIcon
									className="size-3.5"
									aria-hidden="true"
								/>
							) : (
								<FileTextIcon
									className="size-3.5"
									aria-hidden="true"
								/>
							)}
							{t(`status.${latest.status}`)}
						</span>

						{documentHref && latest.document && (
							<Link
								href={documentHref}
								className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
							>
								<FileTextIcon
									className="size-3.5"
									aria-hidden="true"
								/>
								{latest.document.title}
							</Link>
						)}

						{contractInReview && (
							<Badge
								variant="outline"
								className="border-highlight/40 bg-highlight/10 text-highlight"
							>
								{t("panel.awaitingSignOff")}
							</Badge>
						)}

						{contractInReview &&
							mayComplete &&
							latest.documentId && (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											size="sm"
											variant="outline"
											className="h-7 gap-1.5 text-xs"
											disabled={
												completeMutation.isPending
											}
											onClick={() =>
												latest.documentId &&
												completeMutation.mutate(
													latest.documentId,
												)
											}
										>
											{completeMutation.isPending ? (
												<Loader2Icon
													className="size-3.5 motion-safe:animate-spin"
													aria-hidden="true"
												/>
											) : (
												<CheckCircle2Icon
													className="size-3.5"
													aria-hidden="true"
												/>
											)}
											{t("panel.markComplete")}
										</Button>
									</TooltipTrigger>
									<TooltipContent className="max-w-xs text-xs leading-5">
										{tTips("discoveryMarkComplete")}
									</TooltipContent>
								</Tooltip>
							)}

						{isActive && mayComplete && (
							<Button
								size="sm"
								variant="ghost"
								className="h-7 text-xs"
								disabled={cancelMutation.isPending}
								onClick={() => cancelMutation.mutate(latest.id)}
							>
								{t("panel.cancelRun")}
							</Button>
						)}
					</>
				)}
			</div>

			{latest?.error && (
				<output className="mt-1.5 block text-destructive">
					{latest.error}
				</output>
			)}

			{questions.length > 0 && (
				<div className="mt-2">
					<p className="mb-1 inline-flex items-center gap-1.5 font-medium text-foreground">
						<MessageSquareIcon
							className="size-3.5"
							aria-hidden="true"
						/>
						{t("panel.openQuestions", { count: questions.length })}
					</p>
					<ul className="space-y-1.5">
						{questions.map((question) => {
							const why = whyText(question.content);
							return (
								<li
									key={question.id}
									className="rounded-md border border-border/70 bg-card px-3 py-2"
								>
									<p className="text-foreground">
										<span>
											{questionText(question.content)}
										</span>
										{question.blocking && (
											<Badge
												variant="outline"
												className="ml-2 border-destructive/30 bg-destructive/10 text-[10px] text-destructive"
											>
												{t("panel.blocking")}
											</Badge>
										)}
									</p>
									{why && (
										<p className="mt-0.5 text-muted-foreground">
											{t("panel.whyItMatters")}: {why}
										</p>
									)}
								</li>
							);
						})}
					</ul>
				</div>
			)}
		</section>
	);
}
