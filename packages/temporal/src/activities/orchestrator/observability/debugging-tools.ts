/**
 * Debugging Tools
 *
 * Phase 6.2: Tools for diagnosing orchestrator issues.
 * Includes replay, inspection, comparison, and analysis capabilities.
 */

import { logger } from "@repo/logs";
import type {
	ExecutionState,
	StepState,
	TimelineEvent,
} from "./execution-tracker";

// =============================================================================
// Types
// =============================================================================

export interface ReplayConfig {
	executionId: string;
	fromStep?: string;
	toStep?: string;
	modifications?: StepModification[];
	speed?: number;
	pauseOnApproval?: boolean;
	pauseOnError?: boolean;
}

export interface StepModification {
	stepId: string;
	type: "skip" | "modify_input" | "inject_error" | "change_executor";
	value?: unknown;
}

export interface ReplayState {
	replayId: string;
	originalExecutionId: string;
	config: ReplayConfig;
	status: "pending" | "running" | "paused" | "completed" | "failed";
	currentStep: number;
	totalSteps: number;
	events: ReplayEvent[];
	startedAt: Date;
	completedAt?: Date;
}

export interface ReplayEvent {
	timestamp: Date;
	type: "step_replay" | "modification_applied" | "pause" | "resume" | "error";
	stepId?: string;
	description: string;
	details?: Record<string, unknown>;
}

export interface StepInspection {
	stepId: string;
	step: StepState;
	inputs: InputAnalysis;
	outputs: OutputAnalysis;
	llmCalls: LLMCallRecord[];
	toolCalls: ToolCallRecord[];
	timeline: TimelineEvent[];
	dependencies: DependencyAnalysis;
	performance: PerformanceAnalysis;
}

export interface InputAnalysis {
	raw: Record<string, unknown>;
	resolved: Record<string, unknown>;
	sources: Array<{
		key: string;
		source: string;
		value: unknown;
	}>;
	validationIssues: string[];
}

export interface OutputAnalysis {
	raw: unknown;
	artifacts: Array<{
		type: string;
		id: string;
		summary: string;
	}>;
	consumedBy: string[];
}

export interface LLMCallRecord {
	id: string;
	model: string;
	prompt: string;
	response: string;
	tokensUsed: number;
	durationMs: number;
	timestamp: Date;
}

export interface ToolCallRecord {
	id: string;
	toolName: string;
	args: Record<string, unknown>;
	result: unknown;
	success: boolean;
	durationMs: number;
	timestamp: Date;
}

export interface DependencyAnalysis {
	dependsOn: Array<{
		stepId: string;
		type: "data" | "execution_order" | "artifact";
		satisfied: boolean;
	}>;
	dependedOnBy: Array<{
		stepId: string;
		type: "data" | "execution_order" | "artifact";
	}>;
	criticalPath: boolean;
}

export interface PerformanceAnalysis {
	durationMs: number;
	percentOfTotal: number;
	tokensUsed: number;
	llmLatencyMs: number;
	toolLatencyMs: number;
	waitTimeMs: number;
	bottleneck: boolean;
	suggestions: string[];
}

export interface ExecutionComparison {
	execution1Id: string;
	execution2Id: string;
	summary: ComparisonSummary;
	stepComparisons: StepComparison[];
	metricsDiff: MetricsDiff;
	recommendations: string[];
}

export interface ComparisonSummary {
	sameTask: boolean;
	taskSimilarity: number;
	outcomeMatch: boolean;
	stepCountDiff: number;
	durationDiff: number;
	tokensDiff: number;
}

export interface StepComparison {
	stepId1?: string;
	stepId2?: string;
	matched: boolean;
	diffs: Array<{
		field: string;
		value1: unknown;
		value2: unknown;
	}>;
}

export interface MetricsDiff {
	totalDuration: {
		value1: number;
		value2: number;
		diff: number;
		percentDiff: number;
	};
	totalTokens: {
		value1: number;
		value2: number;
		diff: number;
		percentDiff: number;
	};
	stepsCompleted: { value1: number; value2: number; diff: number };
	stepsFailed: { value1: number; value2: number; diff: number };
	approvalWait: {
		value1: number;
		value2: number;
		diff: number;
		percentDiff: number;
	};
}

export interface DebugSnapshot {
	snapshotId: string;
	executionId: string;
	stepId: string;
	timestamp: Date;
	state: {
		variables: Record<string, unknown>;
		artifacts: Array<{ id: string; type: string }>;
		pendingSteps: string[];
		completedSteps: string[];
	};
	context: {
		llmContext: string;
		toolContext: Record<string, unknown>;
	};
}

// =============================================================================
// Replay Manager
// =============================================================================

export class ReplayManager {
	private replays: Map<string, ReplayState> = new Map();
	private executionStore: Map<string, ExecutionState>;

	constructor(executionStore: Map<string, ExecutionState>) {
		this.executionStore = executionStore;
	}

	createReplay(config: ReplayConfig): ReplayState {
		const original = this.executionStore.get(config.executionId);
		if (!original) {
			throw new Error(`Execution ${config.executionId} not found`);
		}

		const replayId = `replay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		const state: ReplayState = {
			replayId,
			originalExecutionId: config.executionId,
			config,
			status: "pending",
			currentStep: 0,
			totalSteps: original.steps.length,
			events: [],
			startedAt: new Date(),
		};

		this.replays.set(replayId, state);

		logger.info("[ReplayManager] Created replay", {
			replayId,
			originalExecutionId: config.executionId,
		});

		return state;
	}

	async startReplay(replayId: string): Promise<void> {
		const replay = this.replays.get(replayId);
		if (!replay) {
			throw new Error(`Replay ${replayId} not found`);
		}

		replay.status = "running";
		this.addReplayEvent(replayId, "step_replay", "Replay started");

		// In a real implementation, this would coordinate with the orchestrator
		// to re-execute steps. For now, we just simulate the replay.
		logger.info("[ReplayManager] Started replay", { replayId });
	}

	pauseReplay(replayId: string): void {
		const replay = this.replays.get(replayId);
		if (!replay || replay.status !== "running") {
			return;
		}

		replay.status = "paused";
		this.addReplayEvent(replayId, "pause", "Replay paused");
	}

	resumeReplay(replayId: string): void {
		const replay = this.replays.get(replayId);
		if (!replay || replay.status !== "paused") {
			return;
		}

		replay.status = "running";
		this.addReplayEvent(replayId, "resume", "Replay resumed");
	}

	getReplayState(replayId: string): ReplayState | null {
		return this.replays.get(replayId) || null;
	}

	private addReplayEvent(
		replayId: string,
		type: ReplayEvent["type"],
		description: string,
		stepId?: string,
		details?: Record<string, unknown>,
	): void {
		const replay = this.replays.get(replayId);
		if (!replay) {
			return;
		}

		replay.events.push({
			timestamp: new Date(),
			type,
			stepId,
			description,
			details,
		});
	}
}

// =============================================================================
// Step Inspector
// =============================================================================

export class StepInspector {
	private executionStore: Map<string, ExecutionState>;
	private llmCallStore: Map<string, LLMCallRecord[]> = new Map();
	private toolCallStore: Map<string, ToolCallRecord[]> = new Map();

	constructor(executionStore: Map<string, ExecutionState>) {
		this.executionStore = executionStore;
	}

	inspect(executionId: string, stepId: string): StepInspection | null {
		const execution = this.executionStore.get(executionId);
		if (!execution) {
			return null;
		}

		const step = execution.steps.find((s) => s.id === stepId);
		if (!step) {
			return null;
		}

		return {
			stepId,
			step,
			inputs: this.analyzeInputs(step, execution),
			outputs: this.analyzeOutputs(step, execution),
			llmCalls: this.llmCallStore.get(stepId) || [],
			toolCalls: this.toolCallStore.get(stepId) || [],
			timeline: execution.timeline.filter((e) => e.stepId === stepId),
			dependencies: this.analyzeDependencies(step, execution),
			performance: this.analyzePerformance(step, execution),
		};
	}

	recordLLMCall(stepId: string, call: LLMCallRecord): void {
		if (!this.llmCallStore.has(stepId)) {
			this.llmCallStore.set(stepId, []);
		}
		this.llmCallStore.get(stepId)?.push(call);
	}

	recordToolCall(stepId: string, call: ToolCallRecord): void {
		if (!this.toolCallStore.has(stepId)) {
			this.toolCallStore.set(stepId, []);
		}
		this.toolCallStore.get(stepId)?.push(call);
	}

	private analyzeInputs(
		step: StepState,
		execution: ExecutionState,
	): InputAnalysis {
		const raw = step.input || {};
		const sources: InputAnalysis["sources"] = [];
		const validationIssues: string[] = [];

		// Analyze input sources
		for (const [key, value] of Object.entries(raw)) {
			let source = "user_input";

			// Check if it came from a previous step
			for (const prevStep of execution.steps) {
				if (prevStep.order < step.order && prevStep.output) {
					const outputStr = JSON.stringify(prevStep.output);
					if (outputStr.includes(JSON.stringify(value))) {
						source = `step:${prevStep.id}`;
						break;
					}
				}
			}

			sources.push({ key, source, value });
		}

		// Check for common validation issues
		for (const [key, value] of Object.entries(raw)) {
			if (value === undefined || value === null) {
				validationIssues.push(`Missing required input: ${key}`);
			}
			if (typeof value === "string" && value.includes("{{")) {
				validationIssues.push(
					`Unresolved template variable in: ${key}`,
				);
			}
		}

		return {
			raw,
			resolved: raw, // In reality, this would show resolved template values
			sources,
			validationIssues,
		};
	}

	private analyzeOutputs(
		step: StepState,
		execution: ExecutionState,
	): OutputAnalysis {
		const consumedBy: string[] = [];

		// Find steps that use this step's output
		for (const otherStep of execution.steps) {
			if (otherStep.dependsOn.includes(step.id)) {
				consumedBy.push(otherStep.id);
			}
		}

		return {
			raw: step.output,
			artifacts: [], // Would be populated from artifact store
			consumedBy,
		};
	}

	private analyzeDependencies(
		step: StepState,
		execution: ExecutionState,
	): DependencyAnalysis {
		const dependsOn: DependencyAnalysis["dependsOn"] = step.dependsOn.map(
			(depId) => {
				const depStep = execution.steps.find((s) => s.id === depId);
				return {
					stepId: depId,
					type: "execution_order" as const,
					satisfied: depStep?.status === "completed",
				};
			},
		);

		const dependedOnBy: DependencyAnalysis["dependedOnBy"] = execution.steps
			.filter((s) => s.dependsOn.includes(step.id))
			.map((s) => ({
				stepId: s.id,
				type: "execution_order" as const,
			}));

		// Check if on critical path (has dependents or is final step)
		const criticalPath =
			dependedOnBy.length > 0 ||
			step.order === Math.max(...execution.steps.map((s) => s.order));

		return { dependsOn, dependedOnBy, criticalPath };
	}

	private analyzePerformance(
		step: StepState,
		execution: ExecutionState,
	): PerformanceAnalysis {
		const durationMs = step.metrics.durationMs || 0;
		const totalDuration = execution.metrics.totalDurationMs || 1;

		const llmCalls = this.llmCallStore.get(step.id) || [];
		const toolCalls = this.toolCallStore.get(step.id) || [];

		const llmLatencyMs = llmCalls.reduce((sum, c) => sum + c.durationMs, 0);
		const toolLatencyMs = toolCalls.reduce(
			(sum, c) => sum + c.durationMs,
			0,
		);
		const waitTimeMs = durationMs - llmLatencyMs - toolLatencyMs;

		const suggestions: string[] = [];

		// Generate performance suggestions
		if (llmLatencyMs > durationMs * 0.8) {
			suggestions.push("Consider using a faster model for this step");
		}
		if (step.metrics.retryCount > 0) {
			suggestions.push(
				`Step required ${step.metrics.retryCount} retries - investigate root cause`,
			);
		}
		if (durationMs > totalDuration * 0.3) {
			suggestions.push("This step is a significant bottleneck");
		}

		return {
			durationMs,
			percentOfTotal: (durationMs / totalDuration) * 100,
			tokensUsed: step.metrics.tokensUsed || 0,
			llmLatencyMs,
			toolLatencyMs,
			waitTimeMs: Math.max(0, waitTimeMs),
			bottleneck: durationMs > totalDuration * 0.2,
			suggestions,
		};
	}
}

// =============================================================================
// Execution Comparator
// =============================================================================

export class ExecutionComparator {
	private executionStore: Map<string, ExecutionState>;

	constructor(executionStore: Map<string, ExecutionState>) {
		this.executionStore = executionStore;
	}

	compare(
		executionId1: string,
		executionId2: string,
	): ExecutionComparison | null {
		const exec1 = this.executionStore.get(executionId1);
		const exec2 = this.executionStore.get(executionId2);

		if (!exec1 || !exec2) {
			return null;
		}

		const summary = this.compareSummary(exec1, exec2);
		const stepComparisons = this.compareSteps(exec1, exec2);
		const metricsDiff = this.compareMetrics(exec1, exec2);
		const recommendations = this.generateRecommendations(
			exec1,
			exec2,
			stepComparisons,
		);

		return {
			execution1Id: executionId1,
			execution2Id: executionId2,
			summary,
			stepComparisons,
			metricsDiff,
			recommendations,
		};
	}

	private compareSummary(
		exec1: ExecutionState,
		exec2: ExecutionState,
	): ComparisonSummary {
		const taskSimilarity = this.calculateTaskSimilarity(
			exec1.taskDescription,
			exec2.taskDescription,
		);

		return {
			sameTask: taskSimilarity > 0.9,
			taskSimilarity,
			outcomeMatch: exec1.status === exec2.status,
			stepCountDiff: exec1.steps.length - exec2.steps.length,
			durationDiff:
				exec1.metrics.totalDurationMs - exec2.metrics.totalDurationMs,
			tokensDiff: exec1.metrics.totalTokens - exec2.metrics.totalTokens,
		};
	}

	private calculateTaskSimilarity(task1: string, task2: string): number {
		const words1 = new Set(task1.toLowerCase().split(/\s+/));
		const words2 = new Set(task2.toLowerCase().split(/\s+/));

		const intersection = new Set([...words1].filter((w) => words2.has(w)));
		const union = new Set([...words1, ...words2]);

		return intersection.size / union.size;
	}

	private compareSteps(
		exec1: ExecutionState,
		exec2: ExecutionState,
	): StepComparison[] {
		const comparisons: StepComparison[] = [];

		// Match steps by type and order
		const maxSteps = Math.max(exec1.steps.length, exec2.steps.length);

		for (let i = 0; i < maxSteps; i++) {
			const step1 = exec1.steps[i];
			const step2 = exec2.steps[i];

			if (!step1 && step2) {
				comparisons.push({
					stepId2: step2.id,
					matched: false,
					diffs: [{ field: "exists", value1: false, value2: true }],
				});
			} else if (step1 && !step2) {
				comparisons.push({
					stepId1: step1.id,
					matched: false,
					diffs: [{ field: "exists", value1: true, value2: false }],
				});
			} else if (step1 && step2) {
				const diffs = this.diffSteps(step1, step2);
				comparisons.push({
					stepId1: step1.id,
					stepId2: step2.id,
					matched: diffs.length === 0,
					diffs,
				});
			}
		}

		return comparisons;
	}

	private diffSteps(
		step1: StepState,
		step2: StepState,
	): StepComparison["diffs"] {
		const diffs: StepComparison["diffs"] = [];

		if (step1.type !== step2.type) {
			diffs.push({
				field: "type",
				value1: step1.type,
				value2: step2.type,
			});
		}
		if (step1.executor !== step2.executor) {
			diffs.push({
				field: "executor",
				value1: step1.executor,
				value2: step2.executor,
			});
		}
		if (step1.status !== step2.status) {
			diffs.push({
				field: "status",
				value1: step1.status,
				value2: step2.status,
			});
		}
		if (step1.riskLevel !== step2.riskLevel) {
			diffs.push({
				field: "riskLevel",
				value1: step1.riskLevel,
				value2: step2.riskLevel,
			});
		}

		const durationDiff = Math.abs(
			(step1.metrics.durationMs || 0) - (step2.metrics.durationMs || 0),
		);
		if (durationDiff > 1000) {
			diffs.push({
				field: "durationMs",
				value1: step1.metrics.durationMs,
				value2: step2.metrics.durationMs,
			});
		}

		return diffs;
	}

	private compareMetrics(
		exec1: ExecutionState,
		exec2: ExecutionState,
	): MetricsDiff {
		const m1 = exec1.metrics;
		const m2 = exec2.metrics;

		const calcPercentDiff = (v1: number, v2: number) =>
			v1 > 0 ? ((v2 - v1) / v1) * 100 : 0;

		return {
			totalDuration: {
				value1: m1.totalDurationMs,
				value2: m2.totalDurationMs,
				diff: m2.totalDurationMs - m1.totalDurationMs,
				percentDiff: calcPercentDiff(
					m1.totalDurationMs,
					m2.totalDurationMs,
				),
			},
			totalTokens: {
				value1: m1.totalTokens,
				value2: m2.totalTokens,
				diff: m2.totalTokens - m1.totalTokens,
				percentDiff: calcPercentDiff(m1.totalTokens, m2.totalTokens),
			},
			stepsCompleted: {
				value1: m1.stepsCompleted,
				value2: m2.stepsCompleted,
				diff: m2.stepsCompleted - m1.stepsCompleted,
			},
			stepsFailed: {
				value1: m1.stepsFailed,
				value2: m2.stepsFailed,
				diff: m2.stepsFailed - m1.stepsFailed,
			},
			approvalWait: {
				value1: m1.approvalWaitMs,
				value2: m2.approvalWaitMs,
				diff: m2.approvalWaitMs - m1.approvalWaitMs,
				percentDiff: calcPercentDiff(
					m1.approvalWaitMs,
					m2.approvalWaitMs,
				),
			},
		};
	}

	private generateRecommendations(
		exec1: ExecutionState,
		exec2: ExecutionState,
		stepComparisons: StepComparison[],
	): string[] {
		const recommendations: string[] = [];

		// Duration recommendations
		if (
			exec2.metrics.totalDurationMs <
			exec1.metrics.totalDurationMs * 0.8
		) {
			recommendations.push(
				`Execution 2 was ${Math.round((1 - exec2.metrics.totalDurationMs / exec1.metrics.totalDurationMs) * 100)}% faster - analyze for optimization patterns`,
			);
		}

		// Token recommendations
		if (exec2.metrics.totalTokens < exec1.metrics.totalTokens * 0.8) {
			recommendations.push(
				`Execution 2 used ${Math.round((1 - exec2.metrics.totalTokens / exec1.metrics.totalTokens) * 100)}% fewer tokens - check for prompt optimizations`,
			);
		}

		// Step differences
		const failedInOne = stepComparisons.filter((sc) =>
			sc.diffs.some(
				(d) =>
					d.field === "status" &&
					((d.value1 === "completed" && d.value2 === "failed") ||
						(d.value1 === "failed" && d.value2 === "completed")),
			),
		);
		if (failedInOne.length > 0) {
			recommendations.push(
				`${failedInOne.length} step(s) had different outcomes - investigate root causes`,
			);
		}

		// Executor changes
		const executorChanges = stepComparisons.filter((sc) =>
			sc.diffs.some((d) => d.field === "executor"),
		);
		if (executorChanges.length > 0) {
			recommendations.push(
				`${executorChanges.length} step(s) used different executors - compare effectiveness`,
			);
		}

		return recommendations;
	}
}

// =============================================================================
// Snapshot Manager
// =============================================================================

export class SnapshotManager {
	private snapshots: Map<string, DebugSnapshot[]> = new Map();
	private maxSnapshotsPerExecution = 100;

	createSnapshot(
		executionId: string,
		stepId: string,
		state: DebugSnapshot["state"],
		context: DebugSnapshot["context"],
	): string {
		const snapshotId = `snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

		const snapshot: DebugSnapshot = {
			snapshotId,
			executionId,
			stepId,
			timestamp: new Date(),
			state,
			context,
		};

		if (!this.snapshots.has(executionId)) {
			this.snapshots.set(executionId, []);
		}

		// biome-ignore lint/style/noNonNullAssertion: snapshots map is populated on initialization
		const executionSnapshots = this.snapshots.get(executionId)!;
		executionSnapshots.push(snapshot);

		// Limit snapshots per execution
		if (executionSnapshots.length > this.maxSnapshotsPerExecution) {
			executionSnapshots.shift();
		}

		logger.debug("[SnapshotManager] Created snapshot", {
			snapshotId,
			executionId,
			stepId,
		});

		return snapshotId;
	}

	getSnapshot(snapshotId: string): DebugSnapshot | null {
		for (const snapshots of this.snapshots.values()) {
			const snapshot = snapshots.find((s) => s.snapshotId === snapshotId);
			if (snapshot) {
				return snapshot;
			}
		}
		return null;
	}

	getExecutionSnapshots(executionId: string): DebugSnapshot[] {
		return this.snapshots.get(executionId) || [];
	}

	getStepSnapshots(executionId: string, stepId: string): DebugSnapshot[] {
		return (this.snapshots.get(executionId) || []).filter(
			(s) => s.stepId === stepId,
		);
	}

	compareSnapshots(
		snapshotId1: string,
		snapshotId2: string,
	): {
		stateDiffs: Array<{ path: string; value1: unknown; value2: unknown }>;
		contextDiffs: Array<{ path: string; value1: unknown; value2: unknown }>;
	} | null {
		const snap1 = this.getSnapshot(snapshotId1);
		const snap2 = this.getSnapshot(snapshotId2);

		if (!snap1 || !snap2) {
			return null;
		}

		return {
			stateDiffs: this.diffObjects(snap1.state, snap2.state, "state"),
			contextDiffs: this.diffObjects(
				snap1.context,
				snap2.context,
				"context",
			),
		};
	}

	private diffObjects(
		obj1: unknown,
		obj2: unknown,
		path: string,
	): Array<{ path: string; value1: unknown; value2: unknown }> {
		const diffs: Array<{ path: string; value1: unknown; value2: unknown }> =
			[];

		if (typeof obj1 !== typeof obj2) {
			diffs.push({ path, value1: obj1, value2: obj2 });
			return diffs;
		}

		if (typeof obj1 !== "object" || obj1 === null) {
			if (obj1 !== obj2) {
				diffs.push({ path, value1: obj1, value2: obj2 });
			}
			return diffs;
		}

		const keys = new Set([
			...Object.keys(obj1 as object),
			...Object.keys(obj2 as object),
		]);

		for (const key of keys) {
			const v1 = (obj1 as Record<string, unknown>)[key];
			const v2 = (obj2 as Record<string, unknown>)[key];
			diffs.push(...this.diffObjects(v1, v2, `${path}.${key}`));
		}

		return diffs;
	}
}

// =============================================================================
// Utility Functions
// =============================================================================

export function createDebuggingToolkit(
	executionStore: Map<string, ExecutionState>,
): {
	replay: ReplayManager;
	inspector: StepInspector;
	comparator: ExecutionComparator;
	snapshots: SnapshotManager;
} {
	return {
		replay: new ReplayManager(executionStore),
		inspector: new StepInspector(executionStore),
		comparator: new ExecutionComparator(executionStore),
		snapshots: new SnapshotManager(),
	};
}

export function formatStepInspection(inspection: StepInspection): string {
	const lines: string[] = [
		`## Step Inspection: ${inspection.stepId}`,
		"",
		`**Status:** ${inspection.step.status}`,
		`**Type:** ${inspection.step.type}`,
		`**Executor:** ${inspection.step.executor}`,
		`**Duration:** ${inspection.performance.durationMs}ms (${inspection.performance.percentOfTotal.toFixed(1)}% of total)`,
		"",
		"### Inputs",
	];

	for (const source of inspection.inputs.sources) {
		lines.push(`- **${source.key}**: from ${source.source}`);
	}

	if (inspection.inputs.validationIssues.length > 0) {
		lines.push("", "### Validation Issues");
		for (const issue of inspection.inputs.validationIssues) {
			lines.push(`- ${issue}`);
		}
	}

	if (inspection.llmCalls.length > 0) {
		lines.push("", `### LLM Calls (${inspection.llmCalls.length})`);
		for (const call of inspection.llmCalls) {
			lines.push(
				`- ${call.model}: ${call.tokensUsed} tokens, ${call.durationMs}ms`,
			);
		}
	}

	if (inspection.toolCalls.length > 0) {
		lines.push("", `### Tool Calls (${inspection.toolCalls.length})`);
		for (const call of inspection.toolCalls) {
			lines.push(
				`- ${call.toolName}: ${call.success ? "success" : "failed"}, ${call.durationMs}ms`,
			);
		}
	}

	if (inspection.performance.suggestions.length > 0) {
		lines.push("", "### Performance Suggestions");
		for (const suggestion of inspection.performance.suggestions) {
			lines.push(`- ${suggestion}`);
		}
	}

	return lines.join("\n");
}
