import { getDefaultEnabledMcpConfigIds } from "@repo/agent-core/backend";
import { FABRIC_AGENT_IDENTITY } from "@repo/ai/lib/fabric-agent-identity";
import {
	db,
	filterWorkspaceIdsForTenant,
	getBuiltInToolConfig,
	getOrchestratorPreferences,
} from "@repo/database";
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
		const enabledMcpConfigIds = !selected.length
			? selected
			: [...new Set([...selected, ...defaultMcpIds])];
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

export async function executeParlumeAgent(input: {
	agent: Awaited<ReturnType<typeof loadParlumeAgent>>;
	session: ParlumeAgentSession;
	turnId: string;
	message: string;
	voiceInstructions: string;
	knowledgeContext: string;
	history: Array<{ role: "user" | "assistant"; content: string }>;
	confirmation: boolean;
}): Promise<{ success: boolean; response: string; error?: string }> {
	const { agent, session } = input;
	if (agent.kind === "FABRIC_AGENT") {
		const [{ mcpToolInfo }, memory, workspace] = await Promise.all([
			collectMcpToolsActivity(
				session.userId,
				session.organizationId,
				agent.enabledMcpConfigIds,
			),
			input.confirmation
				? null
				: generateMemoryContextActivity(
						input.message,
						session.userId,
						session.organizationId,
					),
			input.confirmation
				? null
				: retrieveWorkspaceDocumentsActivity(
						input.message,
						session.userId,
						session.organizationId,
						agent.workspaceIds,
					),
		]);
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
				reasoningMode: agent.reasoningMode,
				workspaceIds: agent.workspaceIds,
				systemPrompt: `${FABRIC_AGENT_IDENTITY}\n\n${input.voiceInstructions}`,
				ragContext: [input.knowledgeContext, workspace?.context]
					.filter(Boolean)
					.join("\n\n"),
			},
			mcpToolInfo,
			memory?.context ?? "",
			"",
		);
		return {
			success: result.success,
			response: result.responseText ?? "",
			error: result.error,
		};
	}
	const context = await buildExecutionContext({
		config: agent.config,
		input: { message: input.message },
		userId: session.userId,
		organizationId: session.organizationId,
	});
	if (context.projectId !== session.projectId) {
		throw new Error("The selected agent is not bound to this project.");
	}
	const knowledge = input.confirmation
		? null
		: await fetchKnowledge({
				executionId: `parlume-${input.turnId}`,
				context,
				query: input.message,
				userId: session.userId,
				organizationId: session.organizationId,
			});
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
