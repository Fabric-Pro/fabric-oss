"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { ArrowLeftIcon, PanelRightCloseIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { workflowExecutionsKey } from "../lib/query-keys";
import type { WorkflowEdge, WorkflowNode } from "../lib/types";
import { ExecutionPanel } from "./ExecutionPanel";
import {
	ValidationErrorsPanel,
	type ValidationResult,
} from "./ValidationErrorsPanel";
import { WorkflowBuilder } from "./WorkflowBuilder";
import { WorkflowErrorBoundary } from "./WorkflowErrorBoundary";
import { WorkflowRunHistory } from "./WorkflowRunHistory";

interface WorkflowEditorProps {
	workflowId: string;
}

export function WorkflowEditor({ workflowId }: WorkflowEditorProps) {
	const queryClient = useQueryClient();
	const { organizationId, basePath } = useOrganizationContext();
	const [showExecutionPanel, setShowExecutionPanel] = useState(false);
	const [showRunHistory, setShowRunHistory] = useState(true);
	const [currentExecutionId, setCurrentExecutionId] = useState<string | null>(
		null,
	);
	const [recentlyStartedExecutionId, setRecentlyStartedExecutionId] =
		useState<string | null>(null);
	// Pre-flight validation errors from API
	const [validationResult, setValidationResult] =
		useState<ValidationResult | null>(null);
	const [isPhoneViewport, setIsPhoneViewport] = useState(false);

	// Fetch workflow data
	const { data, isLoading, error } = useQuery(
		orpc.workflows.get.queryOptions({
			input: { id: workflowId, organizationId },
		}),
	);

	// Update mutation
	const updateMutation = useMutation(
		orpc.workflows.update.mutationOptions({
			onSuccess: () => {
				toast.success("Workflow saved");
			},
			onError: (_error) => {
				toast.error("Failed to save workflow");
			},
		}),
	);

	// Execute mutation
	const executeMutation = useMutation(
		orpc.workflows.executions.start.mutationOptions({
			onSuccess: (result) => {
				// Clear any previous validation errors on success
				setValidationResult(null);
				// A resolved mutation is not a started run: when the engine
				// refuses the run the procedure records the execution FAILED
				// and says so here. Show the panel either way so the failed
				// run is inspectable rather than invisible.
				if (result.status === "failed") {
					toast.error(
						result.message ?? "Failed to start workflow execution",
					);
				} else {
					toast.success("Workflow execution started");
				}
				setCurrentExecutionId(result.execution.id);
				setShowExecutionPanel(true);
				setRecentlyStartedExecutionId(result.execution.id);
			},
			onError: (error) => {
				// Check if the error message contains validation info
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				if (errorMessage.includes("Workflow validation failed")) {
					// Parse validation errors from the message
					const errors = errorMessage
						.replace("Workflow validation failed: ", "")
						.split("; ");
					setValidationResult({
						valid: false,
						errors,
						warnings: [],
					});
					toast.error("Pre-flight validation failed");
				} else {
					toast.error("Failed to start workflow execution");
				}
			},
		}),
	);

	// Handle save
	const handleSave = useCallback(
		(nodes: WorkflowNode[], edges: WorkflowEdge[]) => {
			updateMutation.mutate({
				id: workflowId,
				organizationId,
				nodes: nodes as unknown[],
				edges: edges as unknown[],
			});
		},
		[workflowId, organizationId, updateMutation],
	);

	// Handle run - pass current nodes/edges to execute with unsaved changes
	const handleRun = useCallback(
		(nodes: WorkflowNode[], edges: WorkflowEdge[]) => {
			executeMutation.mutate({
				id: workflowId,
				organizationId,
				// Pass current nodes/edges so execution uses latest state
				nodes: nodes as unknown[],
				edges: edges as unknown[],
			});
		},
		[workflowId, organizationId, executeMutation],
	);

	// Handle name change
	const handleNameChange = useCallback(
		(name: string) => {
			updateMutation.mutate({
				id: workflowId,
				organizationId,
				name,
			});
		},
		[workflowId, organizationId, updateMutation],
	);

	// Invalidate executions query when a new execution is started
	// This hook must be before early returns to follow Rules of Hooks
	const workflow = data?.workflow;
	useEffect(() => {
		if (!recentlyStartedExecutionId || !workflow) {
			return;
		}

		queryClient.invalidateQueries({
			queryKey: workflowExecutionsKey(workflowId, organizationId),
		});

		setRecentlyStartedExecutionId(null);
	}, [
		recentlyStartedExecutionId,
		queryClient,
		workflowId,
		organizationId,
		workflow,
	]);

	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}

		const mediaQuery = window.matchMedia("(max-width: 767px)");
		const handleViewportChange = (event: MediaQueryListEvent) => {
			setIsPhoneViewport(event.matches);
		};

		setIsPhoneViewport(mediaQuery.matches);

		if (typeof mediaQuery.addEventListener === "function") {
			mediaQuery.addEventListener("change", handleViewportChange);
			return () => {
				mediaQuery.removeEventListener("change", handleViewportChange);
			};
		}

		mediaQuery.addListener(handleViewportChange);
		return () => {
			mediaQuery.removeListener(handleViewportChange);
		};
	}, []);

	if (isLoading) {
		return (
			<div className="flex-1 flex items-center justify-center">
				<Spinner className="h-8 w-8" />
			</div>
		);
	}

	if (error || !workflow) {
		return (
			<div className="flex-1 flex flex-col items-center justify-center gap-4">
				<p className="text-muted-foreground">Workflow not found</p>
				<Button asChild variant="outline">
					<Link href={`${basePath}/workflows`}>
						<ArrowLeftIcon className="h-4 w-4 mr-2" />
						Back to Workflows
					</Link>
				</Button>
			</div>
		);
	}

	if (isPhoneViewport) {
		return (
			<div className="flex-1 p-4 sm:p-6">
				<Card className="mx-auto max-w-lg space-y-4 p-4 sm:p-6">
					<h2 className="text-lg font-semibold">Workflow Editor</h2>
					<p className="text-sm text-muted-foreground">
						The drag-and-drop workflow canvas is currently optimized
						for desktop and tablets. On phones, you can still view
						workflows from the list and continue editing on a larger
						screen.
					</p>
					<div className="flex flex-col gap-2 sm:flex-row">
						<Button
							asChild
							className="w-full sm:w-auto"
							variant="outline"
						>
							<Link href={`${basePath}/workflows`}>
								<ArrowLeftIcon className="mr-2 h-4 w-4" />
								Back to Workflows
							</Link>
						</Button>
						<Button asChild className="w-full sm:w-auto">
							<Link href={`${basePath}/settings/integrations`}>
								Manage Integrations
							</Link>
						</Button>
					</div>
				</Card>
			</div>
		);
	}

	// Workflow stores nodes and edges as separate JSON fields
	const nodes = (workflow.nodes as WorkflowNode[] | null) ?? [];
	const edges = (workflow.edges as WorkflowEdge[] | null) ?? [];

	return (
		<div className="flex-1 flex flex-col min-h-0">
			{/* Pre-flight Validation Errors Panel */}
			{validationResult && !validationResult.valid && (
				<ValidationErrorsPanel
					validation={validationResult}
					onDismiss={() => setValidationResult(null)}
					className="mx-auto mt-4"
				/>
			)}

			{/* Main content area */}
			<div className="flex-1 flex flex-col lg:flex-row relative min-h-0">
				{showRunHistory && (
					<div className="w-full lg:w-80 xl:w-96 border-b lg:border-b-0 lg:border-r bg-background flex flex-col min-h-0">
						<WorkflowRunHistory
							workflowId={workflowId}
							organizationId={organizationId}
							selectedExecutionId={currentExecutionId}
							onSelectExecution={(executionId) => {
								setCurrentExecutionId(executionId);
								setShowExecutionPanel(true);
							}}
							onHide={() => setShowRunHistory(false)}
						/>
					</div>
				)}

				<div className="flex-1 flex relative min-h-0">
					{/* Builder - always takes full width since ExecutionPanel is now an overlay */}
					<div className="w-full">
						<WorkflowErrorBoundary
							onError={(error, errorInfo) => {
								console.error(
									"[WorkflowEditor] Workflow builder error:",
									error,
									errorInfo,
								);
								toast.error(
									"An error occurred in the workflow builder",
								);
							}}
						>
							<WorkflowBuilder
								initialNodes={nodes}
								initialEdges={edges}
								onSave={handleSave}
								onRun={handleRun}
								onToggleRunHistory={() =>
									setShowRunHistory((prev) => !prev)
								}
								showRunHistory={showRunHistory}
								onNameChange={handleNameChange}
								isLoading={
									updateMutation.isPending ||
									executeMutation.isPending
								}
								workflowName={workflow.name}
								workflowId={workflow.id}
								organizationId={organizationId}
								workflowStatus={
									workflow.status as
										| "DRAFT"
										| "PUBLISHED"
										| "ACTIVE"
										| "PAUSED"
										| "ARCHIVED"
								}
								workflowVersion={workflow.version}
								publishedVersion={workflow.publishedVersion}
								onPublished={() => {
									queryClient.invalidateQueries({
										queryKey: ["workflow", workflowId],
									});
								}}
							/>
						</WorkflowErrorBoundary>
					</div>

					{/* Button to reopen execution panel when closed */}
					{!showExecutionPanel && currentExecutionId && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="secondary"
									size="icon"
									className="absolute bottom-4 right-4 h-10 w-10 rounded-full shadow-lg z-10"
									onClick={() => setShowExecutionPanel(true)}
								>
									<PanelRightCloseIcon className="h-5 w-5" />
								</Button>
							</TooltipTrigger>
							<TooltipContent side="left">
								<p>Show Execution Details</p>
							</TooltipContent>
						</Tooltip>
					)}
				</div>

				{/* Execution Panel - now a floating overlay */}
				{showExecutionPanel && currentExecutionId && (
					<ExecutionPanel
						executionId={currentExecutionId}
						workflowId={workflowId}
						onClose={() => setShowExecutionPanel(false)}
					/>
				)}
			</div>
		</div>
	);
}
