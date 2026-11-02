import type { RemoteAgentTarget } from "@repo/database";
import { fetchAgentEndpoint } from "@repo/utils/agent-endpoint";
import { ApplicationFailure } from "@temporalio/common";
import { z } from "zod";
import { getAuthHeaders } from "./auth";
import {
	debugLog,
	getBackgroundAgentsSecret,
	getBackgroundAgentsUrl,
	getFabricAgentsDefaultConnection,
	getFabricAgentsDefaultModel,
} from "./env";
import {
	AuthError,
	InputRequiredError,
	NetworkError,
	RecoveryRequiredError,
	SessionValidationError,
} from "./errors";
import type {
	CodingExecutionProvider,
	CodingExecutionProviderCapabilities,
	CreateSessionParams,
	HealthCheckResult,
	SessionStatus,
} from "./provider";
import { validateCreateSessionParams, validateSessionStatus } from "./schemas";

/** Branch-only delivery must be qualified against the replacement runtime before offering spikes. */
export const FABRIC_BACKGROUND_CAPABILITIES: CodingExecutionProviderCapabilities =
	{
		pushBranchWithoutPr: false,
	};

export class FabricBackgroundAdapter implements CodingExecutionProvider {
	/** See {@link FABRIC_BACKGROUND_CAPABILITIES}. */
	readonly capabilities: CodingExecutionProviderCapabilities =
		FABRIC_BACKGROUND_CAPABILITIES;

	private readonly controlPlaneUrl: string;
	private readonly controlPlaneSecret: string;

	constructor(
		private readonly expectedTarget?: RemoteAgentTarget,
		private readonly registration?: { url: string; secret: string },
	) {
		this.controlPlaneUrl = (
			registration?.url ??
			(expectedTarget?.connectionId
				? expectedTarget.url
				: getBackgroundAgentsUrl())
		).replace(/\/+$/, "");
		this.controlPlaneSecret =
			registration?.secret ??
			(expectedTarget?.connectionId ? "" : getBackgroundAgentsSecret());
		if (expectedTarget && expectedTarget.url !== this.controlPlaneUrl) {
			throw new SessionValidationError(
				"BACKGROUND_AGENTS",
				"This run belongs to another execution endpoint. Restore its configured target; do not reroute the session.",
			);
		}
	}

	async createSession(params: CreateSessionParams): Promise<{
		sessionId: string;
		externalUrl?: string;
		externalStatus?: string;
		providerMetadata?: Record<string, unknown>;
	}> {
		let requestMayHaveBeenSent = false;
		try {
			// Validate inputs
			const validated = validateCreateSessionParams(params);

			const llmConnection =
				validated.llmConnection ??
				params.llmConnection ??
				(this.expectedTarget?.connectionId
					? undefined
					: getFabricAgentsDefaultConnection());
			const model =
				validated.model ??
				params.model ??
				(this.expectedTarget?.connectionId
					? undefined
					: getFabricAgentsDefaultModel());
			const targetMachine =
				validated.targetMachine ?? params.targetMachine;
			const headBranch = validated.headBranch ?? params.headBranch;
			const fallbackPolicy =
				validated.fallbackPolicy ?? params.fallbackPolicy;

			debugLog("Creating Fabric Agents coding session", {
				repoOwner: validated.repoOwner,
				repoName: validated.repoName,
				branch: validated.branch,
				headBranch,
				llmConnection,
				model,
				targetMachine,
				...(fallbackPolicy ? { fallbackPolicy } : {}),
			});

			const readiness = await this.executionReadiness(params);
			const res = await this.request(
				`${this.controlPlaneUrl}/sessions`,
				{
					method: "POST",
					headers: getAuthHeaders(this.controlPlaneSecret),
					signal: AbortSignal.timeout(240_000),
					body: JSON.stringify({
						repoOwner: validated.repoOwner,
						repoName: validated.repoName,
						title: validated.title,
						branch: validated.branch,
						...(headBranch ? { headBranch } : {}),
						codingRunId:
							validated.codingRunId ?? params.codingRunId,
						workflowId: validated.workflowId ?? params.workflowId,
						organizationId:
							validated.organizationId ?? params.organizationId,
						workingDirectory: validated.workingDirectory,
						llmConnection,
						model,
						targetMachine,
						...(fallbackPolicy ? { fallbackPolicy } : {}),
					}),
				},
				() => {
					requestMayHaveBeenSent = true;
				},
			);

			if (!res.ok) {
				const text = await res.text();
				let code: unknown;
				try {
					code = JSON.parse(text).code;
				} catch {
					/* Non-JSON transport failure. */
				}
				if (code === "recovery_required") {
					throw new RecoveryRequiredError();
				}
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
			if (data.externalUrl) {
				let valid = false;
				try {
					const link = new URL(data.externalUrl);
					const controlPlane = new URL(this.controlPlaneUrl);
					valid =
						!link.username &&
						!link.password &&
						((/^fabricagents[0-9]*:$/.test(link.protocol) &&
							link.hostname === "workspace" &&
							!link.search &&
							!link.hash) ||
							((link.protocol === "https:" ||
								link.protocol === controlPlane.protocol) &&
								link.origin === controlPlane.origin));
				} catch {
					/* Invalid URI is rejected before it reaches product links. */
				}
				if (!valid) {
					throw new SessionValidationError(
						"BACKGROUND_AGENTS",
						"Provider returned an untrusted session link",
					);
				}
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
				providerMetadata: {
					...data.providerMetadata,
					...(fallbackPolicy ? { fallbackPolicy } : {}),
					...(llmConnection ? { llmConnection } : {}),
					...(model ? { model } : {}),
					...(targetMachine ? { targetMachine } : {}),
					executionRuntime: "fabric-agent-server",
					executionTarget: {
						...this.expectedTarget,
						url: this.controlPlaneUrl,
						profileId: readiness.profileId,
					},
				},
			};
		} catch (error) {
			if (!requestMayHaveBeenSent) {
				throw ApplicationFailure.create({
					message: `Coding session was not created: ${error instanceof Error ? error.message : String(error)}`,
					type: "CODING_SESSION_NOT_CREATED",
					nonRetryable: false,
				});
			}
			throw error;
		}
	}

	async sendPrompt(
		sessionId: string,
		content: string,
		authorId: string,
		options?: { promptId: string },
	): Promise<{ messageId: string }> {
		if (!options?.promptId?.trim()) {
			throw new SessionValidationError(
				"BACKGROUND_AGENTS",
				"A stable promptId is required",
			);
		}
		if (this.expectedTarget) {
			await this.executionReadiness();
		}
		const encodedSessionId = encodeURIComponent(sessionId);
		debugLog("Sending prompt to background agent", {
			sessionId,
			contentLength: content.length,
			authorId,
		});

		const res = await this.request(
			`${this.controlPlaneUrl}/sessions/${encodedSessionId}/prompt`,
			{
				method: "POST",
				headers: getAuthHeaders(this.controlPlaneSecret),
				signal: AbortSignal.timeout(30_000),
				body: JSON.stringify({
					content,
					authorId,
					source: "fabric",
					promptId: options.promptId,
				}),
			},
		);

		if (!res.ok) {
			const text = await res.text();
			let code: unknown;
			try {
				code = JSON.parse(text).code;
			} catch {
				/* Non-JSON transport failure. */
			}
			if (code === "recovery_required") {
				throw new RecoveryRequiredError();
			}
			if (code === "input_required") {
				throw new InputRequiredError();
			}
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
		let receipt: { messageId?: unknown };
		try {
			receipt = await res.json();
		} catch {
			throw new RecoveryRequiredError();
		}
		if (
			!receipt ||
			typeof receipt.messageId !== "string" ||
			!receipt.messageId.trim()
		) {
			throw new RecoveryRequiredError();
		}
		return { messageId: receipt.messageId };
	}

	async getSessionStatus(sessionId: string): Promise<SessionStatus> {
		if (this.expectedTarget) {
			await this.executionReadiness();
		}
		const encodedSessionId = encodeURIComponent(sessionId);
		debugLog("Getting background agent session status", { sessionId });

		const [sessionRes, artifactsRes] = await Promise.all([
			this.request(
				`${this.controlPlaneUrl}/sessions/${encodedSessionId}`,
				{
					headers: getAuthHeaders(this.controlPlaneSecret),
				},
			),
			this.request(
				`${this.controlPlaneUrl}/sessions/${encodedSessionId}/artifacts`,
				{
					headers: getAuthHeaders(this.controlPlaneSecret),
				},
			),
		]);

		if (!sessionRes.ok) {
			const text = await sessionRes.text();
			if (sessionRes.status === 404) {
				throw ApplicationFailure.nonRetryable(
					`Session ${sessionId} not found`,
					"SESSION_NOT_FOUND",
				);
			}
			throw new NetworkError(
				"BACKGROUND_AGENTS",
				`${this.controlPlaneUrl}/sessions/${encodedSessionId}`,
				sessionRes.status,
				new Error(text),
			);
		}

		if (!artifactsRes.ok) {
			throw new NetworkError(
				"BACKGROUND_AGENTS",
				"session artifacts",
				artifactsRes.status,
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

		if (session.id !== sessionId) {
			throw new SessionValidationError(
				"BACKGROUND_AGENTS",
				"Provider returned another session identity",
			);
		}
		const result = validateSessionStatus({
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
		});
		for (const artifact of result.artifacts) {
			if (
				artifact.url &&
				!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(
					artifact.url,
				)
			) {
				throw new SessionValidationError(
					"BACKGROUND_AGENTS",
					"Invalid pull request artifact URL",
				);
			}
		}
		return result;
	}

	async cancelSession(sessionId: string): Promise<void> {
		if (this.expectedTarget) {
			await this.executionReadiness();
		}
		const encodedSessionId = encodeURIComponent(sessionId);
		debugLog("Cancelling background agent session", { sessionId });

		const res = await this.request(
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
				// A missing native binding does not establish that its work has stopped.
				throw new RecoveryRequiredError();
			}
			throw new NetworkError(
				"BACKGROUND_AGENTS",
				`${this.controlPlaneUrl}/sessions/${encodedSessionId}/stop`,
				res.status,
				new Error(text),
			);
		}
		const outcome = await res.json();
		if (outcome?.confirmed !== true) {
			throw new RecoveryRequiredError();
		}
	}

	/** Authenticated protocol readiness, separate from the public liveness endpoint. */
	async executionReadiness(params?: CreateSessionParams): Promise<
		Record<string, unknown> & {
			profileId: string;
			ready: boolean;
			executionTarget: { url: string; profileId: string };
		}
	> {
		const res = await this.request(
			`${this.controlPlaneUrl}/sessions/readiness`,
			{
				method: params ? "POST" : "GET",
				headers: getAuthHeaders(this.controlPlaneSecret),
				...(params
					? {
							body: JSON.stringify({
								repoOwner: params.repoOwner,
								repoName: params.repoName,
								organizationId: params.organizationId,
								llmConnection:
									params.llmConnection ??
									(this.expectedTarget?.connectionId
										? undefined
										: getFabricAgentsDefaultConnection()),
								model:
									params.model ??
									(this.expectedTarget?.connectionId
										? undefined
										: getFabricAgentsDefaultModel()),
								targetMachine: params.targetMachine,
							}),
						}
					: {}),
			},
		);
		if (res.status === 401 || res.status === 403) {
			throw new AuthError(
				"BACKGROUND_AGENTS",
				"Execution readiness authorization failed",
			);
		}
		if (!res.ok) {
			throw new SessionValidationError(
				"BACKGROUND_AGENTS",
				"Execution readiness failed; check host provider and repository access",
			);
		}
		const data = z
			.object({
				protocolVersion: z.literal(2),
				profileId: z.string().min(1),
				ready: z.boolean(),
				capabilities: z.object({
					durableReceipts: z.literal(true),
					wholeRunCancellation: z.literal(true),
				}),
			})
			.passthrough()
			.parse(await res.json());
		if (!data.ready) {
			const checks =
				data.checks && typeof data.checks === "object"
					? data.checks
					: {};
			const failed = Object.entries(checks)
				.filter(([, value]) => value === false)
				.map(([key]) => key)
				.join(", ");
			throw new SessionValidationError(
				"BACKGROUND_AGENTS",
				`Execution readiness checks failed${failed ? `: ${failed}` : ""}`,
			);
		}
		if (
			this.expectedTarget &&
			data.profileId !== this.expectedTarget.profileId
		) {
			throw new SessionValidationError(
				"BACKGROUND_AGENTS",
				"Execution profile changed; recover this run on its original profile",
			);
		}
		return {
			...data,
			executionTarget: {
				...this.expectedTarget,
				url: this.controlPlaneUrl,
				profileId: data.profileId,
			},
		};
	}

	async getSessionMessages(sessionId: string) {
		await this.executionReadiness();
		const response = await this.request(
			`${this.controlPlaneUrl}/sessions/${encodeURIComponent(sessionId)}/messages`,
			{ headers: getAuthHeaders(this.controlPlaneSecret) },
		);
		if (!response.ok) {
			throw new Error(
				"Remote conversation is unavailable on this server build",
			);
		}
		const data = z
			.object({
				messages: z
					.array(
						z.object({
							id: z.string(),
							role: z.enum(["user", "assistant"]),
							content: z.string().max(20000),
						}),
					)
					.max(50),
				webPath: z.string().optional(),
			})
			.parse(await response.json());
		const webUrl = data.webPath?.startsWith("/?")
			? new URL(data.webPath, this.controlPlaneUrl).href
			: undefined;
		return { messages: data.messages, ...(webUrl ? { webUrl } : {}) };
	}

	private async request(
		url: string,
		options: RequestInit = {},
		beforeSend?: () => void,
	): Promise<Response> {
		let requestOptions = options;
		if (this.expectedTarget?.connectionId) {
			const { getRemoteAgentServerSecret } = await import(
				"@repo/database"
			);
			const secret = await getRemoteAgentServerSecret(
				this.expectedTarget,
				options.method === "POST" &&
					(url.endsWith("/sessions") ||
						url.endsWith("/sessions/readiness") ||
						url.endsWith("/prompt")),
			);
			requestOptions = { ...options, headers: getAuthHeaders(secret) };
		}
		const send =
			this.expectedTarget?.connectionId || this.registration
				? fetchAgentEndpoint
				: fetch;
		beforeSend?.();
		return send(url, {
			...requestOptions,
			redirect: "error",
			signal: options.signal ?? AbortSignal.timeout(20_000),
		});
	}

	async healthCheck(): Promise<HealthCheckResult> {
		const startedAt = Date.now();

		try {
			const readiness = await this.executionReadiness();
			return {
				healthy: readiness.ready,
				latencyMs: Date.now() - startedAt,
				details: readiness,
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
