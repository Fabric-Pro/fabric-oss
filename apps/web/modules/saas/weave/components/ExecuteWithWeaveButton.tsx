"use client";

/**
 * ExecuteWithWeaveButton - Entry point for fabric-weave multi-agent orchestration
 *
 * This button appears on Story and Task pages, allowing users to:
 * 1. Create a weave plan via Loom
 * 2. View real-time execution via Tapestry
 * 3. Approve checkpoints during execution
 */

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { cn } from "@ui/lib";
import { ActivityIcon, ListTodoIcon, PlayIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CreatePlanForm } from "./CreatePlanForm";
import { WeaveExecutionMonitor } from "./WeaveExecutionMonitor";
import { WeavePlanList } from "./WeavePlanList";

interface ExecuteWithWeaveButtonProps {
	/** Project ID */
	projectId: string;
	implementationDefaultProvider?: "BACKGROUND_AGENTS" | "KANBAN_LOCAL" | null;
	/** Story ID (optional - can create plan for entire story) */
	storyId?: string;
	/** Task ID (optional - can create plan for specific task) */
	taskId?: string;
	/** Button variant */
	variant?: "default" | "outline" | "ghost";
	/** Button size */
	size?: "default" | "sm" | "lg";
	/** Repository URL for execution */
	repoUrl?: string;
	/** Additional CSS classes */
	className?: string;
	/** Controlled open state — when provided, parent manages dialog visibility */
	open?: boolean;
	/** Callback when dialog open state changes */
	onOpenChange?: (open: boolean) => void;
	/** Hide the trigger button (useful when parent controls open state) */
	hideTrigger?: boolean;
	/** Story context for creating a plan from feature data */
	storyContext?: {
		title: string;
		description?: string;
		acceptanceCriteria?: string;
	};
}

export function ExecuteWithWeaveButton({
	projectId,
	implementationDefaultProvider: _implementationDefaultProvider,
	storyId,
	taskId,
	repoUrl,
	variant = "default",
	size = "default",
	className,
	open: controlledOpen,
	onOpenChange: controlledOnOpenChange,
	hideTrigger = false,
	storyContext,
}: ExecuteWithWeaveButtonProps) {
	const [internalOpen, setInternalOpen] = useState(false);
	const isOpen = controlledOpen ?? internalOpen;
	const setIsOpen = controlledOnOpenChange ?? setInternalOpen;
	const [activeTab, setActiveTab] = useState("plans");
	const [pendingPlanId, setPendingPlanId] = useState<string | undefined>(
		undefined,
	);
	const [activeExecutionId, setActiveExecutionId] = useState<
		string | undefined
	>(undefined);
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();

	// Fetch weave plans for this project
	const { data: plansData, isLoading: isLoadingPlans } = useQuery({
		queryKey: ["weave-plans", projectId, organizationId],
		queryFn: async () => {
			return await orpcClient.weave.plans.list({
				projectId,
				organizationId: organizationId ?? null,
				limit: 10,
			});
		},
		enabled: isOpen,
	});

	// Poll for plan progress while Pattern is generating
	const { data: pendingPlanData } = useQuery({
		queryKey: ["weave-plan-progress", pendingPlanId],
		queryFn: async () => {
			if (!pendingPlanId) {
				return null;
			}
			return await orpcClient.weave.plans.get({
				planId: pendingPlanId,
				organizationId: organizationId ?? null,
			});
		},
		enabled: !!pendingPlanId,
		refetchInterval: pendingPlanId ? 2000 : false,
	});

	// Stop polling when plan leaves DRAFT status
	useEffect(() => {
		if (
			pendingPlanId &&
			pendingPlanData &&
			pendingPlanData.status !== "DRAFT"
		) {
			setPendingPlanId(undefined);
			queryClient.invalidateQueries({
				queryKey: ["weave-plans", projectId, organizationId],
			});
			if (pendingPlanData.status === "PENDING_APPROVAL") {
				toast.success("Plan ready for review!");
			} else if (pendingPlanData.status === "FAILED") {
				toast.error("Plan generation failed", {
					description: pendingPlanData.description ?? undefined,
				});
			}
		}
	}, [
		pendingPlanId,
		pendingPlanData,
		queryClient,
		projectId,
		organizationId,
	]);

	// Create plan mutation — returns immediately, Pattern runs async
	const createPlanMutation = useMutation({
		mutationFn: async (input: {
			name: string;
			description?: string;
			message: string;
			taskId?: string;
		}) => {
			return await orpcClient.weave.plans.create({
				projectId,
				organizationId: organizationId ?? null,
				userStoryId: storyId,
				storyTaskId: input.taskId,
				name: input.name,
				description: input.description,
				message: input.message,
			});
		},
		onSuccess: (data) => {
			setPendingPlanId(data.planId);
			setActiveTab("plans");
		},
		onError: (error) => {
			toast.error(`Failed to create plan: ${error.message}`);
		},
	});

	// Derive the running execution from plans data — always show the latest running one
	const runningExecutionId = (() => {
		if (!plansData?.plans) {
			return undefined;
		}
		for (const plan of plansData.plans) {
			const running = plan.executions?.find((e) =>
				["RUNNING", "PAUSED", "CHECKPOINT"].includes(e.status),
			);
			if (running) {
				return running.id;
			}
		}
		return undefined;
	})();

	// Auto-switch to monitor tab when a running execution is detected
	useEffect(() => {
		if (
			isOpen &&
			runningExecutionId &&
			activeExecutionId !== runningExecutionId
		) {
			setActiveExecutionId(runningExecutionId);
			setActiveTab("monitor");
		}
	}, [isOpen, runningExecutionId, activeExecutionId]);

	const isGeneratingPlan = createPlanMutation.isPending || !!pendingPlanId;

	const planProgress = isGeneratingPlan
		? pendingPlanData?.description?.startsWith("[")
			? pendingPlanData.description.slice(1, -1)
			: createPlanMutation.isPending
				? "Creating plan..."
				: "Initializing Pattern agent..."
		: undefined;

	return (
		<>
			{!hideTrigger && (
				<Button
					variant={variant}
					size={size}
					className={cn("gap-2", className)}
					onClick={() => setIsOpen(true)}
				>
					<FabricLogo size={16} />
					<span>Execute with Weave</span>
				</Button>
			)}

			<Dialog open={isOpen} onOpenChange={setIsOpen}>
				<DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden flex flex-col">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<FabricLogo size={20} className="text-primary" />
							<span>Fabric Weave</span>
							<span className="text-sm font-normal text-muted-foreground">
								Plan first, then choose how implementation
								should be delegated
							</span>
						</DialogTitle>
					</DialogHeader>

					<Tabs
						value={activeTab}
						onValueChange={setActiveTab}
						className="flex-1 flex flex-col overflow-hidden"
					>
						<TabsList className="grid w-full grid-cols-3">
							<TabsTrigger value="plans" className="gap-2">
								<ListTodoIcon className="size-4" />
								<span>Plans</span>
							</TabsTrigger>
							<TabsTrigger value="monitor" className="gap-2">
								<ActivityIcon className="size-4" />
								<span>Monitor</span>
							</TabsTrigger>
							<TabsTrigger value="create" className="gap-2">
								<PlayIcon className="size-4" />
								<span>New Plan</span>
							</TabsTrigger>
						</TabsList>

						<div className="flex-1 overflow-hidden mt-4 flex flex-col">
							<TabsContent
								value="plans"
								className="flex-1 mt-0 overflow-hidden"
							>
								<WeavePlanList
									plans={plansData?.plans || []}
									isLoading={isLoadingPlans}
									preferredLocalProvider="KANBAN_LOCAL"
									isGenerating={isGeneratingPlan}
									planProgress={planProgress}
									repoUrl={repoUrl}
									highlightPlanId={pendingPlanId}
									storyContext={storyContext}
									onCreateFromFeature={
										storyContext
											? () => {
													const parts = [
														storyContext.description,
														storyContext.acceptanceCriteria,
													].filter(Boolean);
													const message =
														parts.length > 0
															? `Implement feature: ${storyContext.title}\n\n${parts.join("\n\n")}`
															: `Implement feature: ${storyContext.title}`;
													createPlanMutation.mutate({
														name: storyContext.title.slice(
															0,
															100,
														),
														description:
															storyContext.description,
														message,
													});
												}
											: undefined
									}
									onPlanGenerationStarted={(planId) =>
										setPendingPlanId(planId)
									}
									onSelectExecution={(executionId) => {
										setActiveExecutionId(executionId);
										setActiveTab("monitor");
									}}
								/>
							</TabsContent>

							<TabsContent
								value="monitor"
								className="flex-1 mt-0 overflow-hidden"
							>
								<WeaveExecutionMonitor
									projectId={projectId}
									storyId={storyId}
									executionId={
										activeExecutionId ?? runningExecutionId
									}
								/>
							</TabsContent>

							<TabsContent
								value="create"
								className="flex-1 mt-0 overflow-hidden"
							>
								<CreatePlanForm
									projectId={projectId}
									onSubmit={(data) =>
										createPlanMutation.mutate({
											...data,
											taskId,
										})
									}
									isSubmitting={createPlanMutation.isPending}
									storyId={storyId}
									taskId={taskId}
								/>
							</TabsContent>
						</div>
					</Tabs>
				</DialogContent>
			</Dialog>
		</>
	);
}
