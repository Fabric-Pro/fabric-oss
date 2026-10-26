import { getDefaultEnabledMcpConfigIds } from "@repo/agent-core/backend";
import { FABRIC_AGENT_IDENTITY } from "@repo/ai/lib/fabric-agent-identity";
import {
	db,
	filterWorkspaceIdsForTenant,
	getBuiltInToolConfig,
	getOrchestratorPreferences,
} from "@repo/database";
import { BUILT_IN_TO_FABRIC_TOOLS } from "@repo/database/prisma/queries/lib/built-in-tool-map";
import { z } from "zod";
import {
	buildKnowledgeContextPrompt,
	executeAgentTurn,
} from "./agent-execution-core";
import {
	buildExecutionContext,
	type DeploymentConfig,
	fetchKnowledge,
} from "./deployment-execution";
import { executeDirectChatActivity } from "./direct-chat/ai-execution";
import { collectMcpToolsActivity } from "./direct-chat/mcp-tools";
import { generateMemoryContextActivity } from "./direct-chat/memory-context";
import { retrieveWorkspaceDocumentsActivity } from "./direct-chat/rag-retrieval";
import { parlumeFingerprint } from "./parlume-action-policy";
import {
	PARLUME_WORKSPACE_RAG_CHUNKS,
	trimParlumeMemory,
} from "./parlume-voice-context";
import { timeTurnStep } from "./shared/turn-timing";

interface ParlumeAgentSession {
	id: string;
	agentKind: "FABRIC_AGENT" | "TEMPLATE_INSTANCE";
	agentInstanceSId: string | null;
	projectId: string;
	organizationId: string;
	userId: string;
}

const jsonObject = z.record(z.string(), z.unknown());

async function loadConnectionBindings(
	session: ParlumeAgentSession,
	mcpConfigIds: string[],
	integrationConfigurations: DeploymentConfig["integrationConfigurations"] = [],
) {
	const integrationIds = integrationConfigurations.map(
		({ integrationId }) => integrationId,
	);
	const usesMicrosoftGraph = integrationConfigurations.some(
		({ integrationType }) =>
			integrationType.toUpperCase() === "MICROSOFT_GRAPH",
	);
	const [mcp, integrations] = await Promise.all([
		mcpConfigIds.length
			? db.mCPConfig.findMany({
					where: {
						id: { in: mcpConfigIds },
						userId: session.userId,
						organizationId: session.organizationId,
					},
					orderBy: { id: "asc" },
					select: {
						id: true,
						mcpServerId: true,
						baseUrl: true,
						commandArgs: true,
						transport: true,
						authType: true,
						apiKeyMethod: true,
						oauthClientId: true,
						scopes: true,
						enabled: true,
						failoverUrl: true,
						atlassianCloudSiteUrl: true,
						atlassianCloudCloudId: true,
						mcpServer: {
							select: {
								defaultUrl: true,
								command: true,
								transport: true,
							},
						},
					},
				})
			: [],
		integrationIds.length
			? db.workflowIntegration.findMany({
					where: {
						organizationId: session.organizationId,
						OR: [
							{ id: { in: integrationIds } },
							...(usesMicrosoftGraph
								? [
										{
											provider:
												"MICROSOFT_GRAPH" as const,
											isActive: true,
											NOT: {
												name: "MICROSOFT_GRAPH_OAUTH_APP",
											},
										},
									]
								: []),
						],
					},
					orderBy: { id: "asc" },
					select: {
						id: true,
						provider: true,
						settings: true,
						isActive: true,
					},
				})
			: [],
	]);
	return { mcp, integrations };
}

export async function loadParlumeAgent(session: ParlumeAgentSession) {
	if (session.agentKind === "FABRIC_AGENT") {
		const [preferences, defaultMcpIds] = await Promise.all([
			getOrchestratorPreferences(session.userId, session.organizationId),
			getDefaultEnabledMcpConfigIds(
				session.userId,
				session.organizationId,
			),
		]);
		const selected = preferences?.enabledMcpConfigIds ?? [];
		// No saved selection reaches no external server, as in the chat. An
		// empty list is passed on as "none" rather than "unset", which
		// `collectMcpToolsActivity` would read back from the same preference.
		const enabledMcpConfigIds = selected.length
			? [...new Set([...selected, ...defaultMcpIds])]
			: [];
		const reasoningMode: "lite" | "pro" | "balanced" =
			preferences?.reasoningMode === "deep" ||
			preferences?.reasoningMode === "planner"
				? "pro"
				: (preferences?.reasoningMode ?? "balanced");
		const { allowed: workspaceIds } = await filterWorkspaceIdsForTenant({
			workspaceIds: preferences?.enabledWorkspaceIds ?? [],
			userId: session.userId,
			organizationId: session.organizationId,
		});
		const connections = await loadConnectionBindings(
			session,
			enabledMcpConfigIds,
		);
		return {
			kind: "FABRIC_AGENT" as const,
			revision: parlumeFingerprint({
				identity: FABRIC_AGENT_IDENTITY,
				enabledMcpConfigIds,
				reasoningMode,
				workspaceIds,
				connections,
			}),
			enabledMcpConfigIds,
			reasoningMode,
			workspaceIds,
		};
	}
	const instance = await db.agentTemplateInstance.findFirst({
		where: {
			sId: session.agentInstanceSId ?? "",
			userId: session.userId,
			organizationId: session.organizationId,
			status: "ACTIVE",
		},
		orderBy: { version: "desc" },
		include: {
			template: true,
			mcpServerConfigurations: {
				where: { isEnabled: true },
				select: { mcpConfigId: true },
			},
			integrationConfigurations: {
				where: { isEnabled: true },
				select: {
					integrationId: true,
					integrationType: true,
					allowedResources: true,
				},
			},
		},
	});
	if (
		!instance ||
		getBuiltInToolConfig(instance.toolConnections, "project-context")
			?.projectId !== session.projectId
	) {
		throw new Error(
			"The selected agent is no longer available in this project.",
		);
	}
	const { allowed: workspaceIds } = await filterWorkspaceIdsForTenant({
		workspaceIds: instance.workspaceIds,
		userId: session.userId,
		organizationId: session.organizationId,
	});
	const config: DeploymentConfig = {
		deploymentId: `parlume-${session.id}`,
		template: { ...instance.template, knowledgeSources: [], tools: [] },
		instance: {
			id: instance.id,
			name: instance.name,
			description: instance.description,
			customInstructions: jsonObject
				.nullable()
				.parse(instance.customInstructions),
			modelOverride: instance.modelOverride,
			modelConfig: jsonObject.nullable().parse(instance.modelConfig),
		},
		integrationConfigurations: instance.integrationConfigurations,
		mcpConfigIds: instance.mcpServerConfigurations.map(
			({ mcpConfigId }) => mcpConfigId,
		),
		toolConnections: z
			.record(z.string(), jsonObject)
			.parse(instance.toolConnections ?? {}),
		workspaceIds,
	};
	return {
		kind: "TEMPLATE_INSTANCE" as const,
		revision: parlumeFingerprint({
			config,
			connections: await loadConnectionBindings(
				session,
				config.mcpConfigIds,
				config.integrationConfigurations,
			),
		}),
		config,
	};
}

type ParlumeAgent = Awaited<ReturnType<typeof loadParlumeAgent>>;

/**
 * What the Fabric Agent looks up for a request before it runs: its MCP tools,
 * the user's memory and the agent's workspace documents. None of it depends on
 * the meeting context, so a turn starts it alongside that context's lookups.
 */
export function gatherParlumeAgentContext(
	agent: Extract<ParlumeAgent, { kind: "FABRIC_AGENT" }>,
	session: ParlumeAgentSession,
	message: string,
) {
	const gathered = timeTurnStep("agent.gatherMs", () =>
		Promise.all([
			timeTurnStep("agent.mcpCollectMs", () =>
				collectMcpToolsActivity(
					session.userId,
					session.organizationId,
					agent.enabledMcpConfigIds,
				),
			),
			timeTurnStep("agent.memoryMs", () =>
				generateMemoryContextActivity(
					message,
					session.userId,
					session.organizationId,
				),
			),
			timeTurnStep("agent.workspaceMs", () =>
				retrieveWorkspaceDocumentsActivity(
					message,
					session.userId,
					session.organizationId,
					agent.workspaceIds,
					undefined,
					PARLUME_WORKSPACE_RAG_CHUNKS,
				),
			),
		]),
	);
	// Awaited by the agent run; a turn that fails before then still settles it.
	gathered.catch(() => {});
	return gathered;
}

export async function executeParlumeAgent(input: {
	agent: ParlumeAgent;
	session: ParlumeAgentSession;
	turnId: string;
	message: string;
	voiceInstructions: string;
	knowledgeContext: string;
	history: Array<{ role: "user" | "assistant"; content: string }>;
	/** From `gatherParlumeAgentContext`, started with the turn's other lookups. */
	gathered?: ReturnType<typeof gatherParlumeAgentContext>;
	/** Minted for this turn by the web route; the worker only carries it. */
	actingGrant?: string;
}): Promise<{ success: boolean; response: string; error?: string }> {
	const { agent, session } = input;
	if (agent.kind === "FABRIC_AGENT") {
		const [{ mcpToolInfo }, memory, workspace] = await (input.gathered ??
			gatherParlumeAgentContext(agent, session, input.message));
		const result = await executeDirectChatActivity(
			{
				executionId: `parlume-${input.turnId}`,
				featureKey: "parlume",
				usageConversationId: session.id,
				message: input.message,
				history: input.history,
				userId: session.userId,
				organizationId: session.organizationId,
				projectId: session.projectId,
				enabledMcpConfigIds: agent.enabledMcpConfigIds,
				// What the interactive Fabric Agent has: Fabric's own tools from
				// Fabric MCP as the inviter, and the story capability on top of
				// the default tool set. Parlume's action gate decides what any
				// of them may do in a meeting.
				fabricPlatformTools: true,
				fabricPortalTools: true,
				actingGrant: input.actingGrant,
				additionalFabricToolIds:
					BUILT_IN_TO_FABRIC_TOOLS["create-story"],
				reasoningMode: agent.reasoningMode,
				workspaceIds: agent.workspaceIds,
				systemPrompt: `${FABRIC_AGENT_IDENTITY}\n\n${input.voiceInstructions}`,
				ragContext: [input.knowledgeContext, workspace?.context]
					.filter(Boolean)
					.join("\n\n"),
			},
			mcpToolInfo,
			trimParlumeMemory(memory.context ?? ""),
			"",
		);
		return {
			success: result.success,
			response: result.responseText ?? "",
			error: result.error,
		};
	}
	const context = await timeTurnStep("agent.buildContextMs", () =>
		buildExecutionContext({
			config: agent.config,
			input: { message: input.message },
			userId: session.userId,
			organizationId: session.organizationId,
		}),
	);
	if (context.projectId !== session.projectId) {
		throw new Error("The selected agent is not bound to this project.");
	}
	const knowledge = await timeTurnStep("agent.knowledgeMs", () =>
		fetchKnowledge({
			executionId: `parlume-${input.turnId}`,
			context,
			query: input.message,
			userId: session.userId,
			organizationId: session.organizationId,
		}),
	);
	return executeAgentTurn({
		systemPrompt: `${context.systemPrompt}\n\n${input.voiceInstructions}`,
		userMessage: input.message,
		knowledgeContext: [
			input.knowledgeContext,
			knowledge ? buildKnowledgeContextPrompt(knowledge.chunks) : null,
		]
			.filter(Boolean)
			.join("\n\n"),
		mcpConfigIds: context.mcpConfigIds,
		integrationConfigurations: context.integrationConfigurations,
		builtInToolNames: context.builtInToolNames,
		workspaceIds: agent.config.workspaceIds,
		model: context.model,
		userId: session.userId,
		organizationId: session.organizationId,
		projectId: session.projectId,
		featureKey: "parlume",
		conversationId: session.id,
		conversationHistory: input.history,
		executionId: `parlume-${input.turnId}`,
		agentInstanceId: context.agentInstanceId,
		callingAgentId: context.agentInstanceId,
		currentDepth: 0,
	});
}
