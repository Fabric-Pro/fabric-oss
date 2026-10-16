import { getTemporalClient } from "@repo/temporal";

const WARM_TIMEOUT_MS = 5_000;

/**
 * Warms what the first spoken turn would otherwise start cold, once the bot's
 * audio stream is verified: the worker (a workflow whose activity reads the
 * agent, its tools and the model route) and this app's turns function (a GET
 * that opens its database and Temporal connections). Best effort and nothing
 * waits on it: every failure is swallowed, so a meeting never depends on it.
 */
export async function warmParlumeRuntime(input: {
	origin: string;
	sessionId: string;
}): Promise<void> {
	await Promise.allSettled([
		startWarmupWorkflow(input.sessionId),
		warmTurnsRoute(input),
	]);
}

async function startWarmupWorkflow(sessionId: string): Promise<void> {
	const temporal = await getTemporalClient();
	await temporal.workflow.start("parlumeWarmupWorkflow", {
		taskQueue: "fabric-worker",
		workflowId: `parlume-warmup-${sessionId}`,
		workflowIdConflictPolicy: "USE_EXISTING",
		args: [{ sessionId }],
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
