/**
 * Execution Tracker
 *
 * Phase 6.1: Real-time visualization support for orchestrator execution.
 * Tracks execution state, emits events, and provides query APIs.
 */

import { logger } from "@repo/logs";

// =============================================================================
// Types
// =============================================================================

export type ExecutionStatus =
	| "pending"
	| "planning"
	| "awaiting_approval"
	| "executing"
	| "paused"
	| "completed"
	| "failed"
	| "cancelled";

export type StepStatus =
	| "pending"
	| "queued"
	| "running"
	| "awaiting_approval"
	| "completed"
	| "failed"
	| "skipped"
	| "cancelled";

export interface ExecutionState {
	executionId: string;
	taskDescription: string;
	status: ExecutionStatus;
	planId?: string;
	currentStepId?: string;
	steps: StepState[];
	metrics: ExecutionMetrics;
	timeline: TimelineEvent[];
	errors: ExecutionError[];
	approvalRequests: ApprovalRequestState[];
	startedAt: Date;
	completedAt?: Date;
	userId: string;
	organizationId?: string;
}

export interface StepState {
	id: string;
	description: string;
	type: string;
	executor: string;
	status: StepStatus;
	order: number;
	dependsOn: string[];
	riskLevel: "low" | "medium" | "high" | "critical";
	metrics: StepMetrics;
	input?: Record<string, unknown>;
	output?: unknown;
	error?: string;
	startedAt?: Date;
	completedAt?: Date;
}

export interface StepMetrics {
	durationMs?: number;
	tokensUsed?: number;
	llmCalls?: number;
	toolCalls?: number;
	retryCount: number;
}

export interface ExecutionMetrics {
	totalDurationMs: number;
	planningDurationMs: number;
	executionDurationMs: number;
	approvalWaitMs: number;
	totalTokens: number;
	totalLlmCalls: number;
	totalToolCalls: number;
	stepsCompleted: number;
	stepsFailed: number;
	stepsSkipped: number;
	estimatedCost: number;
}

export interface TimelineEvent {
	id: string;
	timestamp: Date;
	type: TimelineEventType;
	description: string;
	stepId?: string;
	metadata?: Record<string, unknown>;
}

export type TimelineEventType =
	| "execution_started"
	| "planning_started"
	| "planning_completed"
	| "approval_requested"
	| "approval_granted"
	| "approval_denied"
	| "step_started"
	| "step_completed"
	| "step_failed"
	| "step_skipped"
	| "step_retrying"
	| "recovery_initiated"
	| "execution_completed"
	| "execution_failed"
	| "execution_cancelled"
	| "checkpoint_created"
	| "checkpoint_restored";

export interface ExecutionError {
	id: string;
	timestamp: Date;
	stepId?: string;
	errorType: string;
	message: string;
	stack?: string;
	recovered: boolean;
	recoveryAction?: string;
}

export interface ApprovalRequestState {
	id: string;
	type: "step" | "plan";
	status: "pending" | "approved" | "denied" | "expired";
	stepIds: string[];
	riskLevel: "low" | "medium" | "high" | "critical";
	requestedAt: Date;
	respondedAt?: Date;
	response?: string;
}

export interface ExecutionEventListener {
	onStateChange?: (state: ExecutionState) => void;
	onStepChange?: (step: StepState, execution: ExecutionState) => void;
	onTimelineEvent?: (event: TimelineEvent, execution: ExecutionState) => void;
	onError?: (error: ExecutionError, execution: ExecutionState) => void;
	onMetricsUpdate?: (
		metrics: ExecutionMetrics,
		execution: ExecutionState,
	) => void;
}

// =============================================================================
// Execution Tracker
// =============================================================================

export class ExecutionTracker {
	private executions: Map<string, ExecutionState> = new Map();
	private listeners: Map<string, ExecutionEventListener[]> = new Map();
	private globalListeners: ExecutionEventListener[] = [];
	private maxExecutions = 1000;

	createExecution(
		executionId: string,
		taskDescription: string,
		userId: string,
		organizationId?: string,
	): ExecutionState {
		const state: ExecutionState = {
			executionId,
			taskDescription,
			status: "pending",
			steps: [],
			metrics: this.createInitialMetrics(),
			timeline: [],
			errors: [],
			approvalRequests: [],
			startedAt: new Date(),
			userId,
			organizationId,
		};

		this.executions.set(executionId, state);
		this.limitExecutions();

		this.addTimelineEvent(
			executionId,
			"execution_started",
			"Execution started",
		);
		this.emitStateChange(state);

		logger.debug("[ExecutionTracker] Created execution", { executionId });
		return state;
	}

	private createInitialMetrics(): ExecutionMetrics {
		return {
			totalDurationMs: 0,
			planningDurationMs: 0,
			executionDurationMs: 0,
			approvalWaitMs: 0,
			totalTokens: 0,
			totalLlmCalls: 0,
			totalToolCalls: 0,
			stepsCompleted: 0,
			stepsFailed: 0,
			stepsSkipped: 0,
			estimatedCost: 0,
		};
	}

	private limitExecutions(): void {
		if (this.executions.size > this.maxExecutions) {
			const oldest = Array.from(this.executions.entries())
				.sort(
					(a, b) =>
						a[1].startedAt.getTime() - b[1].startedAt.getTime(),
				)
				.slice(0, 100);
			for (const [id] of oldest) {
				this.executions.delete(id);
				this.listeners.delete(id);
			}
		}
	}

	getExecution(executionId: string): ExecutionState | null {
		return this.executions.get(executionId) || null;
	}

	updateStatus(executionId: string, status: ExecutionStatus): void {
		const state = this.executions.get(executionId);
		if (!state) {
			return;
		}

		state.status = status;

		if (
			status === "completed" ||
			status === "failed" ||
			status === "cancelled"
		) {
			state.completedAt = new Date();
			state.metrics.totalDurationMs =
				state.completedAt.getTime() - state.startedAt.getTime();
		}

		this.addTimelineEvent(
			executionId,
			status === "completed"
				? "execution_completed"
				: status === "failed"
					? "execution_failed"
					: status === "cancelled"
						? "execution_cancelled"
						: "execution_started",
			`Execution status: ${status}`,
		);

		this.emitStateChange(state);
	}

	setPlan(
		executionId: string,
		planId: string,
		steps: Omit<StepState, "metrics">[],
	): void {
		const state = this.executions.get(executionId);
		if (!state) {
			return;
		}

		state.planId = planId;
		state.steps = steps.map((s) => ({
			...s,
			metrics: {
				retryCount: 0,
			},
		}));

		this.addTimelineEvent(
			executionId,
			"planning_completed",
			`Plan created with ${steps.length} steps`,
		);
		this.emitStateChange(state);
	}

	updateStep(
		executionId: string,
		stepId: string,
		updates: Partial<StepState>,
	): void {
		const state = this.executions.get(executionId);
		if (!state) {
			return;
		}

		const step = state.steps.find((s) => s.id === stepId);
		if (!step) {
			return;
		}

		const previousStatus = step.status;
		Object.assign(step, updates);

		// Track status changes
		if (updates.status && updates.status !== previousStatus) {
			if (updates.status === "running") {
				step.startedAt = new Date();
				state.currentStepId = stepId;
				this.addTimelineEvent(
					executionId,
					"step_started",
					`Step started: ${step.description}`,
					stepId,
				);
			} else if (updates.status === "completed") {
				step.completedAt = new Date();
				if (step.startedAt) {
					step.metrics.durationMs =
						step.completedAt.getTime() - step.startedAt.getTime();
				}
				state.metrics.stepsCompleted++;
				this.addTimelineEvent(
					executionId,
					"step_completed",
					`Step completed: ${step.description}`,
					stepId,
				);
			} else if (updates.status === "failed") {
				step.completedAt = new Date();
				if (step.startedAt) {
					step.metrics.durationMs =
						step.completedAt.getTime() - step.startedAt.getTime();
				}
				state.metrics.stepsFailed++;
				this.addTimelineEvent(
					executionId,
					"step_failed",
					`Step failed: ${step.description}`,
					stepId,
				);
			} else if (updates.status === "skipped") {
				state.metrics.stepsSkipped++;
				this.addTimelineEvent(
					executionId,
					"step_skipped",
					`Step skipped: ${step.description}`,
					stepId,
				);
			}
		}

		this.emitStepChange(step, state);
		this.emitStateChange(state);
	}

	recordStepMetrics(
		executionId: string,
		stepId: string,
		metrics: Partial<StepMetrics>,
	): void {
		const state = this.executions.get(executionId);
		if (!state) {
			return;
		}

		const step = state.steps.find((s) => s.id === stepId);
		if (!step) {
			return;
		}

		Object.assign(step.metrics, metrics);

		// Update execution metrics
		if (metrics.tokensUsed) {
			state.metrics.totalTokens += metrics.tokensUsed;
		}
		if (metrics.llmCalls) {
			state.metrics.totalLlmCalls += metrics.llmCalls;
		}
		if (metrics.toolCalls) {
			state.metrics.totalToolCalls += metrics.toolCalls;
		}

		this.emitMetricsUpdate(state.metrics, state);
	}

	recordError(
		executionId: string,
		error: Omit<ExecutionError, "id" | "timestamp">,
	): void {
		const state = this.executions.get(executionId);
		if (!state) {
			return;
		}

		const errorRecord: ExecutionError = {
			...error,
			id: `error-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			timestamp: new Date(),
		};

		state.errors.push(errorRecord);
		this.emitError(errorRecord, state);
	}

	requestApproval(
		executionId: string,
		request: Omit<ApprovalRequestState, "id" | "requestedAt" | "status">,
	): string {
		const state = this.executions.get(executionId);
		if (!state) {
			return "";
		}

		const approvalId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const approvalState: ApprovalRequestState = {
			...request,
			id: approvalId,
			status: "pending",
			requestedAt: new Date(),
		};

		state.approvalRequests.push(approvalState);
		state.status = "awaiting_approval";

		this.addTimelineEvent(
			executionId,
			"approval_requested",
			`Approval requested for ${request.stepIds.length} step(s)`,
		);
		this.emitStateChange(state);

		return approvalId;
	}

	resolveApproval(
		executionId: string,
		approvalId: string,
		approved: boolean,
		response?: string,
	): void {
		const state = this.executions.get(executionId);
		if (!state) {
			return;
		}

		const approval = state.approvalRequests.find(
			(a) => a.id === approvalId,
		);
		if (!approval) {
			return;
		}

		approval.status = approved ? "approved" : "denied";
		approval.respondedAt = new Date();
		approval.response = response;

		// Calculate approval wait time
		state.metrics.approvalWaitMs +=
			approval.respondedAt.getTime() - approval.requestedAt.getTime();

		this.addTimelineEvent(
			executionId,
			approved ? "approval_granted" : "approval_denied",
			`Approval ${approved ? "granted" : "denied"}${response ? `: ${response}` : ""}`,
		);
		this.emitStateChange(state);
	}

	addTimelineEvent(
		executionId: string,
		type: TimelineEventType,
		description: string,
		stepId?: string,
		metadata?: Record<string, unknown>,
	): void {
		const state = this.executions.get(executionId);
		if (!state) {
			return;
		}

		const event: TimelineEvent = {
			id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			timestamp: new Date(),
			type,
			description,
			stepId,
			metadata,
		};

		state.timeline.push(event);
		this.emitTimelineEvent(event, state);
	}

	// Event subscription
	subscribe(
		executionId: string,
		listener: ExecutionEventListener,
	): () => void {
		if (!this.listeners.has(executionId)) {
			this.listeners.set(executionId, []);
		}
		this.listeners.get(executionId)?.push(listener);

		return () => {
			const listeners = this.listeners.get(executionId);
			if (listeners) {
				const index = listeners.indexOf(listener);
				if (index > -1) {
					listeners.splice(index, 1);
				}
			}
		};
	}

	subscribeGlobal(listener: ExecutionEventListener): () => void {
		this.globalListeners.push(listener);
		return () => {
			const index = this.globalListeners.indexOf(listener);
			if (index > -1) {
				this.globalListeners.splice(index, 1);
			}
		};
	}

	private emitStateChange(state: ExecutionState): void {
		const listeners = [
			...(this.listeners.get(state.executionId) || []),
			...this.globalListeners,
		];
		for (const listener of listeners) {
			listener.onStateChange?.(state);
		}
	}

	private emitStepChange(step: StepState, state: ExecutionState): void {
		const listeners = [
			...(this.listeners.get(state.executionId) || []),
			...this.globalListeners,
		];
		for (const listener of listeners) {
			listener.onStepChange?.(step, state);
		}
	}

	private emitTimelineEvent(
		event: TimelineEvent,
		state: ExecutionState,
	): void {
		const listeners = [
			...(this.listeners.get(state.executionId) || []),
			...this.globalListeners,
		];
		for (const listener of listeners) {
			listener.onTimelineEvent?.(event, state);
		}
	}

	private emitError(error: ExecutionError, state: ExecutionState): void {
		const listeners = [
			...(this.listeners.get(state.executionId) || []),
			...this.globalListeners,
		];
		for (const listener of listeners) {
			listener.onError?.(error, state);
		}
	}

	private emitMetricsUpdate(
		metrics: ExecutionMetrics,
		state: ExecutionState,
	): void {
		const listeners = [
			...(this.listeners.get(state.executionId) || []),
			...this.globalListeners,
		];
		for (const listener of listeners) {
			listener.onMetricsUpdate?.(metrics, state);
		}
	}

	// Query APIs
	getActiveExecutions(): ExecutionState[] {
		return Array.from(this.executions.values()).filter(
			(e) => !["completed", "failed", "cancelled"].includes(e.status),
		);
	}

	getRecentExecutions(limit = 20): ExecutionState[] {
		return Array.from(this.executions.values())
			.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
			.slice(0, limit);
	}

	getExecutionsByUser(userId: string, limit = 20): ExecutionState[] {
		return Array.from(this.executions.values())
			.filter((e) => e.userId === userId)
			.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
			.slice(0, limit);
	}

	getStats(): {
		activeCount: number;
		totalCount: number;
		avgDurationMs: number;
		successRate: number;
	} {
		const executions = Array.from(this.executions.values());
		const completed = executions.filter((e) => e.status === "completed");
		const failed = executions.filter((e) => e.status === "failed");

		return {
			activeCount: executions.filter(
				(e) => !["completed", "failed", "cancelled"].includes(e.status),
			).length,
			totalCount: executions.length,
			avgDurationMs:
				completed.length > 0
					? completed.reduce(
							(sum, e) => sum + e.metrics.totalDurationMs,
							0,
						) / completed.length
					: 0,
			successRate:
				completed.length + failed.length > 0
					? completed.length / (completed.length + failed.length)
					: 0,
		};
	}
}

// =============================================================================
// Utility Functions
// =============================================================================

export function createExecutionTracker(): ExecutionTracker {
	return new ExecutionTracker();
}

export function formatDuration(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	if (ms < 60000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	if (ms < 3600000) {
		return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
	}
	return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

export function formatCost(cost: number): string {
	if (cost < 0.01) {
		return `$${cost.toFixed(4)}`;
	}
	if (cost < 1) {
		return `$${cost.toFixed(3)}`;
	}
	return `$${cost.toFixed(2)}`;
}

import {
	DEFAULT_MODELS,
	getModelCost,
} from "@repo/database/prisma/ai-model-catalog";

export function estimateCost(
	tokens: number,
	model: string = DEFAULT_MODELS.CHAT,
): number {
	// Get cost from the AI Model Catalog (single source of truth)
	const cost = getModelCost(model);
	if (cost) {
		// Use average of input and output cost per 1M tokens, convert to per 1K
		const avgCostPer1K =
			(cost.inputCostPer1M + cost.outputCostPer1M) / 2 / 1000;
		return (tokens / 1000) * avgCostPer1K;
	}
	// Fallback for unknown models
	return (tokens / 1000) * 0.005;
}
