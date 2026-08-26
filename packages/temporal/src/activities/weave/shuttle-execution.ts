/**
 * Shuttle Execution Activities
 *
 * Sends implementation prompts to the Shuttle execution runtime session
 * and polls for completion. Used by the orchestrator execution phase
 * when a weave_shuttle step is reached.
 *
 * Today this runtime is backed by the Background Agents provider and is
 * created during initialization via createSandboxActivity.
 */

import { isDeployedEnvironment } from "@repo/utils";
import type { SessionStatus } from "../../lib/coding-execution/provider";
import { getBackgroundAgentsProvider } from "./get-background-provider";

/**
 * Resolve the web app's base URL for worker→web bridge calls.
 *
 * Never falls back to localhost in a deployed environment: the Azure
 * worker container has `APP_URL` (deployment/azure/main.bicep), and an
 * unset chain there must surface as a loud activity failure instead of a
 * silent POST to `http://localhost:3000` inside the worker container.
 */
function getFabricInternalBaseUrl(): string {
	const url =
		process.env.FABRIC_INTERNAL_URL ||
		process.env.RUNTIME_API_URL ||
		// Set on the Azure temporal worker container app.
		process.env.APP_URL ||
		process.env.NEXT_PUBLIC_APP_URL;
	if (url) {
		return url;
	}
	if (isDeployedEnvironment()) {
		throw new Error(
			"Fabric internal base URL is not configured for this environment — set APP_URL (or FABRIC_INTERNAL_URL) on the temporal worker.",
		);
	}
	return "http://localhost:3000";
}

// ---------- Types ----------

export interface SendShuttlePromptInput {
	sessionId: string;
	/** The full implementation prompt (includes prior research context) */
	prompt: string;
	userId: string;
	organizationId?: string;
}

export interface PollShuttleStatusInput {
	sessionId: string;
}

export interface PollShuttleStatusOutput {
	status: SessionStatus["status"];
	done: boolean;
	branchName: string | null;
	pullRequestUrl: string | null;
}

export interface DelegateWeaveImplementationInput {
	planId: string;
	prompt: string;
	category: string;
	modelOverride?: string;
	executionProvider: "KANBAN_LOCAL";
	userId: string;
	organizationId?: string;
	weaveExecutionId?: string;
	timeoutMs?: number;
}

export interface DelegateWeaveImplementationOutput {
	executionKind: "coding_run" | "direct_execution_session";
	executionChannel?: "BACKGROUND_AGENTS" | "LOCAL_AGENTS";
	provider?: "BACKGROUND_AGENTS" | "KANBAN_LOCAL";
	codingRunId?: string;
	workflowId?: string;
	providerSessionId?: string;
	externalUrl?: string;
	status: "completed" | "failed" | "cancelled" | "running";
	pullRequestUrl?: string;
	summary: string;
}

// ---------- Activities ----------

/**
 * Send the implementation prompt to the Shuttle runtime session.
 * Call this once when the Shuttle step begins.
 */
export async function sendShuttlePromptActivity(
	input: SendShuttlePromptInput,
): Promise<void> {
	const provider = getBackgroundAgentsProvider();
	await provider.sendPrompt(input.sessionId, input.prompt, input.userId);
}

/**
 * Poll the Shuttle runtime session status.
 * Returns whether the session has reached a terminal state and any PR URL.
 */
export async function pollShuttleStatusActivity(
	input: PollShuttleStatusInput,
): Promise<PollShuttleStatusOutput> {
	const provider = getBackgroundAgentsProvider();
	const status = await provider.getSessionStatus(input.sessionId);

	const terminalStatuses = new Set([
		"completed",
		"failed",
		"stopped",
		"archived",
	]);
	const done = terminalStatuses.has(status.status);

	// Look for a pull request artifact
	const prArtifact = status.artifacts.find(
		(a) => a.type === "pull_request" && a.url,
	);

	return {
		status: status.status,
		done,
		branchName: status.branchName,
		pullRequestUrl: prArtifact?.url ?? null,
	};
}

export async function delegateWeaveImplementationActivity(
	input: DelegateWeaveImplementationInput,
): Promise<DelegateWeaveImplementationOutput> {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		throw new Error(
			"AGENT_SERVICE_SECRET must be set for Weave local/workspace implementation delegation.",
		);
	}

	const response = await fetch(
		`${getFabricInternalBaseUrl()}/api/internal/weave-coding-run`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Agent-Service-Token": secret,
			},
			body: JSON.stringify({
				planId: input.planId,
				prompt: input.prompt,
				category: input.category,
				modelOverride: input.modelOverride,
				executionProvider: input.executionProvider,
				userId: input.userId,
				organizationId: input.organizationId ?? null,
				weaveExecutionId: input.weaveExecutionId,
				timeoutMs: input.timeoutMs,
			}),
		},
	);

	const data = (await response.json()) as
		| DelegateWeaveImplementationOutput
		| { error?: string };
	if (!response.ok) {
		throw new Error(
			("error" in data && data.error) ||
				`Internal weave coding-run bridge failed (${response.status})`,
		);
	}

	return data as DelegateWeaveImplementationOutput;
}
