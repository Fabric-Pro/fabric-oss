/**
 * Workflow Builder Execution Workflow
 *
 * Durable workflow for executing visual workflows with node-by-node processing.
 * Supports AI, HTTP, Firecrawl, Linear, Email, and Slack node types.
 *
 * Features:
 * - Pre-flight graph validation (CUGA-inspired)
 * - Step-level validation with risk assessment
 * - Human approval for high-risk operations
 */

import {
	CancellationScope,
	isCancellation,
	log,
	patched,
	proxyActivities,
	sleep,
} from "@temporalio/workflow";
import type * as preflightActivities from "../activities/preflight-validation";
import type * as activities from "../activities/workflow-builder-execution";
import { isNonRetryableNodeType } from "./lib/workflow-builder-nodes";

const {
	executeWorkflowNode,
	updateWorkflowExecutionStatus,
	createWorkflowExecutionLog,
	getWorkflowDefinition,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "10 minutes",
	// Activities on this proxy heartbeat every 10 s (`withHeartbeatTicker`),
	// so this only fires for a worker that has actually died. It was 30 s
	// with nothing heartbeating at all, which killed any node slower than
	// that and retried it — duplicating whatever it had already done.
	heartbeatTimeout: "60 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumInterval: "60s",
		maximumAttempts: 3,
	},
});

/**
 * Same activity, stricter retry policy, for nodes whose failure may leave a
 * completed side effect behind — creating a ticket, sending a message, filing
 * an issue. Steps report business failures by returning `{ success: false }`,
 * so a thrown error here means an infrastructure failure (dropped connection,
 * worker crash, lost response) — exactly the case where the remote write may
 * already have landed and a retry would duplicate it.
 *
 * See `isNonRetryableNodeType`. Changing activity retry options does not alter
 * the workflow's command sequence, so this needs no `patched()` guard.
 */
const { executeWorkflowNode: executeExternalWriteNode } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "60 seconds",
	retry: {
		maximumAttempts: 1,
	},
});

const {
	validateWorkflowGraph,
	preflightValidation,
	createApprovalRequest,
	waitForApproval,
} = proxyActivities<typeof preflightActivities>({
	// `waitForApproval` polls for up to five minutes and heartbeats while it
	// does; the old 30 s heartbeat timeout meant no approval could ever be
	// granted before the wait was killed and restarted.
	startToCloseTimeout: "6 minutes",
	heartbeatTimeout: "60 seconds",
	retry: {
		initialInterval: "1s",
		maximumAttempts: 2,
	},
});

export interface WorkflowBuilderExecutionInput {
	executionId: string;
	workflowId: string;
	userId: string;
	organizationId?: string;
	/** Owning project when the workflow is project-linked — enables the Read-only mode write gate. */
	projectId?: string;
	triggerData?: Record<string, unknown>;
	variables?: Record<string, unknown>;
	// Optional: if provided, use these instead of fetching from database
	nodes?: WorkflowNode[];
	edges?: WorkflowEdge[];
	// Pre-flight validation options
	skipPreflightValidation?: boolean;
	requireApprovalForHighRisk?: boolean;
	approvalThreshold?: number;
}

export interface WorkflowBuilderExecutionOutput {
	executionId: string;
	status: "COMPLETED" | "FAILED" | "CANCELLED";
	outputs: Record<string, unknown>;
	error?: string;
	executedNodes: string[];
	duration: number;
}

interface WorkflowNode {
	id: string;
	type: string;
	data: Record<string, unknown>;
	position: { x: number; y: number };
}

interface WorkflowEdge {
	id: string;
	source: string;
	target: string;
	sourceHandle?: string;
	targetHandle?: string;
}

/**
 * Execute a visual workflow with node-by-node processing
 */
export async function workflowBuilderExecutionWorkflow(
	input: WorkflowBuilderExecutionInput,
): Promise<WorkflowBuilderExecutionOutput> {
	const startTime = Date.now();
	const executedNodes: string[] = [];
	const nodeOutputs: Record<string, unknown> = {};
	const variables = { ...input.variables, ...input.triggerData };

	try {
		// Update status to RUNNING
		await updateWorkflowExecutionStatus({
			executionId: input.executionId,
			status: "RUNNING",
			startedAt: new Date(),
		});

		// Use provided nodes/edges if available, otherwise fetch from database
		let nodes: WorkflowNode[];
		let edges: WorkflowEdge[];
		let projectId = input.projectId;

		if (input.nodes && input.edges) {
			// Use the nodes/edges provided in the input (current UI state)
			nodes = input.nodes;
			edges = input.edges;
		} else {
			// Fetch from database (saved state)
			const workflow = await getWorkflowDefinition({
				workflowId: input.workflowId,
				userId: input.userId,
				organizationId: input.organizationId,
			});

			if (!workflow) {
				throw new Error("Workflow not found");
			}

			nodes = (workflow.nodes as unknown as WorkflowNode[]) || [];
			edges = (workflow.edges as unknown as WorkflowEdge[]) || [];
			projectId = workflow.projectId ?? undefined;
		}

		// === PRE-FLIGHT GRAPH VALIDATION (CUGA-inspired) ===
		if (!input.skipPreflightValidation) {
			const graphValidation = await validateWorkflowGraph({
				workflowId: input.workflowId,
				nodes: nodes.map((n) => ({
					id: n.id,
					type: n.type,
					data: n.data,
				})),
				edges: edges.map((e) => ({
					id: e.id,
					source: e.source,
					target: e.target,
				})),
				userId: input.userId,
				organizationId: input.organizationId,
			});

			if (!graphValidation.valid) {
				const errorMessage = `Pre-flight validation failed: ${graphValidation.errors.join("; ")}`;
				const duration = Date.now() - startTime;
				await updateWorkflowExecutionStatus({
					executionId: input.executionId,
					status: "FAILED",
					error: errorMessage,
					completedAt: new Date(),
					duration,
				});
				return {
					executionId: input.executionId,
					status: "FAILED",
					outputs: {},
					error: errorMessage,
					executedNodes: [],
					duration,
				};
			}

			// Log warnings
			for (const warning of graphValidation.warnings) {
				console.log(`[Workflow] Pre-flight warning: ${warning}`);
			}
		}

		// Build execution graph
		const nodeMap = new Map(nodes.map((n) => [n.id, n]));
		const incomingEdges = new Map<string, string[]>();
		const outgoingEdges = new Map<string, string[]>();

		for (const edge of edges) {
			if (!incomingEdges.has(edge.target)) {
				incomingEdges.set(edge.target, []);
			}
			incomingEdges.get(edge.target)?.push(edge.source);

			if (!outgoingEdges.has(edge.source)) {
				outgoingEdges.set(edge.source, []);
			}
			outgoingEdges.get(edge.source)?.push(edge.target);
		}

		// Find starting nodes (no incoming edges or trigger nodes)
		const startNodes = nodes.filter(
			(n) =>
				!incomingEdges.has(n.id) ||
				incomingEdges.get(n.id)?.length === 0 ||
				n.type === "trigger",
		);

		// Execute nodes in dependency order.
		//
		// `runNode` is the per-node work — input collection, validation,
		// approval, execution, logging — and returns the successors to
		// schedule. Two schedulers drive it: the original one-at-a-time walk,
		// and a wave scheduler that runs every ready node concurrently.
		const executed = new Set<string>();

		/** Execute one node and return the successors it unblocks. */
		async function runNode(nodeId: string): Promise<string[]> {
			const node = nodeMap.get(nodeId);
			if (!node) {
				return [];
			}

			const deps = incomingEdges.get(nodeId) || [];

			// A disabled node is skipped but does not break the chain: its
			// successors still run, with no output recorded for it.
			//
			// Replay-safe without a patch: `enabled` did not exist when any
			// recorded history was written, so this branch is never taken
			// while replaying one.
			if ((node.data as Record<string, unknown>)?.enabled === false) {
				executed.add(nodeId);
				nodeOutputs[nodeId] = null;
				return outgoingEdges.get(nodeId) || [];
			}

			// Collect inputs from predecessor outputs
			// Supports referencing by node ID ($nodeId.field) or by label (NodeLabel.field)
			const nodeInputs: Record<string, unknown> = { ...variables };
			for (const depId of deps) {
				if (nodeOutputs[depId]) {
					// Add by node ID (e.g., $ai-generate-text-abc123.text)
					Object.assign(nodeInputs, {
						[`$${depId}`]: nodeOutputs[depId],
					});

					// Also add by node label if available (e.g., "Generate Text.text")
					const depNode = nodeMap.get(depId);
					if (depNode) {
						const label = (depNode.data as Record<string, unknown>)
							?.label as string;
						if (label) {
							Object.assign(nodeInputs, {
								[label]: nodeOutputs[depId],
							});
						}
					}
				}
			}

			// Also add all previous outputs for non-direct dependencies (for chained references)
			//
			// Both address forms reach the same set. The `$id` form used to be
			// injected only for direct predecessors while labels reached every
			// earlier node, so `{{$someNode.field}}` silently resolved to an
			// empty string two steps down a chain — and the id form is the one
			// recommended precisely because it survives a rename.
			for (const [outputNodeId, output] of Object.entries(nodeOutputs)) {
				const idKey = `$${outputNodeId}`;
				if (!(idKey in nodeInputs)) {
					Object.assign(nodeInputs, { [idKey]: output });
				}

				const outputNode = nodeMap.get(outputNodeId);
				if (outputNode) {
					const label = (outputNode.data as Record<string, unknown>)
						?.label as string;
					if (label && !(label in nodeInputs)) {
						Object.assign(nodeInputs, { [label]: output });
					}
				}
			}

			// === STEP-LEVEL PRE-FLIGHT VALIDATION ===
			if (!input.skipPreflightValidation) {
				// Extract step config - try node.data.config first, then fall back to node.data
				const nodeData = node.data as Record<string, unknown>;
				const stepConfig =
					(nodeData?.config as Record<string, unknown>) ||
					nodeData ||
					{};

				// Node config is user-authored and routinely carries secrets
				// (tokens pasted into a field, credentials in a URL). It used
				// to be dumped here in full — and inside the workflow, so it
				// re-printed on every replay. Only the shape is logged now.
				log.debug("Validating node", {
					nodeId,
					nodeType: node.type,
					configKeys: Object.keys(stepConfig),
				});

				const stepValidation = await preflightValidation({
					executionId: input.executionId,
					stepId: nodeId,
					stepType: node.type,
					stepConfig,
					userId: input.userId,
					organizationId: input.organizationId,
					requireApprovalForHighRisk:
						input.requireApprovalForHighRisk ?? false,
					approvalThreshold: input.approvalThreshold ?? 70,
				});

				if (!stepValidation.valid) {
					const errors = stepValidation.issues
						.map((i) => i.message)
						.join(", ");
					throw new Error(
						`Validation failed for node ${nodeId}: ${errors}`,
					);
				}

				// Handle approval requirement for high-risk steps
				if (
					stepValidation.requiresApproval &&
					stepValidation.riskAssessment
				) {
					const approvalId = await createApprovalRequest({
						executionId: input.executionId,
						stepId: nodeId,
						stepType: node.type,
						riskScore: stepValidation.riskAssessment.score,
						riskFactors: stepValidation.riskAssessment.factors,
						userId: input.userId,
						organizationId: input.organizationId,
					});

					// Wait for human approval
					const approvalResult = await waitForApproval(
						approvalId,
						300000,
					); // 5 min timeout
					if (!approvalResult.approved) {
						throw new Error(
							`Node ${nodeId} was not approved: ${approvalResult.message}`,
						);
					}
				}
			}

			// Execute the node
			// biome-ignore lint/suspicious/noExplicitAny: node.data is untyped graph JSON
			const nodeConfig = ((node.data as any).config ??
				node.data) as Record<string, unknown>;

			// TENANT ISOLATION: Pass userId and organizationId for proper tenant filtering
			await createWorkflowExecutionLog({
				executionId: input.executionId,
				nodeId,
				nodeType: node.type,
				status: "RUNNING",
				startedAt: new Date(),
				// The node's own configuration, not the whole execution context.
				// The column, its redaction and the panel's renderer all existed
				// and nothing ever wrote them. Passing `nodeInputs` would have
				// been the obvious fix and the wrong one: it carries every
				// earlier node's output, so storing it per node is quadratic in
				// graph size against a 200-node ceiling. The config is bounded
				// by what the author typed, and it is what makes a run
				// reproducible — which URL, which prompt, which channel.
				input: nodeConfig,
				userId: input.userId,
				organizationId: input.organizationId,
			});

			// Deterministic under replay — the SDK freezes the clock per
			// workflow task, so this reads the same on every replay.
			const nodeStartedAt = Date.now();

			// Non-idempotent nodes run through the no-retry proxy so an
			// infrastructure failure after the side effect landed does not
			// duplicate the ticket / message / issue.
			const dispatch = isNonRetryableNodeType(node.type)
				? executeExternalWriteNode
				: executeWorkflowNode;

			const result = await dispatch({
				executionId: input.executionId,
				nodeId,
				nodeType: node.type,
				nodeConfig,
				inputs: nodeInputs,
				userId: input.userId,
				organizationId: input.organizationId,
				projectId,
			});

			nodeOutputs[nodeId] = result.output;
			executed.add(nodeId);
			executedNodes.push(nodeId);

			// TENANT ISOLATION: Pass userId and organizationId for proper tenant filtering
			await createWorkflowExecutionLog({
				executionId: input.executionId,
				nodeId,
				nodeType: node.type,
				status: result.success ? "COMPLETED" : "FAILED",
				output: result.output,
				error: result.error,
				completedAt: new Date(),
				duration: Date.now() - nodeStartedAt,
				userId: input.userId,
				organizationId: input.organizationId,
			});

			// Check for failures
			if (!result.success) {
				throw new Error(`Node ${nodeId} failed: ${result.error}`);
			}

			// Handle condition nodes - only follow true/false path
			if (node.type === "condition" && result.output) {
				const conditionResult = result.output as { result: boolean };
				const targetHandle = conditionResult.result ? "true" : "false";
				return edges
					.filter(
						(e) =>
							e.source === nodeId &&
							e.sourceHandle === targetHandle,
					)
					.map((e) => e.target);
			}

			return outgoingEdges.get(nodeId) || [];
		}

		/**
		 * Record the nodes the walk can never reach, then let the run finish.
		 *
		 * A join after a condition is the everyday case: only one branch runs,
		 * so the join's other dependency never executes and the join can never
		 * become ready. That is not a failure — the graph did what its author
		 * drew — but it used to be invisible. The wave scheduler dropped the
		 * node silently, and the original walk re-queued it behind a 100 ms
		 * timer forever, until Temporal's history limit killed the run.
		 *
		 * Both call sites sit behind `patched("builder-requeue-guard")`: the
		 * log writes are new commands, so a history recorded before this
		 * shipped must replay without them.
		 */
		async function markUnreachable(nodeIds: string[]): Promise<void> {
			for (const nodeId of nodeIds) {
				const node = nodeMap.get(nodeId);
				if (!node) {
					continue;
				}
				const missing = (incomingEdges.get(nodeId) || []).filter(
					(d) => !executed.has(d),
				);
				log.warn("Skipping node: dependency can never execute", {
					nodeId,
					missing,
				});
				await createWorkflowExecutionLog({
					executionId: input.executionId,
					nodeId,
					nodeType: node.type,
					status: "SKIPPED",
					error: `Skipped: unreachable dependency (${missing.join(", ")} never executed)`,
					completedAt: new Date(),
					userId: input.userId,
					organizationId: input.organizationId,
				});
			}
		}

		// Independent branches used to run strictly one after another: the
		// scheduler took a single node per iteration and, when its dependencies
		// were not ready, re-queued it behind a 100ms timer. Two branches off
		// the same trigger therefore ran in series, and every not-ready dequeue
		// wrote a timer into workflow history.
		//
		// The wave scheduler runs every ready node concurrently instead. It
		// changes the order commands are emitted in, so it is gated: histories
		// recorded before this shipped replay through the original walk.
		const useConcurrentWaves = patched("workflow-builder-parallel-walk-v1");

		const queue = [...startNodes.map((n) => n.id)];

		if (useConcurrentWaves) {
			while (queue.length > 0) {
				const ready: string[] = [];
				const waiting: string[] = [];

				for (const nodeId of queue) {
					if (executed.has(nodeId) || ready.includes(nodeId)) {
						continue;
					}
					const deps = incomingEdges.get(nodeId) || [];
					if (deps.every((d) => executed.has(d))) {
						ready.push(nodeId);
					} else {
						waiting.push(nodeId);
					}
				}

				queue.length = 0;

				// Nothing can make progress. Previously this span-waited on a
				// timer forever; a graph that cannot advance now stops, and the
				// nodes it could not reach are recorded as skipped so the run
				// history says why they never ran.
				if (ready.length === 0) {
					if (
						waiting.length > 0 &&
						patched("builder-requeue-guard")
					) {
						await markUnreachable(waiting);
					}
					break;
				}

				const successors = await Promise.all(ready.map(runNode));

				for (const nodeId of [...waiting, ...successors.flat()]) {
					if (!(executed.has(nodeId) || queue.includes(nodeId))) {
						queue.push(nodeId);
					}
				}
			}
		} else {
			// Original scheduler, kept for histories recorded before the patch
			// above. Remove with `deprecatePatch` once they age out.
			//
			// Consecutive not-ready dequeues since a node last ran. This walk is
			// sequential — nothing is in flight between iterations — so once
			// every queued node has been dequeued and re-queued without one
			// running, nothing can ever change and the loop would spin on
			// timers until the history limit.
			let stalled = 0;
			while (queue.length > 0) {
				const nodeId = queue.shift();
				if (!nodeId) {
					continue;
				}
				if (executed.has(nodeId)) {
					continue;
				}
				if (!nodeMap.has(nodeId)) {
					continue;
				}

				const deps = incomingEdges.get(nodeId) || [];
				if (!deps.every((d) => executed.has(d))) {
					if (
						stalled > queue.length &&
						patched("builder-requeue-guard")
					) {
						await markUnreachable([nodeId, ...queue]);
						break;
					}
					queue.push(nodeId); // Re-queue if deps not ready
					stalled++;
					await sleep(100);
					continue;
				}
				stalled = 0;

				for (const nextId of await runNode(nodeId)) {
					if (!executed.has(nextId)) {
						queue.push(nextId);
					}
				}
			}
		}

		// Update status to COMPLETED
		const completedDuration = Date.now() - startTime;
		await updateWorkflowExecutionStatus({
			executionId: input.executionId,
			status: "COMPLETED",
			completedAt: new Date(),
			output: nodeOutputs,
			duration: completedDuration,
		});

		return {
			executionId: input.executionId,
			status: "COMPLETED",
			outputs: nodeOutputs,
			executedNodes,
			duration: completedDuration,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		const failedDuration = Date.now() - startTime;
		// A user-requested cancellation is not a failure. Report it as such so
		// the run history distinguishes "I stopped this" from "this broke".
		const cancelled = isCancellation(error);

		// The status write is itself an activity, and every activity in a
		// cancelled workflow is cancelled too — without this scope the write
		// never lands and the execution stays RUNNING forever.
		await CancellationScope.nonCancellable(async () => {
			await updateWorkflowExecutionStatus({
				executionId: input.executionId,
				status: cancelled ? "CANCELLED" : "FAILED",
				error: cancelled ? "Cancelled by user" : errorMessage,
				completedAt: new Date(),
				// Keep what the completed nodes produced — a cancelled run is
				// still worth inspecting.
				output: nodeOutputs,
				duration: failedDuration,
			});
		});

		return {
			executionId: input.executionId,
			status: cancelled ? "CANCELLED" : "FAILED",
			outputs: nodeOutputs,
			error: cancelled ? "Cancelled by user" : errorMessage,
			executedNodes,
			duration: failedDuration,
		};
	}
}
