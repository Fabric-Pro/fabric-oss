import { getAuthHeaders } from "./auth";
import {
	debugLog,
	getBackgroundAgentsSecret,
	getBackgroundAgentsUrl,
	getFabricAgentsDefaultConnection,
	getFabricAgentsDefaultModel,
} from "./env";
import { AuthError, NetworkError, SessionValidationError } from "./errors";
import type {
	CodingExecutionProvider,
	CodingExecutionProviderCapabilities,
	CreateSessionParams,
	HealthCheckResult,
	SessionStatus,
} from "./provider";
import { validateCreateSessionParams } from "./schemas";

/**
 * Plan §F4 decision for Fabric Agents (`BACKGROUND_AGENTS`): `pushBranchWithoutPr` is true.
 *
 * Session creation prepares an isolated git worktree on `fabric-agent-server`
 * for the execution branch (`feat/<slug>` or `fabric-spike/<runId>`), and the
 * agent pushes through git in its worktree — whether a PR is opened is decided
 * by the prompt, not by the runtime. The spike prompt instructs the agent to
 * push `fabric-spike/<runId>` and not open a PR; `syncSpikeArtifacts` then
 * verifies the branch exists on GitHub by reading the deliverables from it
 * and fails the run closed when they are missing. Exported as a constant so
 * the API can read the flag without constructing the adapter (whose
 * constructor requires `BACKGROUND_AGENTS_URL`).
 */
export const FABRIC_BACKGROUND_CAPABILITIES: CodingExecutionProviderCapabilities =
	{
		pushBranchWithoutPr: true,
	};

export class FabricBackgroundAdapter implements CodingExecutionProvider {
	/** See {@link FABRIC_BACKGROUND_CAPABILITIES}. */
	readonly capabilities: CodingExecutionProviderCapabilities =
		FABRIC_BACKGROUND_CAPABILITIES;

	private readonly controlPlaneUrl: string;
	private readonly controlPlaneSecret: string;

	constructor() {
		this.controlPlaneUrl = getBackgroundAgentsUrl().replace(/\/+$/, "");
		this.controlPlaneSecret = getBackgroundAgentsSecret();
	}

	async createSession(params: CreateSessionParams): Promise<{
		sessionId: string;
		externalUrl?: string;
		externalStatus?: string;
		providerMetadata?: Record<string, unknown>;
	}> {
		// Validate inputs
		const validated = validateCreateSessionParams(params);

		const llmConnection =
			validated.llmConnection ??
			params.llmConnection ??
			getFabricAgentsDefaultConnection();
		const model =
			validated.model ?? params.model ?? getFabricAgentsDefaultModel();
		const targetMachine = validated.targetMachine ?? params.targetMachine;
		const headBranch = validated.headBranch ?? params.headBranch;

		debugLog("Creating Fabric Agents coding session", {
			repoOwner: validated.repoOwner,
			repoName: validated.repoName,
			branch: validated.branch,
			headBranch,
			llmConnection,
			model,
			targetMachine,
		});

		const res = await fetch(`${this.controlPlaneUrl}/sessions`, {
			method: "POST",
			headers: getAuthHeaders(this.controlPlaneSecret),
			signal: AbortSignal.timeout(240_000),
			body: JSON.stringify({
				repoOwner: validated.repoOwner,
				repoName: validated.repoName,
				title: validated.title,
				branch: validated.branch,
				...(headBranch ? { headBranch } : {}),
				codingRunId: validated.codingRunId ?? params.codingRunId,
				workflowId: validated.workflowId ?? params.workflowId,
				organizationId:
					validated.organizationId ?? params.organizationId,
				workingDirectory: validated.workingDirectory,
				llmConnection,
				model,
				targetMachine,
			}),
		});

		if (!res.ok) {
			const text = await res.text();
			if (res.status === 401 || res.status === 403) {
				throw new AuthError(
					"BACKGROUND_AGENTS",
					`Authentication failed: ${text}`,
				);
			}
			if (
				res.status === 400 ||
				res.status === 404 ||
				res.status === 409 ||
				res.status === 422
			) {
				throw new SessionValidationError(
					"BACKGROUND_AGENTS",
					`Session validation failed (${res.status}): ${text}`,
				);
			}
			throw new NetworkError(
				"BACKGROUND_AGENTS",
				`${this.controlPlaneUrl}/sessions`,
				res.status,
				new Error(text),
			);
		}

		const data = (await res.json()) as {
			sessionId: string;
			externalUrl?: string;
			externalStatus?: string;
			providerMetadata?: Record<string, unknown>;
		};
		if (
			typeof data.sessionId !== "string" ||
			data.sessionId.trim().length === 0
		) {
			throw new SessionValidationError(
				"BACKGROUND_AGENTS",
				"Provider returned an empty sessionId",
			);
		}
		debugLog("Fabric Agents coding session created", {
			sessionId: data.sessionId,
			externalUrl: data.externalUrl,
		});

		return {
			sessionId: data.sessionId,
			...(data.externalUrl ? { externalUrl: data.externalUrl } : {}),
			...(data.externalStatus
				? { externalStatus: data.externalStatus }
				: {}),
			...(data.providerMetadata
				? { providerMetadata: data.providerMetadata }
				: {}),
		};
	}

	async sendPrompt(
		sessionId: string,
		content: string,
		authorId: string,
	): Promise<void> {
		const encodedSessionId = encodeURIComponent(sessionId);
		debugLog("Sending prompt to background agent", {
			sessionId,
			contentLength: content.length,
			authorId,
		});

		const res = await fetch(
			`${this.controlPlaneUrl}/sessions/${encodedSessionId}/prompt`,
			{
				method: "POST",
				headers: getAuthHeaders(this.controlPlaneSecret),
				body: JSON.stringify({ content, authorId, source: "fabric" }),
			},
		);

		if (!res.ok) {
			const text = await res.text();
			if (res.status === 404) {
				throw new SessionValidationError(
					"BACKGROUND_AGENTS",
					`Session ${sessionId} not found`,
				);
			}
			if (res.status === 401 || res.status === 403) {
				throw new AuthError(
					"BACKGROUND_AGENTS",
					`Authentication failed: ${text}`,
				);
			}
			throw new NetworkError(
				"BACKGROUND_AGENTS",
				`${this.controlPlaneUrl}/sessions/${encodedSessionId}/prompt`,
				res.status,
				new Error(text),
			);
		}
	}

	async getSessionStatus(sessionId: string): Promise<SessionStatus> {
		const encodedSessionId = encodeURIComponent(sessionId);
		debugLog("Getting background agent session status", { sessionId });

		const [sessionRes, artifactsRes] = await Promise.all([
			fetch(`${this.controlPlaneUrl}/sessions/${encodedSessionId}`, {
				headers: getAuthHeaders(this.controlPlaneSecret),
			}),
			fetch(
				`${this.controlPlaneUrl}/sessions/${encodedSessionId}/artifacts`,
				{
					headers: getAuthHeaders(this.controlPlaneSecret),
				},
			),
		]);

		if (!sessionRes.ok) {
			const text = await sessionRes.text();
			if (sessionRes.status === 404) {
				throw new SessionValidationError(
					"BACKGROUND_AGENTS",
					`Session ${sessionId} not found`,
				);
			}
			throw new NetworkError(
				"BACKGROUND_AGENTS",
				`${this.controlPlaneUrl}/sessions/${encodedSessionId}`,
				sessionRes.status,
				new Error(text),
			);
		}

		const session = (await sessionRes.json()) as {
			id: string;
			status: SessionStatus["status"];
			branchName?: string | null;
			error?: string | null;
		};
		type Artifact = {
			id: string;
			type: string;
			url?: string | null;
			metadata?: Record<string, unknown> | null;
			createdAt: number;
		};
		let artifacts: Artifact[] = [];
		if (artifactsRes.ok) {
			const body = await artifactsRes.json();
			artifacts = Array.isArray(body) ? body : (body?.artifacts ?? []);
		}

		return {
			id: session.id,
			status: session.status,
			branchName: session.branchName ?? null,
			...(session.error ? { error: session.error } : {}),
			artifacts: artifacts.map((a) => ({
				id: a.id,
				type: a.type,
				url: a.url ?? null,
				metadata: a.metadata ?? null,
				createdAt:
					typeof a.createdAt === "number"
						? a.createdAt
						: typeof a.createdAt === "string"
							? Date.parse(a.createdAt) || Date.now()
							: Date.now(),
			})),
		};
	}

	async cancelSession(sessionId: string): Promise<void> {
		const encodedSessionId = encodeURIComponent(sessionId);
		debugLog("Cancelling background agent session", { sessionId });

		const res = await fetch(
			`${this.controlPlaneUrl}/sessions/${encodedSessionId}/stop`,
			{
				method: "POST",
				headers: getAuthHeaders(this.controlPlaneSecret),
				body: JSON.stringify({}),
			},
		);

		if (!res.ok) {
			const text = await res.text();
			if (res.status === 404) {
				// Session already gone, that's fine
				return;
			}
			throw new NetworkError(
				"BACKGROUND_AGENTS",
				`${this.controlPlaneUrl}/sessions/${encodedSessionId}/stop`,
				res.status,
				new Error(text),
			);
		}
	}

	async healthCheck(): Promise<HealthCheckResult> {
		const startedAt = Date.now();

		try {
			const res = await fetch(`${this.controlPlaneUrl}/health`, {
				headers: getAuthHeaders(this.controlPlaneSecret),
			});

			if (!res.ok) {
				return {
					healthy: false,
					latencyMs: Date.now() - startedAt,
					details: {
						statusCode: res.status,
						statusText: res.statusText,
					},
				};
			}

			const body = (await res.json()) as Record<string, unknown> | null;
			const statusField =
				body && typeof body === "object" ? body.status : undefined;
			const healthy =
				statusField === undefined ||
				statusField === "ok" ||
				statusField === "healthy";
			return {
				healthy,
				latencyMs: Date.now() - startedAt,
				details: body ?? undefined,
			};
		} catch (error) {
			return {
				healthy: false,
				latencyMs: Date.now() - startedAt,
				details: {
					error:
						error instanceof Error ? error.message : String(error),
				},
			};
		}
	}
}

export { FabricBackgroundAdapter as BackgroundAgentsProvider };
