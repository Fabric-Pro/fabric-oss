"use client";

/**
 * WeaveDashboard - Full weave management view for a project
 *
 * Provides:
 * - Create Plan tab: form to generate new weave plans via Pattern
 * - Plans tab: list of plans with approve/revise/execute/edit actions
 * - Monitor tab: real-time execution monitoring via SSE
 */

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { ActivityIcon, ListTodoIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ProjectSectionHero } from "../../projects/components/ProjectSectionHero";
import { CreatePlanForm } from "./CreatePlanForm";
import { WeaveExecutionMonitor } from "./WeaveExecutionMonitor";
import { WeavePlanList } from "./WeavePlanList";

interface WeaveDashboardProps {
	projectId: string;
	repoUrl?: string;
}

export function WeaveDashboard({
	projectId,
	repoUrl: propRepoUrl,
}: WeaveDashboardProps) {
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();

	const [activeTab, setActiveTab] = useState("plans");
	const [activeExecutionId, setActiveExecutionId] = useState<
		string | undefined
	>(undefined);
	const [pendingPlanId, setPendingPlanId] = useState<string | undefined>(
		undefined,
	);
	const [selectedStoryId, setSelectedStoryId] = useState<string | undefined>(
		undefined,
	);

	// Fetch the project to get repositoryUrl if not passed as prop
	const { data: projectData } = useQuery({
		queryKey: ["project", projectId],
		queryFn: async () => {
			return await orpcClient.projects.get({
				id: projectId,
				organizationId: organizationId ?? null,
			});
		},
	});

	const repoUrl =
		propRepoUrl || (projectData as any)?.project?.repositoryUrl || "";

	// Fetch features (user stories) for linking plans
	const { data: storiesData } = useQuery(
		orpc.projects.stories.list.queryOptions({
			input: { projectId, organizationId: organizationId ?? null },
		}),
	);

	// Fetch plans
	const { data: plansData, isLoading: isLoadingPlans } = useQuery({
		queryKey: ["weave-plans", projectId, organizationId],
		queryFn: async () => {
			return await orpcClient.weave.plans.list({
				projectId,
				organizationId: organizationId ?? null,
				limit: 50,
			});
		},
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
			setActiveTab("plans");
		}
	}

	const planProgress = pendingPlanId
		? pendingPlanData?.description?.startsWith("[")
			? pendingPlanData.description.slice(1, -1)
			: "Generating plan with Pattern agent..."
		: undefined;

	// Create plan mutation
	const createPlanMutation = useMutation({
		mutationFn: async (input: {
			name: string;
			description?: string;
			message: string;
		}) => {
			return await orpcClient.weave.plans.create({
				projectId,
				organizationId: organizationId ?? null,
				userStoryId: selectedStoryId,
				name: input.name,
				description: input.description,
				message: input.message,
			});
		},
		onSuccess: (data) => {
			setPendingPlanId(data.planId);
			toast.info(
				"Plan creation started — Pattern is analyzing your request.",
			);
			setActiveTab("plans");
		},
		onError: (error) => {
			toast.error(`Failed to create plan: ${error.message}`);
		},
	});

	const stories = storiesData?.stories || [];
	const plans = plansData?.plans || [];
	const planStats = {
		total: plans.length,
		pendingApproval: plans.filter(
			(p: any) => p.status === "PENDING_APPROVAL",
		).length,
		running: plans
			.flatMap((p: any) => p.executions || [])
			.filter((e: any) => e.status === "RUNNING").length,
	};

	return (
		<div className="space-y-6">
			<ProjectSectionHero
				eyebrow="Fabric Weave"
				getStartedPageId="weave"
				title="Multi-agent orchestration"
				description="Create execution plans, delegate to specialized agents, and track multi-step workflows with approval checkpoints."
				badges={
					<>
						<div className="rounded-full border border-border/60 bg-background/50 px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-muted-foreground">
							{planStats.total} plan
							{planStats.total !== 1 ? "s" : ""}
						</div>
						{planStats.pendingApproval > 0 && (
							<div className="rounded-full border border-yellow-500/30 bg-yellow-500/10 px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-yellow-600">
								{planStats.pendingApproval} awaiting review
							</div>
						)}
						{planStats.running > 0 && (
							<div className="rounded-full border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-purple-600">
								{planStats.running} running
							</div>
						)}
					</>
				}
				aside={
					<div className="flex h-full flex-col justify-between">
						<div>
							<p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
								Quick Start
							</p>
							<div className="mt-4 grid grid-cols-3 gap-3">
								<div className="rounded-2xl border border-border/60 bg-background/50 p-3 text-center">
									<p className="text-2xl font-semibold tabular-nums text-foreground">
										{planStats.total}
									</p>
									<p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
										Plans
									</p>
								</div>
								<div className="rounded-2xl border border-border/60 bg-background/50 p-3 text-center">
									<p className="text-2xl font-semibold tabular-nums text-primary">
										{planStats.running}
									</p>
									<p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
										Running
									</p>
								</div>
								<div className="rounded-2xl border border-border/60 bg-background/50 p-3 text-center">
									<p className="text-2xl font-semibold tabular-nums text-yellow-600">
										{planStats.pendingApproval}
									</p>
									<p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
										To Review
									</p>
								</div>
							</div>
						</div>
						<div className="mt-6 rounded-2xl border border-border/60 bg-card/40 p-4">
							<p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
								How it works
							</p>
							<p className="mt-2 text-sm text-foreground/85">
								Create a plan describing your task. Pattern
								generates steps assigned to specialized agents.
								Review, approve, and execute.
							</p>
						</div>
					</div>
				}
			/>

			{/* Progress banner when Pattern is generating */}
			{planProgress && (
				<div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-primary/5 border border-primary/20 text-sm">
					<ActivityIcon className="size-4 text-primary animate-pulse" />
					<span className="text-primary font-medium">
						{planProgress}
					</span>
				</div>
			)}

			<Tabs
				value={activeTab}
				onValueChange={setActiveTab}
				className="space-y-4"
			>
				<TabsList data-onboarding-target="weave-tabs">
					<TabsTrigger value="plans" className="gap-2">
						<ListTodoIcon className="size-4" />
						Plans
						{planStats.pendingApproval > 0 && (
							<span className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-yellow-500/20 text-[10px] font-medium text-yellow-600">
								{planStats.pendingApproval}
							</span>
						)}
					</TabsTrigger>
					<TabsTrigger value="monitor" className="gap-2">
						<ActivityIcon className="size-4" />
						Monitor
					</TabsTrigger>
					<TabsTrigger
						value="create"
						className="gap-2"
						data-onboarding-target="weave-new-plan"
					>
						<PlusIcon className="size-4" />
						New Plan
					</TabsTrigger>
				</TabsList>

				<TabsContent value="plans">
					<div
						data-onboarding-target="weave-plan-list"
						className="min-h-[400px]"
					>
						<WeavePlanList
							plans={plans}
							isLoading={isLoadingPlans}
							repoUrl={repoUrl}
							onSelectExecution={(executionId) => {
								setActiveExecutionId(executionId);
								setActiveTab("monitor");
							}}
						/>
					</div>
				</TabsContent>

				<TabsContent value="monitor">
					<div className="min-h-[400px]">
						<WeaveExecutionMonitor
							projectId={projectId}
							executionId={activeExecutionId}
						/>
					</div>
				</TabsContent>

				<TabsContent value="create">
					<div className="max-w-2xl space-y-4">
						{stories.length > 0 && (
							<div className="space-y-2">
								<Label htmlFor="feature-select">
									Link to Feature (optional)
								</Label>
								<Select
									value={selectedStoryId ?? "none"}
									onValueChange={(v) =>
										setSelectedStoryId(
											v === "none" ? undefined : v,
										)
									}
								>
									<SelectTrigger id="feature-select">
										<SelectValue placeholder="No feature selected" />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="none">
											No feature — standalone plan
										</SelectItem>
										{stories.map((story: any) => (
											<SelectItem
												key={story.id}
												value={story.id}
											>
												{story.identifier
													? `${story.identifier} — `
													: ""}
												{story.title}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<p className="text-xs text-muted-foreground">
									Linking to a feature gives Pattern more
									context and tracks which plans belong to
									which features. Standalone plans are a good
									fit for local development; link a feature
									first if you want to use Background Agents.
								</p>
							</div>
						)}
						<CreatePlanForm
							projectId={projectId}
							onSubmit={(data) => createPlanMutation.mutate(data)}
							isSubmitting={createPlanMutation.isPending}
						/>
					</div>
				</TabsContent>
			</Tabs>
		</div>
	);
}
