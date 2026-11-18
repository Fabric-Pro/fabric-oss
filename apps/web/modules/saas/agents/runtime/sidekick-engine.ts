import {
	type AGUIEvent,
	contentToText,
	type Message,
	type RunAgentInput,
} from "@ag-ui/client";
import { runWithAiInteractiveContext } from "@repo/ai/lib/chatgpt-plan/interactive-context";
import { isFeatureEnabled } from "@repo/database";
import {
	SIDEKICK_AGENT_ID,
	type SidekickRunProps,
	sidekickRunPropsSchema,
	sidekickUiMessages,
} from "@saas/agents/lib/sidekick-runtime-protocol";
import {
	authorizeSidekickEntity,
	checkSidekickRateLimit,
	type SidekickToolEntityType,
	streamSidekickTurn,
} from "../../../../app/api/agents/sidekick/stream/sidekick-turn";
import { sidekickStreamErrorText } from "../../../../app/api/agents/sidekick/stream/stream-error-text";
import {
	type InProcessAdmission,
	InProcessEngine,
	type InProcessRun,
} from "./in-process-engine";
import { streamTextRunEvents } from "./stream-text-events";

/**
 * The Agent Builder Sidekick on the agent runtime
 * (`sidekick-runtime-protocol.ts`): the turn its stream route answers as a
 * UI message stream (`sidekick-turn.ts`), as AG-UI events. Served only while
 * `COPILOTKIT_SIDEKICK_CHAT` is on for the organization on screen, within
 * the route's rate limit, and for an agent the route would let the caller
 * edit (`authorizeSidekickEntity`), all checked before any model call. The
 * model, tools and billing use the agent's own organization, as on the
 * route. Nothing is saved.
 */

export { SIDEKICK_AGENT_ID };

interface SidekickTurn {
	agentId: string;
	entityType: SidekickToolEntityType;
	organizationId: string | undefined;
	formSnapshot: Record<string, unknown>;
	messages: Message[];
}

export class SidekickEngine extends InProcessEngine<
	SidekickRunProps,
	SidekickTurn
> {
	readonly agentId = SIDEKICK_AGENT_ID;
	protected readonly propsSchema = sidekickRunPropsSchema;

	protected async admit({
		input,
		props,
	}: {
		input: RunAgentInput;
		props: SidekickRunProps;
	}): Promise<InProcessAdmission<SidekickTurn>> {
		const { userId, organizationId } = this.caller;
		if (
			!(await isFeatureEnabled(
				"COPILOTKIT_SIDEKICK_CHAT",
				organizationId,
			))
		) {
			return {
				ok: false,
				code: "FEATURE_DISABLED",
				message:
					"The Sidekick is not enabled on the agent runtime for this organization.",
			};
		}
		// The route's budget: both transports share it.
		const rateLimit = await checkSidekickRateLimit(userId);
		if (!rateLimit.allowed) {
			return {
				ok: false,
				code: "RATE_LIMITED",
				message: `Rate limit exceeded. Please try again in ${rateLimit.resetInSeconds} seconds.`,
			};
		}
		const last = input.messages.at(-1);
		if (last?.role !== "user" || !contentToText(last.content).trim()) {
			return {
				ok: false,
				code: "NO_MESSAGE",
				message: "A run needs a new user message.",
			};
		}
		// An instance must belong to the organization on screen, as the create
		// page's panel names it to the route. A new agent runs in that
		// organization anyway, and the registered-agent builder names none,
		// so there the agent's own organization decides, as on the route.
		const access = await authorizeSidekickEntity({
			userId,
			agentId: props.agentId,
			entityType: props.entityType,
			sessionOrganizationId: organizationId,
			requestedOrganizationId:
				props.entityType === "instance" ? organizationId : undefined,
		});
		if (!access.ok) {
			return {
				ok: false,
				code: access.status === 403 ? "FORBIDDEN" : "NOT_FOUND",
				message: access.error,
			};
		}
		// The route admits a registered agent of a deleted organization; the
		// runtime does not, as no deleted organization's providers and tools
		// should serve a run during its retention window.
		if (access.organizationDeleted) {
			return { ok: false, code: "FORBIDDEN", message: "Forbidden" };
		}
		return {
			ok: true,
			turn: {
				agentId: props.agentId,
				entityType: access.entityType,
				organizationId: access.organizationId,
				formSnapshot: props.formSnapshot,
				messages: input.messages,
			},
		};
	}

	protected async *turn(
		turn: SidekickTurn,
		{ runId, signal }: InProcessRun,
	): AsyncIterable<AGUIEvent> {
		const { userId, audit } = this.caller;
		// This person's own turn, or an admin acting as them, which no
		// ChatGPT plan may serve. The endpoint marks the request already;
		// the turn says it again for its own model call.
		const result = await runWithAiInteractiveContext(
			{ userId, impersonated: Boolean(audit.session?.impersonatedBy) },
			() =>
				streamSidekickTurn({
					userId,
					agentId: turn.agentId,
					entityType: turn.entityType,
					organizationId: turn.organizationId,
					messages: sidekickUiMessages(turn.messages),
					formSnapshot: turn.formSnapshot,
					abortSignal: signal,
				}),
		);
		yield* streamTextRunEvents(result.stream, {
			runId,
			toolErrorText: sidekickStreamErrorText,
			getAnswerModel: result.getAnswerModel,
		});
	}
}
