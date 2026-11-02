/**
 * The Agent Builder Sidekick's turn, shared by its stream route (`route.ts`)
 * and the agent runtime's `agent-builder-sidekick` engine
 * (`modules/saas/agents/runtime/sidekick-engine.ts`): the rate limit, the
 * access check on the agent being edited, and the model call with the
 * Sidekick's tools. Each caller answers refusals and failures its own way.
 * Nothing is saved.
 *
 * Imports only what the route's tests mock: no feature flags and no ChatGPT
 * plan helpers here.
 */

import { ORPCError } from "@orpc/client";
import { guardToolsAgainstRepeatedCalls } from "@repo/agent-types/repeated-tool-call-guard";
import {
	convertToModelMessages,
	getAIModelWithMetadata,
	isStepCount,
	streamText,
	type UIMessage,
} from "@repo/ai";
import { makeAppendedStepCacheBreakpoint } from "@repo/ai/prompt-cache";
import {
	createSidekickTools,
	type SidekickToolContext,
} from "@repo/ai/sidekick";
import { NEW_AGENT_ID } from "@repo/ai/sidekick/constants";
import { checkRateLimit, RATE_LIMIT_PRESETS } from "@repo/api/lib/rate-limit";
import {
	authorizeInputOrganization,
	Permissions,
} from "@repo/api/orpc/procedures";
import {
	db,
	getOrganizationMembership,
	getRegisteredAgentById,
} from "@repo/database";
import type { ModelMessage } from "ai";
import { buildSidekickPromptCacheRequest } from "./prompt-cache";

/** The entity the Sidekick's tools act for: an unsaved agent is "new". */
export type SidekickToolEntityType = SidekickToolContext["entityType"];

/** One Sidekick turn's charge to the caller's budget (AI preset, 20 per minute per user). */
export function checkSidekickRateLimit(userId: string) {
	return checkRateLimit(
		`sidekick-stream:${userId}`,
		RATE_LIMIT_PRESETS.ai.limit,
		RATE_LIMIT_PRESETS.ai.windowMs,
	);
}

export type SidekickEntityAccess =
	| {
			ok: true;
			/** The tenant the model, tools and billing resolve against. */
			organizationId: string | undefined;
			entityType: SidekickToolEntityType;
			/**
			 * A registered organization agent's organization is deleted. The
			 * route admits its members anyway, as it always has; the agent
			 * runtime refuses them, as `authorizeInputOrganization` refuses an
			 * instance of a deleted organization on both.
			 */
			organizationDeleted: boolean;
	  }
	| { ok: false; status: 403 | 404; error: string };

/**
 * Whether `userId` may work on the agent with the Sidekick, and under which
 * organization. A registered agent and an instance are checked against
 * their own organization (an instance's must not be deleted); an unsaved
 * agent ("new", or the builder's `NEW_AGENT_ID` for any entity type) has
 * nothing to look up and runs in `sessionOrganizationId`. An unexpected
 * lookup failure is thrown.
 */
export async function authorizeSidekickEntity({
	userId,
	agentId,
	entityType,
	sessionOrganizationId,
}: {
	userId: string;
	agentId: string;
	entityType: "registered" | "instance" | "new";
	sessionOrganizationId: string | undefined;
}): Promise<SidekickEntityAccess> {
	// Resolve tenant from the *entity being edited*, not from the
	// session's active organization. A user can open an instance from a
	// different org than their active one; we must
	// run model/tool resolution against that tenant, not the session's.
	let organizationId: string | undefined = sessionOrganizationId;
	let organizationDeleted = false;

	// Verify the user has access to the target entity before streaming.
	// Branches by entityType so Sidekick can assist both RegisteredAgent
	// config editing and AgentTemplateInstance form editing.
	const isNewAgent = entityType === "new" || agentId === NEW_AGENT_ID;
	if (!isNewAgent) {
		if (entityType === "registered") {
			const agent = await getRegisteredAgentById(agentId);
			if (!agent) {
				return { ok: false, status: 404, error: "Agent not found" };
			}
			if (agent.scope === "SYSTEM") {
				return {
					ok: false,
					status: 403,
					error: "System agents cannot be modified via Sidekick",
				};
			}
			if (agent.scope === "USER" && agent.userId !== userId) {
				return { ok: false, status: 403, error: "Forbidden" };
			}
			if (agent.scope === "ORGANIZATION") {
				if (!agent.organizationId) {
					return { ok: false, status: 403, error: "Forbidden" };
				}
				const membership = await getOrganizationMembership(
					agent.organizationId,
					userId,
				);
				if (!membership) {
					return { ok: false, status: 403, error: "Forbidden" };
				}
				organizationDeleted =
					membership.organization.deletedAt !== null;
			}
			// The registered agent's tenant wins over the session's active org.
			organizationId = agent.organizationId ?? undefined;
		} else {
			// authorizeInputOrganization checks membership, organization liveness,
			// and AGENT_TEMPLATE_READ in the instance's organization, including for its creator.
			const instance = await db.agentTemplateInstance.findUnique({
				where: { id: agentId },
				select: { userId: true, organizationId: true },
			});
			if (!instance || !instance.organizationId) {
				return { ok: false, status: 404, error: "Agent not found" };
			}
			try {
				await authorizeInputOrganization(
					Permissions.AGENT_TEMPLATE_READ,
					instance.organizationId,
					{
						user: { id: userId },
						session: {
							activeOrganizationId: sessionOrganizationId ?? null,
						},
					},
					{ requireOrganization: true },
				);
			} catch (error) {
				if (
					!(error instanceof ORPCError) ||
					(error.code !== "FORBIDDEN" &&
						error.code !== "UNAUTHORIZED")
				) {
					throw error;
				}
				return { ok: false, status: 403, error: "Forbidden" };
			}
			organizationId = instance.organizationId;
		}
	}
	return {
		ok: true,
		organizationId,
		entityType: isNewAgent ? "new" : entityType,
		organizationDeleted,
	};
}

/**
 * The Sidekick's model call for one turn: the conversation so far (AI SDK
 * messages, tool calls included) with the form as it is now, on the model
 * the entity's organization resolves, with the Sidekick's tools, up to five
 * steps. `abortSignal` stops the model call (the runtime's stop); the route
 * passes none.
 */
export async function streamSidekickTurn({
	userId,
	agentId,
	entityType,
	organizationId,
	messages,
	formSnapshot,
	abortSignal,
}: {
	userId: string;
	agentId: string;
	entityType: SidekickToolEntityType;
	organizationId: string | undefined;
	messages: UIMessage[];
	formSnapshot: Record<string, unknown>;
	abortSignal?: AbortSignal;
}) {
	// Convert client UIMessages to model messages (preserves tool call structure)
	const modelMessages = await convertToModelMessages(messages);
	withSidekickAgentContext(modelMessages, formSnapshot);

	// Get AI model via centralized entry point — use the entity's tenant
	// so model catalog + billing resolve against the right org.
	const {
		model: aiModel,
		metadata,
		trackUsage,
	} = await getAIModelWithMetadata(
		{ taskType: "CHAT" },
		{
			userId,
			organizationId,
			featureKey: "chat-agent",
			// A person is typing this turn, so it may run on their own
			// ChatGPT plan where they turned it on.
			planEligible: true,
		},
	);

	// Track usage (fire-and-forget)
	trackUsage();

	// Create Sidekick tools. Persistence-capable tools only engage for
	// "registered" agents; "new" and "instance" fall through to the
	// auto-apply path so the frontend writes changes straight into the
	// form state.
	const tools = createSidekickTools({
		agentId,
		entityType,
		userId,
		organizationId,
	});
	guardToolsAgainstRepeatedCalls(tools, {
		onRepeat: (toolName, count) => {
			console.warn("Sidekick tool returned a repeated result", {
				toolName,
				count,
			});
		},
	});

	// Stream the response using the full message history from the client
	// (includes tool calls and results with proper structure)
	const promptCacheRequest = buildSidekickPromptCacheRequest({
		provider: metadata.provider,
		modelString: metadata.modelString,
		messages: modelMessages,
	});
	// Each tool round resends the history and every earlier round. The
	// history marker placed above serves the next turn, so the rolling
	// per-step marker keeps it and moves only over this turn's rounds.
	const prepareStep = makeAppendedStepCacheBreakpoint({
		provider: metadata.provider,
		modelString: metadata.modelString,
		hasTools: Object.keys(tools).length > 0,
	});
	return streamText({
		model: aiModel,
		instructions: promptCacheRequest.system,
		messages: promptCacheRequest.messages,
		tools,
		stopWhen: isStepCount(5),
		...(prepareStep ? { prepareStep } : {}),
		...(abortSignal ? { abortSignal } : {}),
	});
}

/**
 * Put the form as it is now in front of the last user message, and strip
 * the copies earlier turns carried. Mutates `modelMessages`.
 */
function withSidekickAgentContext(
	modelMessages: ModelMessage[],
	formSnapshot: Record<string, unknown>,
): void {
	// Strip prior <agent_context> blocks from all user messages to prevent
	// quadratic token growth (each turn previously accumulated all prior snapshots).
	const agentContextRegex =
		/<agent_context>\n[\s\S]*?\n<\/agent_context>\n\n/g;
	for (const msg of modelMessages) {
		if (msg.role !== "user") {
			continue;
		}
		if (typeof msg.content === "string") {
			msg.content = msg.content.replace(agentContextRegex, "");
		} else if (Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (part.type === "text" && "text" in part) {
					part.text = part.text.replace(agentContextRegex, "");
				}
			}
		}
	}

	// Inject fresh <agent_context> into the last user message so the LLM
	// sees the current form state alongside the user's request.
	const contextBlock = `<agent_context>\n${JSON.stringify(formSnapshot)}\n</agent_context>\n\n`;
	for (let i = modelMessages.length - 1; i >= 0; i--) {
		const msg = modelMessages[i];
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				msg.content = contextBlock + msg.content;
			} else if (Array.isArray(msg.content)) {
				const textPart = msg.content.find((p) => p.type === "text");
				if (textPart && "text" in textPart) {
					textPart.text = contextBlock + textPart.text;
				}
			}
			break;
		}
	}
}
