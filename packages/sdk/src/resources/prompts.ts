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

export interface PromptResponseContract {
	format: "AUTO" | "TEXT" | "MARKDOWN" | "JSON" | "XML";
	schema?: Record<string, unknown>;
}
export interface PromptDraft {
	responseContract?: PromptResponseContract;
	name?: string;
	description?: string;
	content: string;
	format?:
		| "PLAIN_TEXT"
		| "MARKDOWN"
		| "HANDLEBARS"
		| "MUSTACHE"
		| "LIQUID"
		| "JINJA2";
}
export interface PromptAssistanceInput {
	draft: PromptDraft;
	message: string;
	history?: Array<{ role: "user" | "assistant"; content: string }>;
}
export interface PromptAssistance {
	message: string;
	proposal: Required<Omit<PromptDraft, "responseContract">> | null;
}
export interface PromptPreviewInput {
	draft: PromptDraft;
	variables?: Record<string, string>;
}
export interface PromptPreview {
	responseFormat: PromptResponseContract["format"];
	validation: {
		status: "not_requested" | "passed" | "failed";
		issues: Array<{ path: string; message: string }>;
	};
	output: string;
	renderedPrompt: string;
	draftHash: string;
	mode: "live-model-preview";
	sourceAccess: "provided-inputs-only";
}
export class PromptsResource {
	constructor(private readonly http: FabricHttpClient) {}

	getResponseContract(promptId: string, options: { org?: string } = {}) {
		return this.workbench<{
			promptId: string;
			versionId: string | null;
			responseContract: PromptResponseContract;
		}>("/prompt-responses/read", { promptId }, options);
	}
	setResponseContract(
		promptId: string,
		responseContract: PromptResponseContract,
		options: { org?: string } = {},
	) {
		return this.workbench<{
			promptId: string;
			versionId: string | null;
			responseContract: PromptResponseContract;
		}>("/prompt-responses", { promptId, responseContract }, options);
	}
	assist(
		input: PromptAssistanceInput,
		options: { org?: string } = {},
	): Promise<PromptAssistance> {
		return this.workbench("/prompt-assistance", input, options);
	}
	preview(
		input: PromptPreviewInput,
		options: { org?: string } = {},
	): Promise<PromptPreview> {
		return this.workbench("/prompt-previews", input, options);
	}
	private workbench<T>(
		path: string,
		body: unknown,
		options: { org?: string },
	): Promise<T> {
		if (
			new TextEncoder().encode(JSON.stringify(body)).byteLength >
			512 * 1024
		) {
			return Promise.reject(
				new Error("The prompt request exceeds 512 KiB."),
			);
		}
		return this.http.request("POST", `${path}${buildQuery(options)}`, {
			body,
			retry: { maxRetries: 0 },
			boundedRead: { maxResponseBytes: 512 * 1024 },
		});
	}

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
