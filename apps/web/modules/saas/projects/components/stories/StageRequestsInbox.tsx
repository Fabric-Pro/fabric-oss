"use client";

/**
 * StageRequestsInbox
 *
 * Side drawer listing PENDING drafting-stage transition requests for a
 * GOVERNED project (plan Slice 5). Each row shows the feature, the
 * from → to stages, who asked and how long ago, with Approve / Reject and an
 * optional note. The server enforces STORY_STAGE_APPROVE, approver
 * membership and requester ≠ approver; this UI only surfaces the outcome.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	ArrowRightIcon,
	CheckIcon,
	InboxIcon,
	Loader2Icon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import type { FeatureDraftingStage } from "../../lib/stories/types";
import { DRAFTING_STAGE_META } from "../../lib/stories/types";
import { DraftingStageIndicator } from "./DraftingStageIndicator";
import { invalidateStoryReadiness } from "./useStoryReadiness";

type Props = {
	projectId: string;
	organizationId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

export type StageRequestRow = {
	id: string;
	storyId: string;
	fromStage: FeatureDraftingStage;
	toStage: FeatureDraftingStage;
	reason: string;
	status: "PENDING" | "APPROVED" | "REJECTED" | "SUPERSEDED";
	createdAt: string | Date;
	story: { id: string; identifier: string; title: string };
	requestedBy: { id: string; name: string | null; email: string };
};

const STAGE_REQUESTS_QUERY_KEY = "stage-transition-requests" as const;

function stageRequestsQueryKey(
	projectId: string,
	organizationId: string | null,
) {
	return [STAGE_REQUESTS_QUERY_KEY, projectId, organizationId] as const;
}

export function usePendingStageRequests(
	projectId: string,
	organizationId: string | null,
	enabled = true,
) {
	return useQuery({
		queryKey: stageRequestsQueryKey(projectId, organizationId),
		queryFn: async () => {
			const result = await orpcClient.projects.stories.listStageRequests({
				projectId,
				organizationId,
				status: "PENDING",
			});
			return (result as { requests: StageRequestRow[] }).requests;
		},
		enabled,
		refetchInterval: 30_000,
		refetchOnWindowFocus: true,
	});
}

function stageLabel(stage: FeatureDraftingStage): string {
	return DRAFTING_STAGE_META[stage]?.label ?? stage;
}

export function StageRequestsInbox({
	projectId,
	organizationId,
	open,
	onOpenChange,
}: Props) {
	const t = useTranslations("projects.stories.readiness.stageRequests");
	const queryClient = useQueryClient();
	const { data: requests = [], isPending } = usePendingStageRequests(
		projectId,
		organizationId,
		open,
	);
	const [notes, setNotes] = useState<Record<string, string>>({});
	const [busyId, setBusyId] = useState<string | null>(null);

	const invalidateAfterReview = async (storyId: string) => {
		await Promise.all([
			queryClient.invalidateQueries({
				queryKey: stageRequestsQueryKey(projectId, organizationId),
			}),
			queryClient.invalidateQueries({
				queryKey: orpc.projects.stories.list.queryKey({
					input: { projectId, organizationId },
				}),
			}),
			queryClient.invalidateQueries({
				queryKey: orpc.projects.stories.get.queryKey({
					input: { projectId, storyId, organizationId },
				}),
			}),
			invalidateStoryReadiness(queryClient, { projectId, storyId }),
		]);
	};

	const reviewMutation = useMutation({
		mutationFn: async (vars: {
			action: "approve" | "reject";
			request: StageRequestRow;
		}) => {
			const input = {
				projectId,
				requestId: vars.request.id,
				organizationId,
				note: notes[vars.request.id]?.trim() || undefined,
			};
			return vars.action === "approve"
				? await orpcClient.projects.stories.approveStageRequest(input)
				: await orpcClient.projects.stories.rejectStageRequest(input);
		},
		onMutate: (vars) => setBusyId(vars.request.id),
		onSuccess: async (_data, vars) => {
			toast.success(
				vars.action === "approve" ? t("approved") : t("rejected"),
				{ description: vars.request.story.identifier },
			);
			setNotes((prev) => {
				const next = { ...prev };
				delete next[vars.request.id];
				return next;
			});
			await invalidateAfterReview(vars.request.storyId);
		},
		onError: (error, vars) => {
			toast.error(
				vars.action === "approve"
					? t("approveFailed")
					: t("rejectFailed"),
				{
					description:
						error instanceof Error ? error.message : String(error),
				},
			);
			// The request may have been reviewed or superseded concurrently.
			void queryClient.invalidateQueries({
				queryKey: stageRequestsQueryKey(projectId, organizationId),
			});
		},
		onSettled: () => setBusyId(null),
	});

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="flex w-full flex-col sm:max-w-xl">
				<SheetHeader>
					<SheetTitle className="font-serif text-2xl font-normal">
						{t("title")}
					</SheetTitle>
					<SheetDescription>{t("description")}</SheetDescription>
				</SheetHeader>

				<div className="mt-4 flex-1 overflow-y-auto">
					{isPending ? (
						<div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
							<Loader2Icon
								className="size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
							{t("loading")}
						</div>
					) : requests.length === 0 ? (
						<div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
							<InboxIcon className="size-6" aria-hidden="true" />
							{t("empty")}
						</div>
					) : (
						<ul className="space-y-3">
							{requests.map((request) => {
								const isBusy = busyId === request.id;
								const createdAt =
									typeof request.createdAt === "string"
										? new Date(request.createdAt)
										: request.createdAt;
								const requester =
									request.requestedBy.name ??
									request.requestedBy.email;
								return (
									<li
										key={request.id}
										className={cn(
											"rounded-lg border border-border/70 bg-card p-4",
											isBusy && "opacity-70",
										)}
									>
										<div className="flex items-start justify-between gap-3">
											<div className="min-w-0">
												<p className="truncate text-sm font-medium">
													<span className="font-mono text-xs text-muted-foreground">
														{
															request.story
																.identifier
														}
													</span>{" "}
													{request.story.title}
												</p>
												<p className="mt-1 text-xs text-muted-foreground">
													{t("requestedBy", {
														name: requester,
														age: formatDistanceToNow(
															createdAt,
															{ addSuffix: true },
														),
													})}
													{request.reason
														? ` · ${request.reason}`
														: null}
												</p>
											</div>
										</div>

										<div className="mt-3 flex items-center gap-2">
											<DraftingStageIndicator
												stage={request.fromStage}
												compact
											/>
											<ArrowRightIcon
												className="size-3.5 text-muted-foreground"
												aria-hidden="true"
											/>
											<DraftingStageIndicator
												stage={request.toStage}
												compact
											/>
											<span className="sr-only">
												{stageLabel(request.fromStage)}{" "}
												to {stageLabel(request.toStage)}
											</span>
										</div>

										<Textarea
											aria-label={t("noteLabel")}
											placeholder={t("notePlaceholder")}
											value={notes[request.id] ?? ""}
											onChange={(e) =>
												setNotes((prev) => ({
													...prev,
													[request.id]:
														e.target.value,
												}))
											}
											disabled={isBusy}
											rows={2}
											className="mt-3 text-sm"
										/>

										<div className="mt-3 flex justify-end gap-2">
											<Button
												variant="outline"
												size="sm"
												disabled={isBusy}
												onClick={() =>
													reviewMutation.mutate({
														action: "reject",
														request,
													})
												}
											>
												<XIcon
													className="mr-1.5 size-3.5"
													aria-hidden="true"
												/>
												{t("reject")}
											</Button>
											<Button
												size="sm"
												disabled={isBusy}
												onClick={() =>
													reviewMutation.mutate({
														action: "approve",
														request,
													})
												}
											>
												{isBusy ? (
													<Loader2Icon
														className="mr-1.5 size-3.5 motion-safe:animate-spin"
														aria-hidden="true"
													/>
												) : (
													<CheckIcon
														className="mr-1.5 size-3.5"
														aria-hidden="true"
													/>
												)}
												{t("approve")}
											</Button>
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
