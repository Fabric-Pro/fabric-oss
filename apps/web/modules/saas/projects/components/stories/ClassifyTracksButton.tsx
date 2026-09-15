"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Loader2Icon, WandSparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { orpcClient } from "../../../../shared/lib/orpc-client";

interface Props {
	projectId: string;
	/** Query key to invalidate when classification finishes. */
	storiesQueryKey: readonly unknown[];
	/** Restrict to these stories; omit for every unclassified story. */
	storyIds?: string[];
	disabled?: boolean;
}

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 6 * 60_000;

/**
 * Roadmap toolbar button that starts the delivery-track classifier and
 * polls its progress. Preflights the AI provider (`aiConfig.resolution
 * .getStatus`) so the user gets a clear message instead of a workflow
 * failure when no provider is configured.
 */
export function ClassifyTracksButton({
	projectId,
	storiesQueryKey,
	storyIds,
	disabled,
}: Props) {
	const t = useTranslations("projects.stories.deliveryTrack");
	const tTips = useTranslations("tooltips.stories");
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();
	const [workflowId, setWorkflowId] = useState<string | null>(null);
	const startedAtRef = useRef<number>(0);

	const { data: aiConfigStatus, isLoading: isLoadingAiConfig } = useQuery({
		queryKey: ["aiConfigStatus", organizationId],
		queryFn: async () =>
			await orpcClient.aiConfig.resolution.getStatus({
				organizationId,
			}),
		staleTime: 30_000,
	});
	const isAiNotConfigured =
		!isLoadingAiConfig &&
		aiConfigStatus !== undefined &&
		!aiConfigStatus.isConfigured;

	const startMutation = useMutation({
		mutationFn: async () =>
			await orpcClient.projects.stories.classifyTracks({
				projectId,
				organizationId: organizationId ?? null,
				storyIds,
			}),
		onSuccess: (data) => {
			startedAtRef.current = Date.now();
			setWorkflowId(data.workflowId);
			toast.info(t("classifyStarted"));
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : t("classifyFailed"),
			);
		},
	});

	// Poll progress until the workflow completes or fails.
	useEffect(() => {
		if (!workflowId) {
			return;
		}
		let cancelled = false;
		const timer = setInterval(async () => {
			if (cancelled) {
				return;
			}
			if (Date.now() - startedAtRef.current > POLL_TIMEOUT_MS) {
				setWorkflowId(null);
				toast.error(t("classifyTimeout"));
				return;
			}
			try {
				const progress =
					await orpcClient.projects.stories.classificationProgress({
						projectId,
						organizationId: organizationId ?? null,
						workflowId,
					});
				if (progress.status === "complete") {
					setWorkflowId(null);
					void queryClient.invalidateQueries({
						queryKey: storiesQueryKey,
					});
					toast.success(
						t("classifyComplete", { count: progress.classified }),
					);
				} else if (progress.status === "failed") {
					setWorkflowId(null);
					toast.error(progress.error ?? t("classifyFailed"));
				}
			} catch {
				// Transient — the next tick retries until the timeout.
			}
		}, POLL_INTERVAL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [
		workflowId,
		projectId,
		organizationId,
		queryClient,
		storiesQueryKey,
		t,
	]);

	const isRunning = workflowId !== null || startMutation.isPending;
	const isDisabled =
		disabled || isRunning || isLoadingAiConfig || isAiNotConfigured;

	const tooltip = isAiNotConfigured
		? t("aiNotConfigured")
		: `${t("classifyTooltip")} ${tTips("classifyConcept")}`;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="inline-flex">
					<Button
						variant="outline"
						size="sm"
						onClick={() => startMutation.mutate()}
						disabled={isDisabled}
						aria-busy={isRunning}
						className="gap-2"
					>
						{isRunning ? (
							<Loader2Icon
								className="size-4 motion-safe:animate-spin"
								aria-hidden="true"
							/>
						) : (
							<WandSparklesIcon
								className="size-4"
								aria-hidden="true"
							/>
						)}
						{isRunning ? t("classifying") : t("classify")}
					</Button>
				</span>
			</TooltipTrigger>
			<TooltipContent>{tooltip}</TooltipContent>
		</Tooltip>
	);
}
