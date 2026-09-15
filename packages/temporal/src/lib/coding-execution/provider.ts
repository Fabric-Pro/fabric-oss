import type {
	ValidatedCreateSessionParams,
	ValidatedSessionResult,
	ValidatedSessionStatus,
} from "./schemas";

/**
 * Legacy interface for backward compatibility
 * @deprecated Use ValidatedCreateSessionParams from schemas.ts
 */
export interface CreateSessionParams {
	repoOwner: string;
	repoName: string;
	projectName?: string;
	organizationName?: string;
	vibeRemoteProjectId?: string;
	vibeRemoteProjectName?: string;
	title?: string;
	branch?: string;
	userId?: string;
	workingDirectory?: string;
	promptText?: string;
	/** Fabric CodingRun ID — used by fabric-bot to correlate callbacks */
	codingRunId?: string;
	/** Temporal workflow ID — stored so callbacks can signal the workflow */
	workflowId?: string;
	/** Fabric organization ID — used to fetch enriched execution context */
	organizationId?: string;
}

/**
 * Legacy interface for backward compatibility
 * @deprecated Use ValidatedSessionStatus from schemas.ts
 */
export interface SessionStatus {
	id: string;
	status:
		| "created"
		| "active"
		| "completed"
		| "failed"
		| "stopped"
		| "archived";
	branchName: string | null;
	artifacts: Array<{
		id: string;
		type: string;
		url: string | null;
		metadata: Record<string, unknown> | null;
		createdAt: number;
	}>;
}

/**
 * Health check result from a provider
 */
export interface HealthCheckResult {
	/** Whether the provider is healthy */
	healthy: boolean;
	/** Response latency in milliseconds */
	latencyMs: number;
	/** Optional additional details */
	details?: Record<string, unknown>;
}

/**
 * Provider capabilities that gate which run kinds a provider may offer.
 *
 * Plan §F4 (docs/features/inverted-loop-delivery-tracks.md): before
 * Spike runs are offered on a provider, it must be proven that a session can
 * push a named branch `fabric-spike/<runId>` to the project repository
 * without opening a PR, and that Fabric can read files from that branch.
 * Providers without this capability do not offer spikes.
 */
export interface CodingExecutionProviderCapabilities {
	/** Proven able to push a named branch without opening a pull request. */
	readonly pushBranchWithoutPr: boolean;
}

const DEFAULT_PROVIDER_CAPABILITIES: CodingExecutionProviderCapabilities = {
	pushBranchWithoutPr: false,
};

/**
 * Read a provider's capability flags. Providers that predate the flag (or
 * test doubles that omit it) report every capability as absent — fail
 * closed, so no run kind is offered without proof (plan §F4).
 */
export function getProviderCapabilities(
	provider: Pick<CodingExecutionProvider, "capabilities"> | null | undefined,
): CodingExecutionProviderCapabilities {
	return provider?.capabilities ?? DEFAULT_PROVIDER_CAPABILITIES;
}

/**
 * Base interface for all coding execution providers
 */
export interface CodingExecutionProvider {
	/**
	 * Capability flags (plan §F4). Read via `getProviderCapabilities()`.
	 */
	readonly capabilities: CodingExecutionProviderCapabilities;

	/**
	 * Creates a new execution session
	 * @param params - Session creation parameters (will be validated)
	 * @returns Session result with sessionId and optional metadata
	 * @throws {ProviderError} On validation or creation failure
	 */
	createSession(
		params: CreateSessionParams | ValidatedCreateSessionParams,
	): Promise<ValidatedSessionResult>;

	/**
	 * Sends a prompt to an existing session
	 * @param sessionId - The session identifier
	 * @param content - The prompt content
	 * @param authorId - The user/agent sending the prompt
	 * @throws {ProviderError} On send failure or invalid session
	 */
	sendPrompt(
		sessionId: string,
		content: string,
		authorId: string,
	): Promise<void>;

	/**
	 * Gets the current status of a session
	 * @param sessionId - The session identifier
	 * @returns Current session status
	 * @throws {ProviderError} On fetch failure or invalid session
	 */
	getSessionStatus(sessionId: string): Promise<ValidatedSessionStatus>;

	/**
	 * Cancels an active session
	 * @param sessionId - The session identifier
	 * @throws {ProviderError} On cancellation failure
	 */
	cancelSession(sessionId: string): Promise<void>;

	/**
	 * Performs a health check on the provider
	 * @returns Health check result
	 */
	healthCheck(): Promise<HealthCheckResult>;
}
