import {
	filterAccessibleWorkspaceIds,
	getInstanceWithTemplate,
	getOrganizationMembership,
	getTemplateWorkflow,
} from "@repo/database";
import type { DeepResearcherInput, getTemporalClient } from "@repo/temporal";
import { v4 as uuidv4 } from "uuid";

/**
 * A workflow-template run's admission and start, shared by the stream route
 * (`stream/route.ts`) and the agent runtime's deep-researcher engine
 * (`modules/saas/agents/runtime/research-engine.ts`): the request checks,
 * the workflow's input and the start, so both start exactly the same run.
 */

/** The stream route's JSON body; also what the runtime engine passes. */
export interface WorkflowTemplateRunBody {
	templateSlug?: string;
	instanceId?: string;
	query?: string;
	context?: string;
	organizationId?: string | null;
	maxSubAgents?: number;
	maxIterations?: number;
	successCriteria?: string;
	reasoningEffort?: DeepResearcherInput["reasoningEffort"];
}

export interface AdmittedWorkflowTemplateRun {
	templateSlug: string;
	workflowConfig: NonNullable<ReturnType<typeof getTemplateWorkflow>>;
	/** The workflow's input, but for the execution id it is started under. */
	input: Omit<DeepResearcherInput, "executionId">;
}

/**
 * Check a run request and build the workflow's input, or answer it with the
 * stream route's JSON error response (400, 403 or 404).
 */
export async function admitWorkflowTemplateRun(
	userId: string,
	body: WorkflowTemplateRunBody,
): Promise<AdmittedWorkflowTemplateRun | Response> {
	const {
		templateSlug,
		instanceId,
		query,
		context,
		organizationId,
		maxSubAgents,
		maxIterations,
		successCriteria,
		reasoningEffort,
	} = body;

	// Validate required fields
	if (!templateSlug || !query) {
		return new Response(
			JSON.stringify({
				error: "templateSlug and query are required",
			}),
			{
				status: 400,
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	// Check if template has a dedicated workflow
	const workflowConfig = getTemplateWorkflow(templateSlug);
	if (!workflowConfig) {
		return new Response(
			JSON.stringify({
				error: `Template "${templateSlug}" does not have a dedicated workflow. Use the Orchestrator instead.`,
				code: "NO_WORKFLOW",
			}),
			{
				status: 400,
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	// Verify organization membership if organizationId provided
	if (organizationId) {
		const membership = await getOrganizationMembership(
			organizationId,
			userId,
		);
		if (!membership) {
			return new Response(
				JSON.stringify({
					error: "You are not a member of this organization",
					code: "FORBIDDEN",
				}),
				{
					status: 403,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
	}

	// If instanceId provided, validate access
	let instanceContext: string | undefined;
	let instanceWorkspaceIds: string[] = [];
	if (instanceId) {
		const instance = await getInstanceWithTemplate(
			instanceId,
			userId,
			organizationId ?? null,
		);
		if (!instance) {
			return new Response(
				JSON.stringify({
					error: "Instance not found or access denied",
					code: "INSTANCE_NOT_FOUND",
				}),
				{
					status: 404,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// Extract workspace IDs for RAG. An organization's instance is
		// readable by any of its members, so the ids it stores are narrowed
		// to the workspaces this caller can open in this tenant: a workspace
		// the caller cannot open (or another organization's, on rows saved
		// before instance writes bound workspaces to the instance's
		// organization) never enters the workflow input or its history.
		const { allowed, dropped } = await filterAccessibleWorkspaceIds({
			workspaceIds: instance.workspaceIds ?? [],
			userId,
			organizationId: organizationId ?? null,
		});
		if (dropped.length > 0) {
			console.warn(
				"[Workflow Template Stream] Dropping workspaces the caller cannot access",
				{ userId, instanceId, dropped },
			);
		}
		instanceWorkspaceIds = allowed;

		// Build instance context from goal and custom instructions
		const contextParts: string[] = [];

		// Add goal if available
		if (instance.goal) {
			contextParts.push(`Goal: ${instance.goal}`);
		}

		// Add instance description
		if (instance.description) {
			contextParts.push(`Instance Notes: ${instance.description}`);
		}

		// Extract custom instructions (role, additionalContext, constraints)
		if (
			instance.customInstructions &&
			typeof instance.customInstructions === "object"
		) {
			const custom = instance.customInstructions as {
				role?: string;
				additionalContext?: string;
				constraints?: string;
			};

			if (custom.role) {
				contextParts.push(`Custom Role Instructions: ${custom.role}`);
			}
			if (custom.additionalContext) {
				contextParts.push(
					`Additional Context: ${custom.additionalContext}`,
				);
			}
			if (custom.constraints) {
				contextParts.push(`Constraints: ${custom.constraints}`);
			}
		}

		if (contextParts.length > 0) {
			instanceContext = contextParts.join("\n\n");
		}
	}

	return {
		templateSlug,
		workflowConfig,
		input: {
			query,
			userId,
			organizationId: organizationId ?? undefined,
			instanceId,
			context: context || instanceContext,
			maxSubAgents: maxSubAgents ?? workflowConfig.defaultMaxSubAgents,
			maxIterations: maxIterations ?? workflowConfig.defaultMaxIterations,
			successCriteria,
			reasoningEffort,
			workspaceIds:
				instanceWorkspaceIds.length > 0
					? instanceWorkspaceIds
					: undefined,
		},
	};
}

/**
 * A run's execution (and workflow) id. It carries the caller's id, which the
 * stream route's status, cancel and clarification routes check.
 * Format: wf-{userId}-{templateSlug}-{uuid}
 */
export function newWorkflowTemplateExecutionId(
	userId: string,
	templateSlug: string,
): string {
	return `wf-${userId}-${templateSlug}-${uuidv4()}`;
}

/** Start an admitted deep-researcher run under `executionId`. */
export function startDeepResearcherWorkflow(
	temporalClient: Awaited<ReturnType<typeof getTemporalClient>>,
	run: AdmittedWorkflowTemplateRun,
	executionId: string,
) {
	return temporalClient.workflow.start(run.workflowConfig.workflowName, {
		taskQueue: run.workflowConfig.taskQueue,
		workflowId: executionId,
		// A person asked this research question and watches it stream,
		// so every step may run on their ChatGPT plan.
		args: [{ ...run.input, executionId, planEligible: true }],
	});
}
