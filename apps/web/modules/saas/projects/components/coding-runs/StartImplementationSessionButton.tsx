"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { CodeIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ComponentProps, useState } from "react";
import { toast } from "sonner";
import { orpcClient } from "../../../../shared/lib/orpc-client";
import {
	type ExecutionChannel,
	type ExecutionProvider,
	getExecutionProviderLabel,
	getExecutionProviderPlatformLabel,
	getImplementationRecommendation,
} from "../../lib/implementation-session-labels";
import type { UserStory } from "../../lib/stories/types";
import { RemoteAgentServerPicker } from "./RemoteAgentServerPicker";
import {
	type StartCodingRunConfirmOptions,
	StartCodingRunDialog,
} from "./StartCodingRunDialog";

interface StartImplementationSessionButtonProps {
	projectId: string;
	story: UserStory;
	repositoryOwner?: string | null;
	repositoryName?: string | null;
	defaultBranch?: string | null;
	implementationDefaultChannel?: ExecutionChannel | null;
	implementationDefaultProvider?: ExecutionProvider | null;
	variant?: ComponentProps<typeof Button>["variant"];
	size?: ComponentProps<typeof Button>["size"];
	className?: string;
	label?: string;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	hideTrigger?: boolean;
	focusedTaskId?: string | null;
	onBeforeStart?: () => Promise<void>;
	onStarted?: (codingRunId: string) => void;
	initialExecutionChannel?: ExecutionChannel;
	initialExecutionProvider?: ExecutionProvider;
}

export function StartImplementationSessionButton({
	projectId,
	story,
	repositoryOwner,
	repositoryName,
	defaultBranch,
	implementationDefaultChannel,
	implementationDefaultProvider,
	variant = "default",
	size = "sm",
	className,
	label = "Start Implementation Session",
	open: controlledOpen,
	onOpenChange: controlledOnOpenChange,
	hideTrigger = false,
	focusedTaskId = null,
	onBeforeStart,
	onStarted,
	initialExecutionProvider,
}: StartImplementationSessionButtonProps) {
	const queryClient = useQueryClient();
	const t = useTranslations("projects.remoteAgents");
	const { organizationId } = useOrganizationContext();
	const [internalOpen, setInternalOpen] = useState(false);
	const isOpen = controlledOpen ?? internalOpen;
	const setIsOpen = controlledOnOpenChange ?? setInternalOpen;

	const hasRepositoryContext = !!repositoryOwner && !!repositoryName;
	const recommendation = getImplementationRecommendation({
		hasRepositoryContext,
		openTaskCount: story.tasks.filter((task) => !task.isCompleted).length,
		focusedTaskId,
		implementationDefaultChannel,
		implementationDefaultProvider,
	});

	// Effective provider: caller-specified overrides project default which overrides recommendation
	const effectiveProvider =
		initialExecutionProvider ?? recommendation.provider;
	const isKanbanLocal = effectiveProvider === "KANBAN_LOCAL";
	const [serverId, setServerId] = useState("");
	const servers = useQuery({
		queryKey: ["remoteAgentServers", projectId, organizationId],
		gcTime: 0,
		queryFn: () =>
			orpcClient.codingRuns.remoteServers.list({
				projectId,
				organizationId,
			}),
		enabled: isOpen && !isKanbanLocal,
		retry: false,
	});
	const selectedServerId = servers.data?.servers.some(
		(server) => server.id === serverId,
	)
		? serverId
		: undefined;

	const invalidateStoryQueries = async () => {
		await Promise.all([
			queryClient.invalidateQueries({
				queryKey: orpc.projects.stories.list.queryKey({
					input: { projectId, organizationId },
				}),
			}),
			queryClient.invalidateQueries({
				queryKey: orpc.projects.stories.get.queryKey({
					input: { projectId, storyId: story.id, organizationId },
				}),
			}),
		]);
	};

	const queueMutation = useMutation({
		mutationFn: async () => {
			await onBeforeStart?.();
			return await orpcClient.projects.stories.queueForKanban({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: async () => {
			await invalidateStoryQueries();
			toast.success(
				`Queued for ${getExecutionProviderLabel("KANBAN_LOCAL")}`,
				{
					description: `Run fabric-kanban in your repository to pull queued items from ${getExecutionProviderPlatformLabel("KANBAN_LOCAL")}.`,
				},
			);
		},
		onError: (error) => {
			toast.error(
				`Failed to queue for ${getExecutionProviderLabel("KANBAN_LOCAL")}`,
				{
					description: error.message,
				},
			);
		},
	});

	const startMutation = useMutation({
		mutationFn: async (options?: StartCodingRunConfirmOptions) => {
			const effectiveTaskId =
				options && "taskId" in options
					? (options.taskId ?? undefined)
					: (focusedTaskId ?? undefined);
			const selectedTask = story.tasks.find(
				(task) => task.id === effectiveTaskId,
			);
			const effectiveOwner =
				selectedTask?.repositoryOwner || repositoryOwner;
			const effectiveName =
				selectedTask?.repositoryName || repositoryName;
			if (!effectiveOwner || !effectiveName) {
				throw new Error(
					"Connect a project or task repository before starting a direct implementation session.",
				);
			}
			await onBeforeStart?.();
			return await orpcClient.codingRuns.start({
				projectId,
				storyId: story.id,
				taskId: effectiveTaskId,
				organizationId: organizationId ?? null,
				executionChannel: "BACKGROUND_AGENTS",
				provider: "BACKGROUND_AGENTS",
				...(options?.serverId ? { serverId: options.serverId } : {}),
				...(options?.llmConnection
					? { llmConnection: options.llmConnection }
					: {}),
			});
		},
		onSuccess: async (result) => {
			await invalidateStoryQueries();
			toast.success("Implementation session started");
			setIsOpen(false);
			onStarted?.(result.codingRunId);
		},
		onError: (error) => {
			toast.error("Failed to start implementation session", {
				description: error.message,
			});
		},
	});

	const handleButtonClick = () => {
		if (isKanbanLocal) {
			queueMutation.mutate();
		} else {
			setIsOpen(true);
		}
	};

	return (
		<>
			{!hideTrigger && (
				<Button
					variant={variant}
					size={size}
					className={className}
					onClick={handleButtonClick}
					disabled={queueMutation.isPending}
				>
					<CodeIcon className="mr-2 size-4" />
					{label}
				</Button>
			)}

			<StartCodingRunDialog
				open={isOpen}
				onOpenChange={setIsOpen}
				story={story}
				repositoryOwner={repositoryOwner ?? undefined}
				repositoryName={repositoryName ?? undefined}
				defaultBranch={defaultBranch ?? "main"}
				isLoading={startMutation.isPending}
				onConfirm={(options) => startMutation.mutate(options)}
				focusedTaskId={focusedTaskId}
				serverId={selectedServerId}
				serverRequired={servers.data?.enabled === true}
				serverLoading={servers.isPending || servers.isError}
				serverPicker={
					servers.isPending ? (
						<output>{t("loadingServers")}</output>
					) : servers.isError ? (
						<div role="alert" className="space-y-2">
							<p className="text-sm text-destructive">
								{t("loadServersFailed")}
							</p>
							<Button
								variant="outline"
								type="button"
								onClick={() => servers.refetch()}
							>
								{t("retry")}
							</Button>
						</div>
					) : servers.data?.enabled ? (
						<RemoteAgentServerPicker
							projectId={projectId}
							organizationId={organizationId}
							servers={servers.data.servers}
							canShare={servers.data.canShare}
							value={selectedServerId ?? ""}
							onChange={setServerId}
						/>
					) : undefined
				}
			/>
		</>
	);
}
