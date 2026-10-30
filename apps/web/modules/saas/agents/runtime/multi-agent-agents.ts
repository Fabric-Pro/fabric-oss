import { ORPCError } from "@orpc/client";
import { CHATGPT_PLAN_MODEL_OVERRIDE_PREFIX } from "@repo/agent-types/chatgpt-plan-fetch";
import { checkRegisteredAgentAccess } from "@repo/api/modules/agents/lib/registered-agent-access";
import { listAvailableModels } from "@repo/api/modules/ai-config/lib/available-models";
import {
	authorizeInputOrganization,
	Permissions,
} from "@repo/api/orpc/procedures";
import {
	db,
	getRegisteredAgentByAgentId,
	listWorkflowIntegrations,
} from "@repo/database";
import {
	buildInstanceAgentConfig,
	PLAN_MODEL_AGENT_PREFIX,
} from "@saas/agents/components/FabricChat/shared/agent-selection";
import type { MultiAgentProfile } from "@saas/agents/lib/multi-agent-request";
import type { RuntimeCaller } from "./engine";

/**
 * The agents of a multi-agent message, resolved on the server from the ids
 * the browser sent, as Nexus's picker and `CopilotPage` resolve them in the
 * browser: a registered agent, a template instance of the active
 * organization (its instructions, MCP servers, knowledge bases, Fabric
 * tools, project and OAuth integrations), a provider model or a ChatGPT
 * plan model. An agent the caller cannot see in the active organization is
 * refused, never run with a default scope.
 */

const TEMPLATE_INSTANCE_PREFIX = "template-instance:";
const MODEL_PREFIX = "model:";

/** One picked agent, resolved. */
export interface ResolvedMultiAgent {
	agentId: string;
	name: string;
	vendor?: string;
	profile: MultiAgentProfile;
}

export type MultiAgentResolution =
	| { kind: "resolved"; agents: ResolvedMultiAgent[] }
	| { kind: "refused"; agentId: string; message: string };

type AgentPermission =
	| typeof Permissions.AGENT_READ
	| typeof Permissions.AGENT_TEMPLATE_READ;

/** Whether the caller holds `permission` in the active organization. */
async function permitted(
	caller: RuntimeCaller,
	permission: AgentPermission,
): Promise<boolean> {
	try {
		await authorizeInputOrganization(
			permission,
			caller.organizationId,
			{
				user: { id: caller.userId },
				session: { activeOrganizationId: caller.organizationId },
			},
			{ requireOrganization: true },
		);
		return true;
	} catch (error) {
		if (
			error instanceof ORPCError &&
			(error.code === "FORBIDDEN" || error.code === "UNAUTHORIZED")
		) {
			return false;
		}
		throw error;
	}
}

/** Lookups shared by every pick of one message, made once and only when needed. */
class PickContext {
	private readonly permissions = new Map<AgentPermission, Promise<boolean>>();
	private models: ReturnType<typeof listAvailableModels> | null = null;
	private integrations: ReturnType<typeof listWorkflowIntegrations> | null =
		null;

	constructor(private readonly caller: RuntimeCaller) {}

	permitted(permission: AgentPermission): Promise<boolean> {
		let check = this.permissions.get(permission);
		if (!check) {
			check = permitted(this.caller, permission);
			this.permissions.set(permission, check);
		}
		return check;
	}

	availableModels() {
		this.models ??= listAvailableModels({
			userId: this.caller.userId,
			organizationId: this.caller.organizationId,
			sessionOrganizationId: this.caller.organizationId,
			taskType: "CHAT",
			planTaskType: "TOOL_CALLING",
		});
		return this.models;
	}

	/** The caller's active OAuth connections of these providers (Nexus's `instanceConfigMap`). */
	async integrationIds(providers: string[]): Promise<string[]> {
		if (providers.length === 0) {
			return [];
		}
		this.integrations ??= listWorkflowIntegrations({
			userId: this.caller.userId,
			organizationId: this.caller.organizationId,
		});
		const integrations = await this.integrations;
		return providers.flatMap((provider) =>
			integrations
				.filter(
					(integration) =>
						integration.isActive &&
						integration.provider === provider,
				)
				.map((integration) => integration.id),
		);
	}
}

async function resolveRegisteredAgent(
	context: PickContext,
	caller: RuntimeCaller,
	agentId: string,
): Promise<ResolvedMultiAgent | null> {
	if (!(await context.permitted(Permissions.AGENT_READ))) {
		return null;
	}
	const agent = await getRegisteredAgentByAgentId(agentId);
	if (!agent || agent.status !== "ACTIVE") {
		return null;
	}
	const access = await checkRegisteredAgentAccess(
		agent,
		caller.userId,
		caller.organizationId,
	);
	if (!access.allowed) {
		return null;
	}
	return {
		agentId,
		name: agent.displayName,
		profile: {
			agentId,
			name: agent.displayName,
			description: agent.description,
		},
	};
}

async function resolveTemplateInstance(
	context: PickContext,
	caller: RuntimeCaller,
	agentId: string,
): Promise<ResolvedMultiAgent | null> {
	const id = agentId.slice(TEMPLATE_INSTANCE_PREFIX.length);
	if (!id || !(await context.permitted(Permissions.AGENT_TEMPLATE_READ))) {
		return null;
	}
	// The instance read of `agentTemplates.instances.get`, in the active
	// organization only.
	const instance = await db.agentTemplateInstance.findUnique({
		where: { id },
		include: {
			template: true,
			_count: { select: { mcpServerConfigurations: true } },
			mcpServerConfigurations: {
				where: { isEnabled: true },
				select: { mcpConfigId: true },
			},
		},
	});
	if (!instance || instance.organizationId !== caller.organizationId) {
		return null;
	}
	const config = buildInstanceAgentConfig(instance);
	return {
		agentId,
		name: instance.name,
		profile: {
			agentId,
			name: instance.name,
			description: instance.description,
			instructions: config.instructions,
			// No servers when it names none (not all), as Nexus.
			enabledMcpConfigIds: config.enabledMcpConfigIds,
			workspaceIds: config.workspaceIds,
			instanceId: config.instanceId ?? id,
			enabledFabricToolIds: config.enabledFabricToolIds,
			boundProjectId: config.boundProjectId,
			enabledIntegrationIds: await context.integrationIds(
				config.enabledIntegrationProviders,
			),
		},
	};
}

/**
 * A model pick runs with the chat's own scope (no inherent MCP servers), as
 * Nexus's model agents; only a model the caller's providers serve here.
 */
async function resolveModel(
	context: PickContext,
	agentId: string,
): Promise<ResolvedMultiAgent | null> {
	const available = await context.availableModels();
	if (agentId.startsWith(PLAN_MODEL_AGENT_PREFIX)) {
		const canonicalName = agentId.slice(PLAN_MODEL_AGENT_PREFIX.length);
		const model = available.chatgptPlan?.models.find(
			(candidate) => candidate.canonicalName === canonicalName,
		);
		return model
			? {
					agentId,
					name: model.displayName,
					vendor: "OpenAI",
					profile: {
						agentId,
						name: model.displayName,
						modelOverride: `${CHATGPT_PLAN_MODEL_OVERRIDE_PREFIX}${canonicalName}`,
					},
				}
			: null;
	}
	const canonicalName = agentId.slice(MODEL_PREFIX.length);
	const model = available.models.find(
		(candidate) => candidate.canonicalName === canonicalName,
	);
	return model
		? {
				agentId,
				name: model.displayName,
				vendor: model.vendor,
				profile: {
					agentId,
					name: model.displayName,
					description: model.description,
					modelOverride: canonicalName,
				},
			}
		: null;
}

function resolvePick(
	context: PickContext,
	caller: RuntimeCaller,
	agentId: string,
): Promise<ResolvedMultiAgent | null> {
	if (agentId.startsWith(TEMPLATE_INSTANCE_PREFIX)) {
		return resolveTemplateInstance(context, caller, agentId);
	}
	if (
		agentId.startsWith(MODEL_PREFIX) ||
		agentId.startsWith(PLAN_MODEL_AGENT_PREFIX)
	) {
		return resolveModel(context, agentId);
	}
	return resolveRegisteredAgent(context, caller, agentId);
}

/** Resolve every pick, in order, or refuse the first the caller cannot use. */
export async function resolveMultiAgentPicks(
	caller: RuntimeCaller,
	agentIds: string[],
): Promise<MultiAgentResolution> {
	const context = new PickContext(caller);
	const resolved = await Promise.all(
		agentIds.map((agentId) => resolvePick(context, caller, agentId)),
	);
	const agents: ResolvedMultiAgent[] = [];
	for (const [index, agent] of resolved.entries()) {
		if (!agent) {
			const agentId = agentIds[index] ?? "";
			return {
				kind: "refused",
				agentId,
				message: `The agent "${agentId}" is not available in this organization.`,
			};
		}
		agents.push(agent);
	}
	return { kind: "resolved", agents };
}
