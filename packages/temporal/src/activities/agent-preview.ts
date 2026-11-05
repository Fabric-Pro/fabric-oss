import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { asSchema } from "@repo/ai";
import { db, getSkillById } from "@repo/database";
import {
	getWorkspaceDocumentCatalog,
	readWorkspaceDocumentContent,
} from "@repo/database/prisma/queries/workspaces/document-content";
import { Context, heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { jsonSchema, type ModelMessage, tool } from "ai";
import { z } from "zod";
import {
	assertAgentPreviewAccess,
	previewRequestHash,
	previewWorkflowId,
} from "../lib/agent-preview-access";
import {
	AGENT_PREVIEW_WORKFLOW,
	type AgentPreviewSource,
	type AgentPreviewToolCall,
	type AgentPreviewWorkflowInput,
} from "../lib/agent-preview-contracts";
import { measureSerializedBytes } from "../lib/payload-size-guard";
import {
	buildAgentExecutionContext,
	type ExecuteAgentTurnInput,
} from "./agent-execution-core";
import { executeAgentTurn } from "./agent-execution-core/agent-executor";
import type { SavedAgentToolDecision } from "./agent-execution-core/durable-steps";
import {
	type AgentToolSource,
	isExecutableAgentTool,
	withAgentToolRuntime,
} from "./shared/agent-tool-runtime";

const MAX_BYTES = 128 * 1024;
const WORKSPACE_READ = "preview_read_workspace_document";
const READ_TOOLS = new Set([
	"fabric_list_project_documents",
	"fabric_get_project_document",
	"fabric_list_project_sources",
	"fabric_get_project_source",
	"fabric_list_project_features",
	"fabric_get_project_feature",
]);
const previewDecisionSchema = z.strictObject({
	id: z.string().min(1).max(200),
	name: z.string().min(1).max(200),
	args: z.record(z.string(), z.unknown()),
	source: z.strictObject({
		configId: z.enum(["builtin", "preview"]),
		originalName: z.string().min(1).max(200),
	}),
});
function validPreviewDecision(value: unknown) {
	const parsed = previewDecisionSchema.safeParse(value);
	if (!parsed.success) {
		return false;
	}
	return parsed.data.source.configId === "builtin"
		? READ_TOOLS.has(parsed.data.source.originalName)
		: parsed.data.source.originalName === WORKSPACE_READ;
}
export interface PreparedAgentPreview {
	turn: ExecuteAgentTurnInput;
	documents: Array<{ id: string; workspaceId: string; title: string }>;
	sources: AgentPreviewSource[];
}
interface PreviewStep {
	base: AgentPreviewWorkflowInput;
	prepared: PreparedAgentPreview;
}
function bounded(value: unknown) {
	if (measureSerializedBytes(value) > MAX_BYTES) {
		throw ApplicationFailure.nonRetryable(
			"The preview context is too large. Select fewer documents or skills.",
			"AGENT_PREVIEW_TOO_LARGE",
		);
	}
}
async function authority(base: AgentPreviewWorkflowInput) {
	const info = Context.current().info;
	if (
		!info.workflowExecution ||
		info.workflowType !== AGENT_PREVIEW_WORKFLOW ||
		info.workflowExecution.workflowId !==
			previewWorkflowId(base.actor, base.request.idempotencyKey) ||
		base.draftHash !== previewRequestHash(base.request)
	) {
		throw ApplicationFailure.nonRetryable(
			"The preview identity is invalid.",
			"AGENT_PREVIEW_FORBIDDEN",
		);
	}
	await assertAgentPreviewAccess(base.actor, base.request.draft);
	Context.current().cancellationSignal.throwIfAborted();
}
export async function prepareAgentPreview(
	base: AgentPreviewWorkflowInput,
): Promise<PreparedAgentPreview> {
	const timer = setInterval(() => heartbeat({ phase: "preparing" }), 5000);
	try {
		return await prepareSelectedPreview(base);
	} finally {
		clearInterval(timer);
	}
}
async function prepareSelectedPreview(
	base: AgentPreviewWorkflowInput,
): Promise<PreparedAgentPreview> {
	await authority(base);
	const { draft } = base.request;
	const documents: PreparedAgentPreview["documents"] = [];
	for (const workspaceId of draft.workspaceIds) {
		const selected =
			draft.workspaceDocumentFilters.find(
				(x) => x.workspaceId === workspaceId,
			)?.documentIds ?? [];
		const rows = selected.length
			? await db.workspaceDocument.findMany({
					where: { workspaceId, id: { in: selected } },
					select: { id: true, originalFilename: true, status: true },
					take: 31,
				})
			: undefined;
		const page = rows
			? undefined
			: await getWorkspaceDocumentCatalog(base.actor, {
					workspaceId,
					limit: 31,
				});
		const entries =
			rows?.map((x) => ({
				id: x.id,
				title: x.originalFilename,
				status: x.status,
			})) ??
			page!.documents.map((x) => ({
				id: x.id,
				title: x.filename,
				status: x.status,
			}));
		if (page?.hasMore || documents.length + entries.length > 30) {
			throw ApplicationFailure.nonRetryable(
				"Select at most 30 specific documents for this preview.",
				"AGENT_PREVIEW_TOO_LARGE",
			);
		}
		if (entries.some((x) => x.status !== "READY")) {
			throw ApplicationFailure.nonRetryable(
				"Some selected documents are still processing or unavailable. Select ready documents before previewing.",
				"AGENT_PREVIEW_NOT_READY",
			);
		}
		documents.push(
			...entries.map((x) => ({ id: x.id, title: x.title, workspaceId })),
		);
	}
	const skills: string[] = [];
	const sources: AgentPreviewSource[] = [];
	for (const skillId of draft.skillIds) {
		const skill = await getSkillById(skillId, base.actor);
		if (!skill) {
			throw ApplicationFailure.nonRetryable(
				"A selected skill is unavailable.",
				"AGENT_PREVIEW_FORBIDDEN",
			);
		}
		skills.push(`## Skill: ${skill.name}\n${skill.content}`);
		sources.push({
			id: skill.id,
			title: skill.name,
			kind: "skill",
			revision: createHash("sha256").update(skill.content).digest("hex"),
		});
	}
	const context = buildAgentExecutionContext(
		{
			id: "preview",
			name: draft.name,
			displayName: draft.name,
			description: "Draft preview",
			instructions: "",
			knowledgeSources: [],
			tools: draft.capabilityIds,
			suggestedModel: null,
		},
		{
			id: draft.instanceId ?? "preview",
			name: draft.name,
			description: null,
			customInstructions: {
				role: draft.instructions,
				expectedOutput: draft.expectedOutput,
			},
			modelOverride: draft.model ?? null,
			modelConfig: null,
		},
		{
			integrationConfigurations: [],
			toolConnections: Object.fromEntries(
				draft.capabilityIds.map((x) => [x, { enabled: true }]),
			),
			workspaceIds: [],
		},
		base.actor.userId,
		base.actor.organizationId,
	);
	const prepared: PreparedAgentPreview = {
		documents,
		sources,
		turn: {
			systemPrompt: [
				context.systemPrompt,
				...skills,
				"This is a read-only preview. Use only the provided read tools. Cite document titles and identifiers for facts you read. Do not claim to have performed any write action.",
				documents.length
					? `Selected workspace document catalog (document text must be read with ${WORKSPACE_READ}):\n${JSON.stringify(documents)}`
					: "",
			]
				.filter(Boolean)
				.join("\n\n"),
			userMessage: base.request.userMessage,
			userId: base.actor.userId,
			organizationId: base.actor.organizationId,
			projectId: draft.projectId,
			model: draft.model,
			builtInToolNames: draft.capabilityIds,
			mcpConfigIds: [],
			integrationConfigurations: [],
			workspaceIds: [],
			conversationHistory: base.request.history,
			maxIterations: draft.maxIterations,
		},
	};
	bounded(prepared);
	await authority(base);
	return prepared;
}
async function toolsForPreview(
	step: PreviewStep,
	tools: Record<string, unknown>,
	sources: Record<string, AgentToolSource>,
) {
	for (const name of Object.keys(tools)) {
		if (
			sources[name]?.configId !== "builtin" ||
			!READ_TOOLS.has(sources[name].originalName) ||
			!step.base.request.draft.projectId
		) {
			delete tools[name];
		} else {
			const def = tools[name];
			if (!isExecutableAgentTool(def)) {
				delete tools[name];
				continue;
			}
			const original = asSchema(
				def.inputSchema as Parameters<typeof asSchema>[0],
			);
			// Validate the raw model input before SDK parsing can strip unknown keys or add defaults.
			tools[name] = {
				...def,
				inputSchema: jsonSchema(await original.jsonSchema, {
					validate: async (raw) => {
						const checked = original.validate
							? await original.validate(raw)
							: await z
									.fromJSONSchema(
										(await original.jsonSchema) as Parameters<
											typeof z.fromJSONSchema
										>[0],
									)
									.safeParseAsync(raw)
									.then((x) =>
										x.success
											? {
													success: true as const,
													value: x.data,
												}
											: { success: false as const },
									);
						if (
							!checked.success ||
							!isDeepStrictEqual(checked.value, raw)
						) {
							return {
								success: false,
								error: new Error(
									"Preview tool arguments must match the declared schema exactly.",
								),
							};
						}
						return { success: true, value: checked.value };
					},
				}),
			};
		}
	}
	if (step.prepared.documents.length) {
		tools[WORKSPACE_READ] = tool({
			description:
				"Read a bounded page from a selected workspace document. Use nextOffset and the returned revision to continue. Only the selected documents can be read.",
			inputSchema: z.strictObject({
				documentId: z.string().min(1).max(200),
				offset: z.number().int().min(0).max(2147483646).optional(),
				expectedRevision: z
					.string()
					.regex(/^[a-f0-9]{64}$/)
					.optional(),
			}),
			execute: async (args) => {
				const selected = step.prepared.documents.find(
					(x) => x.id === args.documentId,
				);
				if (!selected) {
					throw new Error(
						"Document is not selected for this preview.",
					);
				}
				return readWorkspaceDocumentContent(step.base.actor, {
					workspaceId: selected.workspaceId,
					documentId: selected.id,
					offset: args.offset ?? 0,
					expectedRevision: args.expectedRevision,
					limit: 12000,
				});
			},
		});
		sources[WORKSPACE_READ] = {
			configId: "preview",
			originalName: WORKSPACE_READ,
		};
	}
}
export async function executeAgentPreviewModelStep(
	input: PreviewStep & { continuationMessages: ModelMessage[] },
) {
	await authority(input.base);
	bounded(input);
	const timer = setInterval(() => heartbeat({ phase: "model" }), 5000);
	try {
		const result = await withAgentToolRuntime(
			{
				invoke: async () => {
					throw new Error("Model decisions cannot execute tools.");
				},
				abortSignal: Context.current().cancellationSignal,
				prepared: async (tools, sources) => {
					await toolsForPreview(input, tools, sources);
					return undefined;
				},
			},
			() =>
				executeAgentTurn({
					...input.prepared.turn,
					durableStep: {
						continuationMessages: input.continuationMessages,
					},
				}),
		);
		await authority(input.base);
		bounded(result);
		if (!result.success || !result.modelStep) {
			throw ApplicationFailure.nonRetryable(
				"The preview model could not complete this step.",
				"AGENT_PREVIEW_MODEL_FAILED",
			);
		}
		if (
			result.modelStep.toolCalls.length > 8 ||
			result.modelStep.toolCalls.some(
				(call) => !validPreviewDecision(call),
			) ||
			new Set(result.modelStep.toolCalls.map((call) => call.id)).size !==
				result.modelStep.toolCalls.length
		) {
			throw ApplicationFailure.nonRetryable(
				"The preview model did not return a valid bounded decision.",
				"AGENT_PREVIEW_MODEL_INVALID_DECISION",
			);
		}
		return result;
	} finally {
		clearInterval(timer);
	}
}
export async function executeAgentPreviewReadStep(
	input: PreviewStep & { decision: SavedAgentToolDecision },
): Promise<{
	call: AgentPreviewToolCall;
	result: unknown;
	source?: AgentPreviewSource;
}> {
	await authority(input.base);
	bounded(input);
	const started = Date.now();
	let output: unknown;
	let dispatched = false;
	const timer = setInterval(() => heartbeat({ phase: "read" }), 5000);
	try {
		const executed = await withAgentToolRuntime(
			{
				invoke: async () => {
					throw new Error(
						"Nested preview tool execution is unavailable.",
					);
				},
				abortSignal: Context.current().cancellationSignal,
				...(input.base.request.draft.projectId
					? {
							projectScope: {
								projectId: input.base.request.draft.projectId,
								...input.base.actor,
							},
						}
					: {}),
				prepared: async (tools, sources) => {
					await toolsForPreview(input, tools, sources);
					const def = tools[input.decision.name],
						source = sources[input.decision.name];
					if (
						!source ||
						source.configId !== input.decision.source.configId ||
						source.originalName !==
							input.decision.source.originalName ||
						!isExecutableAgentTool(def) ||
						def.approvalBoundary === "delegation"
					) {
						throw ApplicationFailure.nonRetryable(
							"This tool is unavailable in a read-only preview.",
							"AGENT_PREVIEW_TOOL_REFUSED",
						);
					}
					const schema = asSchema(
						def.inputSchema as Parameters<typeof asSchema>[0],
					);
					const checked = schema.validate
						? await schema.validate(input.decision.args)
						: await z
								.fromJSONSchema(
									(await schema.jsonSchema) as Parameters<
										typeof z.fromJSONSchema
									>[0],
								)
								.safeParseAsync(input.decision.args)
								.then((x) =>
									x.success
										? {
												success: true as const,
												value: x.data,
											}
										: { success: false as const },
								);
					if (
						!checked.success ||
						!isDeepStrictEqual(checked.value, input.decision.args)
					) {
						throw ApplicationFailure.nonRetryable(
							"The preview tool arguments are invalid.",
							"AGENT_PREVIEW_TOOL_REFUSED",
						);
					}
					await authority(input.base);
					dispatched = true;
					output = await def.execute(checked.value, {
						toolCallId: input.decision.id,
						messages: [],
						abortSignal: Context.current().cancellationSignal,
					});
					bounded(output);
					return "Read completed.";
				},
			},
			() => executeAgentTurn(input.prepared.turn),
		);
		await authority(input.base);
		if (!executed.success || !dispatched) {
			throw ApplicationFailure.nonRetryable(
				"The preview read was not dispatched.",
				"AGENT_PREVIEW_TOOL_REFUSED",
			);
		}
		const row =
			output && typeof output === "object"
				? (output as Record<string, unknown>)
				: {};
		const source =
			typeof row.id === "string" &&
			(typeof row.title === "string" || typeof row.filename === "string")
				? {
						id: row.id,
						title: String(row.title ?? row.filename).slice(0, 500),
						kind:
							input.decision.name === WORKSPACE_READ
								? "workspace_document"
								: "project_source",
						...(typeof row.revision === "string"
							? { revision: row.revision }
							: {}),
						...(typeof row.truncated === "boolean"
							? { truncated: row.truncated }
							: {}),
					}
				: undefined;
		return {
			call: {
				id: input.decision.id,
				name: input.decision.name,
				status: row.error ? "error" : "success",
				...(row.error
					? {
							message:
								"The source could not be read. Check its availability and your current access.",
						}
					: {}),
				durationMs: Date.now() - started,
			},
			result: output ?? null,
			...(source ? { source } : {}),
		};
	} finally {
		clearInterval(timer);
	}
}
