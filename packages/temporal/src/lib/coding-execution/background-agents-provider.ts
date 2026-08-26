import { getAuthHeaders } from "./auth";
import {
	debugLog,
	env,
	getBackgroundAgentsSecret,
	getBackgroundAgentsUrl,
} from "./env";
import { AuthError, NetworkError, SessionValidationError } from "./errors";
import type {
	CodingExecutionProvider,
	CreateSessionParams,
	HealthCheckResult,
	SessionStatus,
} from "./provider";
import { validateCreateSessionParams } from "./schemas";

export class FabricBackgroundAdapter implements CodingExecutionProvider {
	private readonly controlPlaneUrl: string;
	private readonly controlPlaneSecret: string;

	constructor() {
		this.controlPlaneUrl = getBackgroundAgentsUrl();
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

		// Use fabric-bot when configured (enables callback signals and follow-up
		// prompts). Fall back to direct control-plane when fabric-bot is unavailable.
		if (env.FABRIC_BOT_URL && env.FABRIC_BOT_SECRET) {
			return this.createSessionViaFabricBot(params);
		}

		debugLog("Creating background agent session (direct)", {
			repoOwner: validated.repoOwner,
			repoName: validated.repoName,
		});

		const res = await fetch(`${this.controlPlaneUrl}/sessions`, {
			method: "POST",
			headers: getAuthHeaders(this.controlPlaneSecret),
			body: JSON.stringify({
				repoOwner: validated.repoOwner,
				repoName: validated.repoName,
				title: validated.title,
				branch: validated.branch,
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
			throw new NetworkError(
				"BACKGROUND_AGENTS",
				`${this.controlPlaneUrl}/sessions`,
				res.status,
				new Error(text),
			);
		}

		const data = (await res.json()) as { sessionId: string };
		debugLog("Background agent session created", {
			sessionId: data.sessionId,
		});

		return { sessionId: data.sessionId };
	}

	private async createSessionViaFabricBot(
		params: CreateSessionParams,
	): Promise<{
		sessionId: string;
		externalUrl?: string;
		externalStatus?: string;
		providerMetadata?: Record<string, unknown>;
	}> {
		const botUrl = env.FABRIC_BOT_URL!;
		const botSecret = env.FABRIC_BOT_SECRET!;

		debugLog("Creating background agent session via fabric-bot", {
			repoOwner: params.repoOwner,
			repoName: params.repoName,
		});

		const res = await fetch(`${botUrl}/webhook`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Fabric-Signature": botSecret,
			},
			body: JSON.stringify({
				action: "started",
				codingRunId: params.codingRunId,
				workflowId: params.workflowId,
				organizationId: params.organizationId ?? null,
			}),
		});

		if (!res.ok) {
			const text = await res.text();
			if (res.status === 401 || res.status === 403) {
				throw new AuthError(
					"BACKGROUND_AGENTS",
					`fabric-bot authentication failed: ${text}`,
				);
			}
			throw new NetworkError(
				"BACKGROUND_AGENTS",
				`${botUrl}/webhook`,
				res.status,
				new Error(text),
			);
		}

		const data = (await res.json()) as {
			ok: boolean;
			controlPlaneSessionId: string;
		};

		debugLog("fabric-bot created session", {
			sessionId: data.controlPlaneSessionId,
		});

		return { sessionId: data.controlPlaneSessionId };
	}

	async sendPrompt(
		sessionId: string,
		content: string,
		authorId: string,
	): Promise<void> {
		debugLog("Sending prompt to background agent", {
			sessionId,
			contentLength: content.length,
			authorId,
		});

		const res = await fetch(
			`${this.controlPlaneUrl}/sessions/${sessionId}/prompt`,
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
				`${this.controlPlaneUrl}/sessions/${sessionId}/prompt`,
				res.status,
				new Error(text),
			);
		}
	}

	async getSessionStatus(sessionId: string): Promise<SessionStatus> {
		debugLog("Getting background agent session status", { sessionId });

		const [sessionRes, artifactsRes] = await Promise.all([
			fetch(`${this.controlPlaneUrl}/sessions/${sessionId}`, {
				headers: getAuthHeaders(this.controlPlaneSecret),
			}),
			fetch(`${this.controlPlaneUrl}/sessions/${sessionId}/artifacts`, {
				headers: getAuthHeaders(this.controlPlaneSecret),
			}),
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
				`${this.controlPlaneUrl}/sessions/${sessionId}`,
				sessionRes.status,
				new Error(text),
			);
		}

		const session = (await sessionRes.json()) as {
			id: string;
			status: SessionStatus["status"];
			branchName?: string | null;
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
			artifacts: artifacts.map((a) => ({
				id: a.id,
				type: a.type,
				url: a.url ?? null,
				metadata: a.metadata ?? null,
				createdAt: a.createdAt,
			})),
		};
	}

	async cancelSession(sessionId: string): Promise<void> {
		debugLog("Cancelling background agent session", { sessionId });

		const res = await fetch(
			`${this.controlPlaneUrl}/sessions/${sessionId}/stop`,
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
				`${this.controlPlaneUrl}/sessions/${sessionId}/stop`,
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

			const body = await res.json();
			return {
				healthy: true,
				latencyMs: Date.now() - startedAt,
				details: body,
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
