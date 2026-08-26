import type { FabricHttpClient } from "../client.js";
import type { FabricPrompt, ListOptions } from "../types.js";

export interface ListPromptsOptions extends ListOptions {
	category?: string;
}

export interface CreatePromptOptions {
	key: string;
	name: string;
	description?: string;
	content?: string;
	category?: string;
	tags?: string[];
	org?: string;
	personal?: boolean;
}

export interface UpdatePromptOptions {
	name?: string;
	description?: string | null;
	category?: string | null;
	tags?: string[];
	org?: string;
	personal?: boolean;
}

export class PromptsResource {
	constructor(private readonly http: FabricHttpClient) {}

	list(options: ListPromptsOptions = {}): Promise<FabricPrompt[]> {
		const q = buildQuery(options);
		return this.http.get<FabricPrompt[]>(`/prompts${q}`);
	}

	get(
		id: string,
		options: { org?: string; personal?: boolean } = {},
	): Promise<FabricPrompt> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		const q = params.toString() ? `?${params.toString()}` : "";
		return this.http.get<FabricPrompt>(`/prompts/${id}${q}`);
	}

	async create(options: CreatePromptOptions): Promise<FabricPrompt> {
		const { org, personal, ...body } = options;
		const params = new URLSearchParams();
		if (org) {
			params.set("org", org);
		}
		if (personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.post<FabricPrompt>(
			`/prompts${qs ? `?${qs}` : ""}`,
			body,
		);
	}

	async update(
		id: string,
		options: UpdatePromptOptions,
	): Promise<FabricPrompt> {
		const { org, personal, ...body } = options;
		const params = new URLSearchParams();
		if (org) {
			params.set("org", org);
		}
		if (personal) {
			params.set("personal", "1");
		}
		const qs = params.toString();
		return this.http.patch<FabricPrompt>(
			`/prompts/${id}${qs ? `?${qs}` : ""}`,
			body,
		);
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
