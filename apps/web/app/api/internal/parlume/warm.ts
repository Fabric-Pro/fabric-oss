import { mintParlumeActingGrantForTurn } from "@repo/api/lib/agent-service-auth";
import { getTemporalClient } from "@repo/temporal/client";

const WARM_TIMEOUT_MS = 5_000;

/**
 * Warms what the first spoken turn would otherwise start cold, once the bot's
 * audio stream is verified: the worker (a workflow whose activity reads the
 * agent, its tools and the model route), this app's turns function (a GET
 * that opens its database and Temporal connections), and the Fabric MCP
 * gateway function the turn lists Fabric's tools from (a cold start there
 * added about a second to a meeting's first answer). Best effort and nothing
 * waits on it: every failure is swallowed, so a meeting never depends on it.
 */
export async function warmParlumeRuntime(input: {
	origin: string;
	session: {
		id: string;
		userId: string;
		organizationId: string;
		projectId: string;
		toolsReadOnly: boolean;
	};
}): Promise<void> {
	const { session } = input;
	await Promise.allSettled([
		startWarmupWorkflow(session),
		warmTurnsRoute({ origin: input.origin, sessionId: session.id }),
		warmMcpGateway(input.origin),
	]);
}

/** Any answer will do: a GET without credentials loads the gateway's function. */
async function warmMcpGateway(origin: string): Promise<void> {
	await fetch(new URL("/api/mcp-gateway", origin), {
		method: "GET",
		signal: AbortSignal.timeout(WARM_TIMEOUT_MS),
	});
}

// The warm-up lists Fabric's tools as the inviter with the grant a turn gets,
// carried only in the workflow's input.
async function startWarmupWorkflow(
	session: Parameters<typeof warmParlumeRuntime>[0]["session"],
): Promise<void> {
	const temporal = await getTemporalClient();
	await temporal.workflow.start("parlumeWarmupWorkflow", {
		taskQueue: "fabric-worker",
		workflowId: `parlume-warmup-${session.id}`,
		workflowIdConflictPolicy: "USE_EXISTING",
		args: [
			{
				sessionId: session.id,
				actingGrant: mintParlumeActingGrantForTurn({
					userId: session.userId,
					organizationId: session.organizationId,
					projectId: session.projectId,
					readOnly: session.toolsReadOnly,
				}),
			},
		],
	});
}

async function warmTurnsRoute(input: {
	origin: string;
	sessionId: string;
}): Promise<void> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		return;
	}
	const url = new URL("/api/internal/parlume/turns", input.origin);
	url.searchParams.set("sessionId", input.sessionId);
	await fetch(url, {
		method: "GET",
		headers: { "X-Agent-Service-Token": secret },
		signal: AbortSignal.timeout(WARM_TIMEOUT_MS),
	});
}
