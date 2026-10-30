/**
 * The agent runtime: CopilotKit's REST endpoints (`GET /info`,
 * `POST /agent/:agentId/run`, `/connect`, `/stop/:threadId`) for Fabric's
 * chat engines, each run a durable Temporal workflow driven by
 * `FabricTemporalRunner` (`modules/saas/agents/runtime`).
 *
 * Every request is the signed-in caller's, in an organization the caller has
 * a tie to: the `x-fabric-organization-id` header, or the session's active
 * organization. A runtime is built per request for that caller, so no state
 * crosses requests. A thread that belongs to someone else — another user, or
 * the caller in another organization — is refused here before the runtime
 * sees the request, and again by the engine.
 */
import {
	CopilotRuntime,
	createCopilotRuntimeHandler,
	type RouteInfo,
} from "@copilotkit/runtime/v2";
import { enterAiInteractiveContext } from "@repo/ai/lib/chatgpt-plan/interactive-context";
import {
	forbiddenOrganizationResponse,
	resolveRequestedOrganization,
} from "@repo/api/lib/requested-organization";
import {
	DIRECT_AGENT_ID,
	DirectEngine,
} from "@saas/agents/runtime/direct-engine";
import {
	FabricRuntimeAgent,
	FabricTemporalRunner,
	resolveStreamWindowMs,
} from "@saas/agents/runtime/fabric-temporal-runner";
import {
	ORCHESTRATOR_AGENT_ID,
	ORCHESTRATOR_STREAM_WINDOW_MS,
	OrchestratorEngine,
} from "@saas/agents/runtime/orchestrator-engine";
import { readThreadAccess } from "@saas/agents/runtime/thread";
import { getSession } from "@saas/auth/lib/server";
import { z } from "zod";

const BASE_PATH = "/api/agents/runtime";

/** The organization a request runs in; the session's active one when absent. */
const ORGANIZATION_HEADER = "x-fabric-organization-id";

/** Shortens one request's stream window (never lengthens it). */
const STREAM_WINDOW_HEADER = "x-agent-runtime-stream-window-ms";

const threadBodySchema = z.object({ threadId: z.string().min(1) });

function jsonError(status: number, error: string, message: string): Response {
	return Response.json({ error, message }, { status });
}

/**
 * The thread a route acts on, or null for one that names none (`info`).
 * `undefined` means the request is for a route this endpoint does not serve.
 */
async function threadOf(
	route: RouteInfo,
	request: Request,
): Promise<string | null | undefined> {
	switch (route.method) {
		case "info":
			return null;
		case "agent/stop":
			return route.threadId;
		case "agent/run":
		case "agent/connect": {
			const body = threadBodySchema.safeParse(
				await request
					.clone()
					.json()
					.catch(() => null),
			);
			return body.success ? body.data.threadId : "";
		}
		default:
			// Threads, memories, suggestions, inspector, transcription: not
			// part of this runtime; a thread is read through `connect`.
			return undefined;
	}
}

async function handle(request: Request): Promise<Response> {
	const session = await getSession();
	if (!session) {
		return jsonError(
			401,
			"Unauthorized",
			"Sign in to use the agent runtime.",
		);
	}
	enterAiInteractiveContext({
		userId: session.user.id,
		impersonated: Boolean(session.session.impersonatedBy),
	});
	const resolution = await resolveRequestedOrganization({
		userId: session.user.id,
		requestedOrganizationId: request.headers.get(ORGANIZATION_HEADER),
		activeOrganizationId: session.session.activeOrganizationId,
	});
	if (!resolution.ok) {
		return forbiddenOrganizationResponse(resolution);
	}
	const caller = {
		userId: session.user.id,
		organizationId: resolution.organizationId,
		audit: {
			headers: request.headers,
			user: session.user,
			session: session.session,
		},
	};

	const requestedWindow = request.headers.get(STREAM_WINDOW_HEADER);
	const runtime = new CopilotRuntime({
		agents: {
			[DIRECT_AGENT_ID]: new FabricRuntimeAgent(),
			[ORCHESTRATOR_AGENT_ID]: new FabricRuntimeAgent(),
		},
		runner: new FabricTemporalRunner(
			{
				[DIRECT_AGENT_ID]: new DirectEngine(caller),
				// Gated per organization by `COPILOTKIT_ORCHESTRATOR_CHAT`.
				[ORCHESTRATOR_AGENT_ID]: new OrchestratorEngine(
					caller,
					resolveStreamWindowMs(
						requestedWindow,
						ORCHESTRATOR_STREAM_WINDOW_MS,
					),
				),
			},
			resolveStreamWindowMs(requestedWindow),
		),
		// The tenant marker the CopilotKit endpoint puts on telemetry.
		telemetryProperties: {
			_copilotkit: { tenantId: caller.organizationId },
		},
		// As the CopilotKit endpoint: never forward the browser's AI or
		// tenant headers.
		forwardHeaders: { denyPrefixes: ["x-ai-", "x-tenant-"] },
	});
	const handleRequest = createCopilotRuntimeHandler({
		runtime,
		basePath: BASE_PATH,
		hooks: {
			onBeforeHandler: async ({ route, request: routed }) => {
				const threadId = await threadOf(route, routed);
				if (threadId === undefined) {
					throw jsonError(
						404,
						"Not found",
						"Not an agent runtime route.",
					);
				}
				if (threadId === null) {
					return;
				}
				const access = await readThreadAccess(threadId, caller);
				if (access.kind === "forbidden") {
					throw jsonError(
						403,
						"Forbidden",
						"This thread is not accessible.",
					);
				}
			},
		},
	});
	return handleRequest(request);
}

export async function GET(request: Request): Promise<Response> {
	return handle(request);
}

export async function POST(request: Request): Promise<Response> {
	return handle(request);
}

export const runtime = "nodejs";
// The longest stream window (the Orchestrator engine's
// `ORCHESTRATOR_STREAM_WINDOW_MS`, 240 s, which a response may overrun by up
// to 20 s to end at a quiet point) plus room to deliver the reconnect. A
// turn's admission, billing and up to two minutes of document retrieval run
// inside the first window.
export const maxDuration = 300;
