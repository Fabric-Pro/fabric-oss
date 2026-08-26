/**
 * Workflow Handler
 *
 * Handles steps that execute pre-defined Temporal workflows.
 * Triggers workflow executions and tracks their results.
 */

import { db } from "@repo/database";
import type { ExecuteStepInput, ExecuteStepOutput } from "../../types";
import type {
	HandlerContext,
	HandlerResult,
	StepHandler,
	ToolCallRecord,
} from "./types";

export class WorkflowHandler implements StepHandler {
	readonly name = "workflow";
	readonly capabilities = ["workflow"];

	canHandle(input: ExecuteStepInput): boolean {
		const capability = input.step.capability || "mcp_tool";
		// Handle if capability is workflow AND we have a workflow ID or name
		if (capability !== "workflow") {
			return false;
		}
		// Check if step has workflow info
		const hasWorkflowId = !!input.step.executor;
		const hasWorkflowInInputs = !!(
			input.step.inputs as Record<string, unknown> | undefined
		)?.workflowId;
		return hasWorkflowId || hasWorkflowInInputs;
	}

	async execute(context: HandlerContext): Promise<HandlerResult> {
		const { input } = context;
		console.log(
			`[WorkflowHandler] Executing workflow for step: ${input.step.id}`,
		);

		try {
			const output = await this.executeWorkflow(input, context.toolCalls);
			return {
				handled: true,
				output,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			console.error(
				"[WorkflowHandler] Workflow execution failed:",
				errorMessage,
			);

			// Fall back to LLM/MCP if workflow execution fails
			return {
				handled: false,
				error: errorMessage,
				shouldFallback: true,
				fallbackReason: `Workflow execution failed: ${errorMessage}`,
			};
		}
	}

	private async executeWorkflow(
		input: ExecuteStepInput,
		toolCalls: ToolCallRecord[],
	): Promise<ExecuteStepOutput> {
		// Get workflow ID from step executor or inputs
		const workflowId =
			input.step.executor ||
			((input.step.inputs as Record<string, unknown> | undefined)
				?.workflowId as string);

		if (!workflowId) {
			throw new Error("No workflow ID specified in step");
		}

		console.log(`[WorkflowHandler] Looking up workflow: ${workflowId}`);

		// Look up the workflow
		const workflow = await db.workflow.findUnique({
			where: { id: workflowId },
		});

		if (!workflow) {
			// Try finding by name
			const workflowByName = await db.workflow.findFirst({
				where: {
					name: { contains: workflowId, mode: "insensitive" },
					userId: input.userId,
				},
			});

			if (!workflowByName) {
				throw new Error(`Workflow not found: ${workflowId}`);
			}
		}

		const targetWorkflow =
			workflow ||
			(await db.workflow.findFirst({
				where: {
					name: { contains: workflowId, mode: "insensitive" },
					userId: input.userId,
				},
			}));

		if (!targetWorkflow) {
			throw new Error(`Workflow not found: ${workflowId}`);
		}

		// Check if workflow can be triggered manually
		if (targetWorkflow.triggerType !== "MANUAL") {
			return {
				status: "completed",
				response: `Workflow "${targetWorkflow.name}" cannot be triggered manually. It is configured for ${targetWorkflow.triggerType} trigger.`,
				stepId: input.step.id,
				artifacts: [],
				toolCalls,
			};
		}

		// Build variables from step inputs
		const stepInputs = input.step.inputs as
			| Record<string, unknown>
			| undefined;
		const variables = stepInputs?.variables || input.variables || {};

		console.log(
			`[WorkflowHandler] Triggering workflow: ${targetWorkflow.name}`,
		);

		// Create execution record
		const execution = await db.workflowExecution.create({
			data: {
				workflowId: targetWorkflow.id,
				version: targetWorkflow.version,
				userId: input.userId,
				organizationId: input.organizationId,
				status: "PENDING",
				triggerType: "MANUAL",
				triggerInput: JSON.parse(JSON.stringify(variables)),
			},
		});

		// Record the workflow trigger as a tool call
		toolCalls.push({
			id: `wf_${execution.id}`,
			name: `workflow:${targetWorkflow.name}`,
			args: { workflowId: targetWorkflow.id, variables },
			result: {
				executionId: execution.id,
				status: "PENDING",
				message: `Workflow "${targetWorkflow.name}" has been triggered.`,
			},
			status: "success",
			durationMs: 0,
		});

		// Note: Actual workflow execution would be handled asynchronously
		// by the workflow execution system. We just trigger it here.

		return {
			status: "completed",
			response: `Successfully triggered workflow "${targetWorkflow.name}". Execution ID: ${execution.id}. The workflow will run asynchronously.`,
			stepId: input.step.id,
			artifacts: [
				{
					id: `artifact_${execution.id}`,
					type: "data",
					name: "Workflow Execution",
					content: JSON.stringify({
						workflowId: targetWorkflow.id,
						workflowName: targetWorkflow.name,
						executionId: execution.id,
						status: "PENDING",
					}),
					metadata: {
						workflowId: targetWorkflow.id,
						executionId: execution.id,
					},
				},
			],
			toolCalls,
		};
	}
}
