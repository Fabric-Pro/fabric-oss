import { z } from "zod";

const id = z.string().trim().min(1).max(200);
const ids = z.array(id).max(30).default([]);
export const AGENT_PREVIEW_WORKFLOW = "agentDraftPreviewWorkflow";
export const AGENT_PREVIEW_MAX_BYTES = 128 * 1024;
export const agentPreviewDraftSchema = z.strictObject({
	instanceId: id.optional(),
	name: z.string().trim().max(200).default("Draft agent"),
	instructions: z.string().trim().min(1).max(40_000),
	projectId: id.optional(),
	workspaceIds: ids,
	workspaceDocumentFilters: z
		.array(z.strictObject({ workspaceId: id, documentIds: ids }))
		.max(30)
		.default([]),
	skillIds: ids,
	capabilityIds: ids,
	mcpConfigIds: ids,
	integrationIds: ids,
	executionMode: z
		.enum(["single_turn", "goal_oriented"])
		.default("single_turn"),
	goal: z.string().max(2000).optional(),
	maxIterations: z.number().int().min(1).max(10).default(5),
	expectedOutput: z.string().max(4000).optional(),
	model: z.string().trim().min(1).max(200).optional(),
});
export const agentPreviewStartSchema = z.strictObject({
	draft: agentPreviewDraftSchema,
	userMessage: z.string().trim().min(1).max(20_000),
	idempotencyKey: z.uuid(),
	history: z
		.array(
			z.strictObject({
				role: z.enum(["user", "assistant"]),
				content: z.string().max(20_000),
			}),
		)
		.max(10)
		.default([]),
});
export type AgentPreviewDraft = z.infer<typeof agentPreviewDraftSchema>;
export type AgentPreviewRequest = z.infer<typeof agentPreviewStartSchema>;
export interface AgentPreviewActor {
	userId: string;
	organizationId: string;
}
export interface AgentPreviewSource {
	id: string;
	title: string;
	kind: string;
	revision?: string;
	truncated?: boolean;
}
export interface AgentPreviewToolCall {
	id: string;
	name: string;
	status: "success" | "error";
	durationMs: number;
	message?: string;
}
export interface AgentPreviewState {
	status: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
	phase: string;
	response?: string;
	error?: string;
	toolCalls: AgentPreviewToolCall[];
	sources: AgentPreviewSource[];
	draftHash: string;
}
export interface AgentPreviewWorkflowInput {
	actor: AgentPreviewActor;
	request: AgentPreviewRequest;
	draftHash: string;
}

/** Configuration omissions are refused, never reinterpreted as a passing preview. */
export function agentPreviewUnsupported(draft: AgentPreviewDraft): string[] {
	const issues: string[] = [];
	if (draft.executionMode !== "single_turn")
		issues.push(
			"Goal-oriented loops require a saved-agent run in this preview release.",
		);
	if (draft.mcpConfigIds.length || draft.integrationIds.length)
		issues.push(
			"External connections require a saved-agent run in this preview release.",
		);
	if (draft.capabilityIds.some((value) => value !== "project-context"))
		issues.push(
			"This preview supports project read tools only. Other capabilities require a saved-agent run.",
		);
	if (draft.capabilityIds.includes("project-context") && !draft.projectId)
		issues.push("Attach a project to preview project read tools.");
	return issues;
}
