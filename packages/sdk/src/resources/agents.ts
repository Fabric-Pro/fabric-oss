import type { FabricHttpClient } from "../client.js";
import type {
	FabricAgent,
	FabricAgentExecution,
	FabricAgentInstanceExecution,
	FabricAgentInstanceInvocation,
	ListOptions,
} from "../types.js";
import { FabricError } from "../types.js";

export interface ListAgentsOptions extends ListOptions {
	status?: "ACTIVE" | "INACTIVE" | "DEPRECATED";
}

export interface ExecuteAgentOptions {
	/** Reuse with unchanged input when recovering the same logical request. */
	idempotencyKey?: string;
	input?: Record<string, unknown>;
	org?: string;
	/** @deprecated Personal context is retired; use an organization. */
	personal?: boolean;
}

export interface InvokeAgentInstanceOptions {
	input?: Record<string, unknown>;
	org?: string;
	priority?: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
	/** Required stable identity. Reuse with identical input after an unresolved/network response. */
	idempotencyKey: string;
}

/** Options for `agents.invoke`. Identical to `ExecuteAgentOptions` today. */
export type InvokeAgentOptions = ExecuteAgentOptions;

export class AgentsResource {
	constructor(private readonly http: FabricHttpClient) {}

	list(options: ListAgentsOptions = {}): Promise<FabricAgent[]> {
		const q = buildQuery(options);
		return this.http.get<FabricAgent[]>(`/agents${q}`);
	}

	get(
		id: string,
		options: { org?: string; personal?: boolean } = {},
	): Promise<FabricAgent> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		const q = params.toString() ? `?${params.toString()}` : "";
		return this.http.get<FabricAgent>(`/agents/${id}${q}`);
	}

	/**
	 * Legacy registered-agent background invocation. Unsupported runtimes return
	 * AGENT_EXECUTION_UNSUPPORTED; use invokeInstance for saved agents or the
	 * interactive agent workspace. No automatic transport retry is attempted.
	 */
	invoke(
		id: string,
		options: InvokeAgentOptions = {},
	): Promise<FabricAgentExecution> {
		const { org, personal, idempotencyKey, ...body } = options;
		const params = new URLSearchParams();
		if (org) {
			params.set("org", org);
		}
		if (personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.post<FabricAgentExecution>(
			`/agents/${id}/execute${qs ? `?${qs}` : ""}`,
			body,
			{ idempotencyKey, retry: { maxRetries: 0 } },
		);
	}

	/**
	 * Invoke a saved agent instance through its durable execution workflow.
	 * Automatic transport retries are disabled. After an unresolved response,
	 * call again with the SAME idempotencyKey, input, priority and organization.
	 * A new key represents an intentional new execution, not a recovery attempt.
	 * The caller must retain an explicit key for recovery across separate calls.
	 */
	async invokeInstance(
		id: string,
		options: InvokeAgentInstanceOptions,
	): Promise<FabricAgentInstanceInvocation> {
		if (
			!options ||
			typeof options.idempotencyKey !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(options.idempotencyKey)
		) {
			throw new FabricError(
				"A stable idempotencyKey is required. Retain it and reuse unchanged input to recover this invocation.",
				400,
				"IDEMPOTENCY_KEY_REQUIRED",
			);
		}
		const { org, idempotencyKey, input = {}, priority } = options;
		const params = new URLSearchParams();
		if (org) {
			params.set("org", org);
		}
		const query = params.toString();
		return this.http.post<FabricAgentInstanceInvocation>(
			`/agent-instances/${encodeURIComponent(id)}/invoke${query ? `?${query}` : ""}`,
			{
				input,
				...(priority === undefined ? {} : { priority }),
				...(idempotencyKey === undefined ? {} : { idempotencyKey }),
			},
			{ idempotencyKey, retry: { maxRetries: 0 } },
		);
	}

	/** Read one authorized saved-instance execution receipt and its current result. */
	getInstanceExecution(
		executionId: string,
		options: { org?: string } = {},
	): Promise<FabricAgentInstanceExecution> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		const query = params.toString();
		return this.http.get<FabricAgentInstanceExecution>(
			`/agent-executions/${encodeURIComponent(executionId)}${query ? `?${query}` : ""}`,
		);
	}

	/** @deprecated Use `invoke` instead. Kept for backwards compatibility. */
	execute(
		id: string,
		options: ExecuteAgentOptions = {},
	): Promise<FabricAgentExecution> {
		return this.invoke(id, options);
	}
}

function buildQuery(opts: object): string {
	const params = new URLSearchParams();
	for (const [k, v] of Object.entries(opts)) {
		if (v !== undefined && v !== null) {
			params.set(k, k === "personal" ? (v ? "1" : "") : String(v));
		}
	}
	const s = params.toString();
	return s ? `?${s}` : "";
}
