/**
 * Durable runs on `/api/copilotkit`: the document, feature and topic
 * assistants' agent (`project_document_generator`) runs on Temporal through
 * `AgUiAgentEngine`, so a closed tab no longer ends a run and the next mount
 * reattaches to it. Every other agent keeps the route's in-memory runner,
 * exactly as before, and so does the durable agent's run whenever the
 * durable path cannot take it (no Redis, no workflow start, no worker pickup).
 *
 * That in-memory runner is the route's own (`./proposal-run-runner`), not a
 * bare CopilotKit one: it keeps the Proposal chat's server-only
 * `forwardedProps` out of the events it stores and streams, and serves a
 * thread only to its owner. A durable run hands the agent the same run input
 * through the parked input the worker reads; the events the worker stores
 * carry neither the state nor the `forwardedProps` (`RunEventWriter`).
 *
 * Gated per organization by `COPILOTKIT_DURABLE_ASSISTANTS` (default off).
 *
 * Built per request for the authenticated caller, from what the route already
 * resolved: the model hints, and the request's AI token, which the engine
 * hands the worker only inside the run's Redis input record. The guard
 * refuses a run, connect or stop on someone else's thread with a 403 before
 * the runtime sees the request; the engine refuses it again.
 */
import type {
	AgentRunner,
	HandlerHookContext,
	RouteInfo,
} from "@copilotkit/runtime/v2";
import { isFeatureEnabled } from "@repo/database";
import {
	AG_UI_DURABLE_AGENT_ID,
	AgUiAgentEngine,
	type AgUiRunSettings,
} from "@saas/agents/runtime/ag-ui-agent-engine";
import { FabricTemporalRunner } from "@saas/agents/runtime/fabric-temporal-runner";
import { z } from "zod";
import { COPILOTKIT_RUN_STREAM_WINDOW_MS } from "./config";

/** A single-route envelope's body names the thread for a run or a connect. */
const envelopeSchema = z.object({
	body: z.object({ threadId: z.string() }),
});

/**
 * The durable thread a request acts on, or null when it is not a durable
 * agent's run, connect or stop. An envelope without a thread id yields "",
 * which no thread check accepts.
 */
async function durableThreadOf(
	route: RouteInfo,
	request: Request,
): Promise<string | null> {
	switch (route.method) {
		case "agent/stop":
			return route.agentId === AG_UI_DURABLE_AGENT_ID
				? route.threadId
				: null;
		case "agent/run":
		case "agent/connect": {
			if (route.agentId !== AG_UI_DURABLE_AGENT_ID) {
				return null;
			}
			const envelope = envelopeSchema.safeParse(
				await request
					.clone()
					.json()
					.catch(() => null),
			);
			return envelope.success ? envelope.data.body.threadId : "";
		}
		// Routes that never reach the durable engine: nothing to guard.
		case "agent/suggest":
		case "trajectory/connect":
		case "info":
		case "inspector/metadata":
		case "inspector/learning":
		case "transcribe":
		case "threads/list":
		case "threads/subscribe":
		case "threads/update":
		case "threads/archive":
		case "threads/messages":
		case "threads/events":
		case "threads/state":
		case "threads/clear":
		case "memories/list":
		case "memories/recall":
		case "memories/subscribe":
		case "memories/mutate":
		case "annotate":
		case "cpk-debug-events":
			return null;
		default: {
			const unhandled: never = route;
			throw new Error(`Unhandled route: ${JSON.stringify(unhandled)}`);
		}
	}
}

export interface CopilotDurableRuntime {
	runner: FabricTemporalRunner;
	onBeforeHandler: (
		context: Pick<HandlerHookContext, "route" | "request">,
	) => Promise<void>;
}

/**
 * The durable runner and its guard for this request, or null while
 * `COPILOTKIT_DURABLE_ASSISTANTS` is off for the caller's organization: the
 * route then keeps its in-memory runner and no hook, exactly as before
 * durable runs, with no Redis and no Temporal involved.
 *
 * `inProcess` is the route's in-memory runner for this request: it serves the
 * other agents and the durable agent's in-process fallback.
 */
export async function copilotDurableRuntime(
	caller: { userId: string; organizationId: string },
	settings: AgUiRunSettings,
	inProcess: AgentRunner,
): Promise<CopilotDurableRuntime | null> {
	if (
		!(await isFeatureEnabled(
			"COPILOTKIT_DURABLE_ASSISTANTS",
			caller.organizationId,
		))
	) {
		return null;
	}
	// One in-memory runner for both: the other agents' runs, and the durable
	// agent's in-process fallback (`AgUiAgentEngine`), so a stop or connect
	// finds a fallen-back run where it runs.
	const engine = new AgUiAgentEngine(caller, settings, { inProcess });
	return {
		runner: new FabricTemporalRunner(
			{ [AG_UI_DURABLE_AGENT_ID]: engine },
			COPILOTKIT_RUN_STREAM_WINDOW_MS,
			inProcess,
		),
		onBeforeHandler: async ({ route, request }) => {
			const threadId = await durableThreadOf(route, request);
			if (threadId !== null && (await engine.refusesThread(threadId))) {
				throw Response.json(
					{
						error: "Forbidden",
						message: "This thread is not accessible.",
					},
					{ status: 403 },
				);
			}
		},
	};
}
