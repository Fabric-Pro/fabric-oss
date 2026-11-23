import { getAgentImplementationAvailability } from "@repo/agent-types/agent-implementation";
import { FABRIC_AGENT_IDENTITY } from "@repo/ai/lib/fabric-agent-identity";
import {
	db,
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
import { retrieveWorkspaceDocumentsActivity } from "./direct-chat/rag-retrieval";
import { parlumeFingerprint } from "./parlume-action-policy";
import { PARLUME_WORKSPACE_RAG_CHUNKS } from "./parlume-voice-context";
import { timeTurnStep } from "./shared/turn-timing";

/**
 * The project agent's own memory tool. A meeting turn neither recalls nor
 * writes memories: they belong to the inviter and the agent, not the room.
 */
const AGENT_MEMORY_TOOL = "agent-memory";

interface ParlumeAgentSession {
	id: string;
	agentKind: "FABRIC_AGENT" | "TEMPLATE_INSTANCE";
	agentInstanceSId: string | null;
	projectId: string;
	organizationId: string;
	userId: string;
}

const jsonObject = z.record(z.string(), z.unknown());

/**
 * The agent a meeting turn runs, as configured now. A meeting answer draws
 * on the meeting's project and Fabric's own tools alone: the agent's MCP
 * servers, OAuth integrations and workspaces never reach a meeting, as they
 * would show what other systems hold to people who may not have access to
 * them. An empty list is passed on as "none" rather than "unset", which
 * `collectMcpToolsActivity` would read back from the saved chat preference.
 */
export async function loadParlumeAgent(session: ParlumeAgentSession) {
	if (session.agentKind === "FABRIC_AGENT") {
		const preferences = await getOrchestratorPreferences(
			session.userId,
			session.organizationId,
		);
		const reasoningMode: "lite" | "pro" | "balanced" =
			preferences?.reasoningMode === "deep" ||
			preferences?.reasoningMode === "planner"
				? "pro"
				: (preferences?.reasoningMode ?? "balanced");
		const enabledMcpConfigIds: string[] = [];
		const workspaceIds: string[] = [];
		return {
			kind: "FABRIC_AGENT" as const,
			revision: parlumeFingerprint({
				identity: FABRIC_AGENT_IDENTITY,
				enabledMcpConfigIds,
				reasoningMode,
				workspaceIds,
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
		include: { template: true },
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
	if (
		!getAgentImplementationAvailability(instance.customInstructions)
			.available
	) {
		throw new Error(
			"The selected agent implementation is unavailable for execution.",
		);
	}
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
		integrationConfigurations: [],
		mcpConfigIds: [],
		toolConnections: z
			.record(z.string(), jsonObject)
			.parse(instance.toolConnections ?? {}),
		workspaceIds: [],
	};
	return {
		kind: "TEMPLATE_INSTANCE" as const,
		revision: parlumeFingerprint({ config }),
		config,
	};
}

type ParlumeAgent = Awaited<ReturnType<typeof loadParlumeAgent>>;

/**
 * What the Fabric Agent looks up for a request before it runs: its MCP tools
 * and the agent's workspace documents. None of it depends on the meeting
 * context, so a turn starts it alongside that context's lookups. A meeting
 * turn recalls no memories: the inviter's are not the room's to hear. The
 * workspace documents are searched as the participant who asked.
 */
export function gatherParlumeAgentContext(
	agent: Extract<ParlumeAgent, { kind: "FABRIC_AGENT" }>,
	session: ParlumeAgentSession,
	message: string,
	requesterUserId: string,
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
			timeTurnStep("agent.workspaceMs", () =>
				retrieveWorkspaceDocumentsActivity(
					message,
					requesterUserId,
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
	/**
	 * The confirmed participant who asked. The agent's knowledge is searched
	 * with their access; Fabric's own tools read with it through the acting
	 * grant. The agent, its model and its spend stay the inviter's.
	 */
	requesterUserId: string;
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
		const [{ mcpToolInfo }, workspace] = await (input.gathered ??
			gatherParlumeAgentContext(
				agent,
				session,
				input.message,
				input.requesterUserId,
			));
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
				// Fabric MCP as the participant who asked (the acting grant is
				// theirs), and the story capability on top of
				// the default tool set. Parlume's action gate decides what any
				// of them may do in a meeting.
				fabricPlatformTools: true,
				fabricPortalTools: true,
				actingGrant: input.actingGrant,
				actingUserId: input.requesterUserId,
				// Tells Fabric MCP the call is Parlume's, so its audit rows
				// name Parlume acting for the inviter.
				surface: "parlume",
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
			"",
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
			loadAgentMemory: false,
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
			userId: input.requesterUserId,
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
		// The built context falls back to MCP servers named in the agent's
		// legacy tool connections, so none are passed whatever it found.
		mcpConfigIds: [],
		integrationConfigurations: [],
		builtInToolNames: context.builtInToolNames.filter(
			(name) => name !== AGENT_MEMORY_TOOL,
		),
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
