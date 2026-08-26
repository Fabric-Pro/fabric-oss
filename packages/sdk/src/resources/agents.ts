import type { FabricHttpClient } from "../client.js";
import type {
	FabricAgent,
	FabricAgentExecution,
	ListOptions,
} from "../types.js";

export interface ListAgentsOptions extends ListOptions {
	status?: "ACTIVE" | "INACTIVE" | "DEPRECATED";
}

export interface ExecuteAgentOptions {
	input?: Record<string, unknown>;
	org?: string;
	personal?: boolean;
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
	 * Invoke an agent. Preferred entry point — `execute` is the deprecated alias.
	 *
	 * Streaming is not yet implemented at the API layer; once the portal exposes
	 * an SSE variant, this method will accept `{ stream: true }` and return an
	 * `AsyncIterable` of execution events.
	 */
	invoke(
		id: string,
		options: InvokeAgentOptions = {},
	): Promise<FabricAgentExecution> {
		const { org, personal, ...body } = options;
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
