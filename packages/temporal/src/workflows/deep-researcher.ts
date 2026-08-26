/**
 * Deep Researcher Workflow
 *
 * A coordinator workflow that decomposes complex research questions into
 * parallel sub-investigations, each with dedicated context windows.
 *
 * Key Features:
 * - Classifies request complexity (simple/medium/complex)
 * - Decomposes complex requests into 3-6 atomic subtasks
 * - Spawns sub-agents in parallel for focused investigation
 * - Aggregates and synthesizes findings
 * - Evaluates success criteria (LLM judge)
 * - Iterates if needed (up to maxIterations)
 *
 * Architecture:
 * deepResearcherWorkflow
 * ├── analyzeComplexityActivity          # Classify request complexity
 * ├── decomposeTaskActivity              # Break into 3-6 subtasks (if complex)
 * ├── [PARALLEL] executeSubAgentActivity # Up to 6 concurrent sub-agents
 * │   ├── Sub-agent 1 (own context window)
 * │   ├── Sub-agent 2 (own context window)
 * │   └── ... up to 6
 * ├── aggregateResultsActivity           # Synthesize findings
 * ├── evaluateSuccessActivity            # Check against success criteria
 * └── [LOOP if not complete]             # Up to maxIterations
 */

import {
	condition,
	defineQuery,
	defineSignal,
	log,
	proxyActivities,
	setHandler,
	workflowInfo,
} from "@temporalio/workflow";
import type * as deepResearcherActivities from "../activities/deep-researcher";

// =============================================================================
// Types
// =============================================================================

export type ResearchComplexity = "simple" | "medium" | "complex";

export interface SubTask {
	id: string;
	title: string;
	description: string;
	focusArea: string;
	expectedOutput: string;
}

export interface SubAgentResult {
	subTaskId: string;
	title: string;
	status: "completed" | "failed" | "timeout";
	findings: string;
	sources: string[];
	confidence: number; // 0-100
	error?: string;
	duration: number;
}

export interface DeepResearcherInput {
	/** Execution ID for tracking */
	executionId: string;
	/** The research question or task */
	query: string;
	/** User ID for tenant isolation */
	userId: string;
	/** Organization ID for tenant isolation */
	organizationId?: string;
	/** Template instance ID if created from a template */
	instanceId?: string;
	/** Context to help guide the research */
	context?: string;
	/** Maximum sub-agents to spawn (default: 6) */
	maxSubAgents?: number;
	/** Maximum iterations for goal achievement (default: 3) */
	maxIterations?: number;
	/** Custom success criteria for LLM judge */
	successCriteria?: string;
	/** Tools available to sub-agents */
	availableTools?: string[];
	/** Knowledge sources to use */
	knowledgeSources?: string[];
	/** Workspace IDs for RAG document retrieval */
	workspaceIds?: string[];
	/** Project ID for RAG context scoping */
	projectId?: string;
	/** Reasoning effort level */
	reasoningEffort?: "none" | "light" | "medium" | "high";
}

/** A citation linking a claim to its source */
export interface ResearchCitation {
	/** Source identifier (URL, document name, etc.) */
	source: string;
	/** Whether the source was from RAG, web search, or sub-agent */
	sourceType: "rag" | "web" | "sub-agent";
	/** Numbered reference position in the source registry */
	sourceNumber?: number;
	/** Relevance score if available */
	relevance?: number | null;
}

/** A section of the structured research report */
export interface ResearchReportSection {
	heading: string;
	content: string;
	citations: ResearchCitation[];
}

export interface DeepResearcherOutput {
	executionId: string;
	status: "completed" | "failed" | "timeout" | "cancelled";
	/** The synthesized research result (flat text) */
	result?: string;
	/** Executive summary */
	summary?: string;
	/** Key findings organized by theme */
	keyFindings?: Array<{
		theme: string;
		findings: string[];
		confidence: number;
	}>;
	/** All sources consulted */
	sources?: string[];
	/** Sub-agent results for transparency */
	subAgentResults?: SubAgentResult[];
	/** Number of iterations taken */
	iterations: number;
	/** Whether the success criteria was met */
	goalAchieved: boolean;
	/** Total duration in ms */
	duration: number;
	/** Error message if failed */
	error?: string;

	// ---- Structured Report (Phase 3 addition) ----

	/** Structured report with sections and inline citations */
	structuredReport?: {
		/** Report title derived from the research query */
		title: string;
		/** Executive summary (1-2 paragraphs) */
		executiveSummary: string;
		/** Report sections with headings, content, and citations */
		sections: ResearchReportSection[];
		/** How the research was conducted */
		methodology: string;
		/** All sources with type and relevance */
		citedSources: ResearchCitation[];
	};
}

export type DeepResearcherPhase =
	| "initializing"
	| "analyzing_complexity"
	| "awaiting_clarification"
	| "decomposing"
	| "executing_subagents"
	| "aggregating"
	| "evaluating"
	| "iterating"
	| "completed"
	| "failed"
	| "cancelled";

export interface DeepResearcherProgress {
	executionId: string;
	phase: DeepResearcherPhase;
	message: string;
	complexity?: ResearchComplexity;
	currentIteration: number;
	maxIterations: number;
	subAgentsTotal: number;
	subAgentsCompleted: number;
	subAgentsFailed: number;
	goalAchieved: boolean;
	timestamp: string;
	/** Clarification prompt to show the user (set when phase = awaiting_clarification) */
	clarificationPrompt?: string;
	/** Sub-task titles (set after decomposition for progress display) */
	subTaskTitles?: string[];
}

export interface DeepResearcherState {
	executionId: string;
	status: "running" | "completed" | "failed" | "cancelled";
	phase: DeepResearcherPhase;
	complexity: ResearchComplexity | null;
	subTasks: SubTask[];
	subAgentResults: SubAgentResult[];
	currentIteration: number;
	maxIterations: number;
	goalAchieved: boolean;
	aggregatedResult: string | null;
	structuredReport: DeepResearcherOutput["structuredReport"] | null;
	cancelled: boolean;
	currentProgress: DeepResearcherProgress;
}

// =============================================================================
// Signals & Queries
// =============================================================================

export const cancelSignal = defineSignal("cancel");
export const clarificationSignal = defineSignal<[string]>("clarification");
export const progressQuery = defineQuery<DeepResearcherProgress>("progress");
export const statusQuery = defineQuery<DeepResearcherState["status"]>("status");
export const subAgentResultsQuery =
	defineQuery<SubAgentResult[]>("subAgentResults");

// =============================================================================
// Activity Proxies
// =============================================================================

// Analysis and decomposition activities (fast)
const analysisActivities = proxyActivities<typeof deepResearcherActivities>({
	startToCloseTimeout: "2 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

// Sub-agent execution activities (longer running)
// Activities send heartbeats every 10 seconds during AI calls
const executionActivities = proxyActivities<typeof deepResearcherActivities>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "60s",
		maximumAttempts: 2,
	},
});

// Aggregation and evaluation activities
// Activities send heartbeats every 10 seconds during AI calls
const aggregationActivities = proxyActivities<typeof deepResearcherActivities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

// =============================================================================
// Helper Functions
// =============================================================================

function createInitialState(input: DeepResearcherInput): DeepResearcherState {
	return {
		executionId: input.executionId,
		status: "running",
		phase: "initializing",
		complexity: null,
		subTasks: [],
		subAgentResults: [],
		currentIteration: 0,
		maxIterations: input.maxIterations ?? 3,
		goalAchieved: false,
		aggregatedResult: null,
		structuredReport: null,
		cancelled: false,
		currentProgress: {
			executionId: input.executionId,
			phase: "initializing",
			message: "Starting deep research workflow",
			currentIteration: 0,
			maxIterations: input.maxIterations ?? 3,
			subAgentsTotal: 0,
			subAgentsCompleted: 0,
			subAgentsFailed: 0,
			goalAchieved: false,
			timestamp: new Date().toISOString(),
		},
	};
}

// =============================================================================
// Main Workflow
// =============================================================================

export async function deepResearcherWorkflow(
	input: DeepResearcherInput,
): Promise<DeepResearcherOutput> {
	const { workflowId } = workflowInfo();
	const startTime = Date.now();
	const state = createInitialState(input);
	const maxSubAgents = input.maxSubAgents ?? 6;

	// ==========================================================================
	// Signal & Query Handlers
	// ==========================================================================

	// Clarification state (part of workflow, not in DeepResearcherState to keep it simple)
	let clarificationResponse: string | null = null;
	let awaitingClarification = false;

	setHandler(cancelSignal, () => {
		log.info("Received cancel signal", { executionId: state.executionId });
		state.cancelled = true;
		state.status = "cancelled";
		state.phase = "cancelled";
	});

	setHandler(clarificationSignal, (response: string) => {
		log.info("Received clarification response", {
			executionId: state.executionId,
			responseLength: response.length,
		});
		clarificationResponse = response;
		awaitingClarification = false;
	});

	setHandler(progressQuery, () => state.currentProgress);
	setHandler(statusQuery, () => state.status);
	setHandler(subAgentResultsQuery, () => state.subAgentResults);

	// ==========================================================================
	// Progress Update Helper
	// ==========================================================================

	function updateProgress(
		phase: DeepResearcherPhase,
		message: string,
		extra?: Partial<
			Pick<
				DeepResearcherProgress,
				"clarificationPrompt" | "subTaskTitles"
			>
		>,
	) {
		state.phase = phase;
		state.currentProgress = {
			executionId: state.executionId,
			phase,
			message,
			complexity: state.complexity ?? undefined,
			currentIteration: state.currentIteration,
			maxIterations: state.maxIterations,
			subAgentsTotal: state.subTasks.length,
			subAgentsCompleted: state.subAgentResults.filter(
				(r) => r.status === "completed",
			).length,
			subAgentsFailed: state.subAgentResults.filter(
				(r) => r.status === "failed",
			).length,
			goalAchieved: state.goalAchieved,
			timestamp: new Date().toISOString(),
			clarificationPrompt:
				extra?.clarificationPrompt ??
				state.currentProgress.clarificationPrompt,
			subTaskTitles:
				extra?.subTaskTitles ?? state.currentProgress.subTaskTitles,
		};
	}

	// ==========================================================================
	// Main Execution
	// ==========================================================================

	try {
		log.info("Starting deep researcher workflow", {
			executionId: state.executionId,
			workflowId,
			query: input.query.substring(0, 100),
			maxSubAgents,
			maxIterations: state.maxIterations,
		});

		// ======================================================================
		// Step 1: Analyze Complexity
		// ======================================================================

		if (state.cancelled) {
			return buildCancelledOutput(state, startTime);
		}

		updateProgress("analyzing_complexity", "Analyzing request complexity");

		const complexityResult = await analysisActivities.analyzeComplexity({
			query: input.query,
			context: input.context,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		state.complexity = complexityResult.complexity;

		log.info("Complexity analysis complete", {
			executionId: state.executionId,
			complexity: state.complexity,
			reasoning: complexityResult.reasoning,
		});

		// ======================================================================
		// Step 2: Handle Simple Requests Directly
		// ======================================================================

		if (state.complexity === "simple") {
			updateProgress(
				"executing_subagents",
				"Handling simple request directly",
			);

			// For simple requests, execute directly without decomposition
			const directResult =
				await executionActivities.executeDirectResearch({
					query: input.query,
					context: input.context,
					userId: input.userId,
					organizationId: input.organizationId,
					availableTools: input.availableTools,
					knowledgeSources: input.knowledgeSources,
					workspaceIds: input.workspaceIds,
					projectId: input.projectId,
					reasoningEffort: input.reasoningEffort,
				});

			state.aggregatedResult = directResult.result;
			state.goalAchieved = true;
			state.status = "completed";
			updateProgress("completed", "Research completed");

			return {
				executionId: state.executionId,
				status: "completed",
				result: directResult.result,
				summary: directResult.summary,
				sources: directResult.sources,
				subAgentResults: [],
				iterations: 1,
				goalAchieved: true,
				duration: Date.now() - startTime,
			};
		}

		// ======================================================================
		// Step 2b: Check if Clarification Needed (complex queries only)
		// ======================================================================

		if (!state.cancelled && state.complexity === "complex") {
			try {
				const clarificationCheck =
					await analysisActivities.checkClarificationNeeded({
						query: input.query,
						context: input.context,
						userId: input.userId,
						organizationId: input.organizationId,
					});

				if (clarificationCheck.needsClarification) {
					log.info("Clarification needed", {
						executionId: state.executionId,
						prompt: clarificationCheck.clarificationPrompt,
					});

					awaitingClarification = true;
					updateProgress(
						"awaiting_clarification",
						clarificationCheck.clarificationPrompt ??
							"Need more details to proceed",
						{
							clarificationPrompt:
								clarificationCheck.clarificationPrompt,
						},
					);

					// Wait for clarification signal or timeout (5 min)
					await condition(
						() => !awaitingClarification || state.cancelled,
						"5 minutes",
					);

					if (clarificationResponse) {
						log.info("Clarification received, enriching context", {
							executionId: state.executionId,
						});
						input.context = input.context
							? `${input.context}\n\nUser clarification: ${clarificationResponse}`
							: `User clarification: ${clarificationResponse}`;
					} else {
						log.info(
							"Clarification timeout — proceeding with best-effort interpretation",
							{ executionId: state.executionId },
						);
					}
				}
			} catch (clarificationError) {
				log.warn("Clarification check failed, proceeding without", {
					error: String(clarificationError),
				});
			}
		}

		// ======================================================================
		// Step 3: Decompose Complex Request into Sub-Tasks
		// ======================================================================

		if (state.cancelled) {
			return buildCancelledOutput(state, startTime);
		}

		updateProgress(
			"decomposing",
			`Decomposing ${state.complexity} request into sub-tasks`,
		);

		const decompositionResult = await analysisActivities.decomposeTask({
			query: input.query,
			context: input.context,
			complexity: state.complexity,
			maxSubTasks: maxSubAgents,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		state.subTasks = decompositionResult.subTasks;
		updateProgress(
			"decomposing",
			`Decomposing ${state.complexity} request into sub-tasks`,
			{
				clarificationPrompt: undefined,
				subTaskTitles: state.subTasks.map((task) => task.title),
			},
		);

		log.info("Task decomposition complete", {
			executionId: state.executionId,
			subTaskCount: state.subTasks.length,
			subTasks: state.subTasks.map((t) => t.title),
		});

		// ======================================================================
		// Step 4: Execute Sub-Agents in Parallel (Iterative Loop)
		// ======================================================================

		while (
			state.currentIteration < state.maxIterations &&
			!state.goalAchieved &&
			!state.cancelled
		) {
			state.currentIteration++;

			log.info("Starting iteration", {
				executionId: state.executionId,
				iteration: state.currentIteration,
				maxIterations: state.maxIterations,
			});

			updateProgress(
				"executing_subagents",
				`Executing sub-agents (iteration ${state.currentIteration}/${state.maxIterations})`,
			);

			// Execute all sub-agents in parallel, streaming results as each completes.
			// Each arm pushes immediately to state so subAgentResultsQuery returns
			// live results to the SSE poller — no waiting for all to finish.
			state.subAgentResults = [];
			const subAgentPromises = state.subTasks.map((subTask) =>
				executeSubAgent(subTask, input, state.currentIteration).then(
					(result) => {
						state.subAgentResults.push(result);
						// Re-broadcast progress so subAgentsCompleted increments
						// and the SSE poller detects the new result.
						updateProgress(
							"executing_subagents",
							`Executing sub-agents (iteration ${state.currentIteration}/${state.maxIterations})`,
						);
						return result;
					},
				),
			);

			// Wait for all to complete (results already pushed incrementally above)
			await Promise.all(subAgentPromises);

			log.info("Sub-agent execution complete", {
				executionId: state.executionId,
				iteration: state.currentIteration,
				completed: state.subAgentResults.filter(
					(r) => r.status === "completed",
				).length,
				failed: state.subAgentResults.filter(
					(r) => r.status === "failed",
				).length,
			});

			if (state.cancelled) {
				return buildCancelledOutput(state, startTime);
			}

			// ==================================================================
			// Step 5: Aggregate Results
			// ==================================================================

			updateProgress(
				"aggregating",
				"Synthesizing findings from sub-agents",
			);

			const aggregationResult =
				await aggregationActivities.aggregateResults({
					query: input.query,
					subAgentResults: state.subAgentResults,
					context: input.context,
					userId: input.userId,
					organizationId: input.organizationId,
				});

			state.aggregatedResult = aggregationResult.synthesizedResult;
			state.structuredReport = aggregationResult.structuredReport;

			// ==================================================================
			// Step 6: Evaluate Success Criteria
			// ==================================================================

			updateProgress("evaluating", "Evaluating against success criteria");

			const evaluationResult =
				await aggregationActivities.evaluateSuccess({
					query: input.query,
					result: state.aggregatedResult,
					successCriteria:
						input.successCriteria ||
						"Has the research question been comprehensively answered with evidence from multiple sources?",
					userId: input.userId,
					organizationId: input.organizationId,
				});

			state.goalAchieved = evaluationResult.goalAchieved;

			log.info("Success evaluation complete", {
				executionId: state.executionId,
				iteration: state.currentIteration,
				goalAchieved: state.goalAchieved,
				confidence: evaluationResult.confidence,
				feedback: evaluationResult.feedback,
			});

			if (
				!state.goalAchieved &&
				state.currentIteration < state.maxIterations
			) {
				updateProgress(
					"iterating",
					`Goal not achieved, preparing iteration ${state.currentIteration + 1}`,
				);

				// Update sub-tasks based on feedback for next iteration
				if (evaluationResult.feedback) {
					const refinedTasks =
						await analysisActivities.refineSubTasks({
							originalQuery: input.query,
							currentSubTasks: state.subTasks,
							previousResults: state.subAgentResults,
							feedback: evaluationResult.feedback,
							userId: input.userId,
							organizationId: input.organizationId,
						});
					state.subTasks = refinedTasks.subTasks;
				}
			}
		}

		// ======================================================================
		// Step 7: Build Final Output
		// ======================================================================

		if (state.cancelled) {
			return buildCancelledOutput(state, startTime);
		}

		state.status = "completed";
		updateProgress("completed", "Deep research completed");

		// Extract key findings from aggregation
		const keyFindings = extractKeyFindings(state.subAgentResults);
		const allSources = collectSources(state.subAgentResults);

		return {
			executionId: state.executionId,
			status: "completed",
			result: state.aggregatedResult || undefined,
			summary: generateExecutiveSummary(
				input.query,
				state.aggregatedResult,
				keyFindings,
			),
			keyFindings,
			sources: allSources,
			subAgentResults: state.subAgentResults,
			iterations: state.currentIteration,
			goalAchieved: state.goalAchieved,
			duration: Date.now() - startTime,
			structuredReport: state.structuredReport ?? undefined,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		log.error("Deep researcher workflow failed", {
			executionId: state.executionId,
			error: errorMessage,
		});

		state.status = "failed";
		updateProgress("failed", `Failed: ${errorMessage}`);

		return {
			executionId: state.executionId,
			status: "failed",
			subAgentResults: state.subAgentResults,
			iterations: state.currentIteration,
			goalAchieved: false,
			duration: Date.now() - startTime,
			error: errorMessage,
		};
	}
}

// =============================================================================
// Helper Functions
// =============================================================================

async function executeSubAgent(
	subTask: SubTask,
	input: DeepResearcherInput,
	iteration: number,
): Promise<SubAgentResult> {
	const startTime = Date.now();

	try {
		const result = await executionActivities.executeSubAgent({
			subTask,
			parentQuery: input.query,
			context: input.context,
			userId: input.userId,
			organizationId: input.organizationId,
			availableTools: input.availableTools,
			knowledgeSources: input.knowledgeSources,
			workspaceIds: input.workspaceIds,
			projectId: input.projectId,
			reasoningEffort: input.reasoningEffort,
			iteration,
		});

		return {
			subTaskId: subTask.id,
			title: subTask.title,
			status: "completed",
			findings: result.findings,
			sources: result.sources,
			confidence: result.confidence,
			duration: Date.now() - startTime,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		log.warn("Sub-agent execution failed", {
			subTaskId: subTask.id,
			title: subTask.title,
			error: errorMessage,
		});

		return {
			subTaskId: subTask.id,
			title: subTask.title,
			status: "failed",
			findings: "",
			sources: [],
			confidence: 0,
			error: errorMessage,
			duration: Date.now() - startTime,
		};
	}
}

function buildCancelledOutput(
	state: DeepResearcherState,
	startTime: number,
): DeepResearcherOutput {
	return {
		executionId: state.executionId,
		status: "cancelled",
		subAgentResults: state.subAgentResults,
		iterations: state.currentIteration,
		goalAchieved: false,
		duration: Date.now() - startTime,
	};
}

function extractKeyFindings(
	results: SubAgentResult[],
): Array<{ theme: string; findings: string[]; confidence: number }> {
	const completedResults = results.filter((r) => r.status === "completed");

	return completedResults.map((r) => ({
		theme: r.title,
		findings: r.findings.split("\n").filter((f) => f.trim().length > 0),
		confidence: r.confidence,
	}));
}

function collectSources(results: SubAgentResult[]): string[] {
	const sources = new Set<string>();

	for (const result of results) {
		for (const source of result.sources) {
			sources.add(source);
		}
	}

	return Array.from(sources);
}

function generateExecutiveSummary(
	query: string,
	result: string | null,
	keyFindings: Array<{
		theme: string;
		findings: string[];
		confidence: number;
	}>,
): string {
	if (!result) {
		return "Research could not be completed.";
	}

	const highConfidenceFindings = keyFindings.filter(
		(f) => f.confidence >= 70,
	);
	const avgConfidence =
		keyFindings.length > 0
			? keyFindings.reduce((sum, f) => sum + f.confidence, 0) /
				keyFindings.length
			: 0;

	return `## Executive Summary

**Research Question:** ${query}

**Confidence Level:** ${avgConfidence.toFixed(0)}%

**Key Themes Investigated:** ${keyFindings.map((f) => f.theme).join(", ")}

**High-Confidence Findings:** ${highConfidenceFindings.length} of ${keyFindings.length} themes

---

${result}`;
}
