import type { FabricHttpClient } from "../client.js";
import type { FabricChat } from "../types.js";

export interface ListChatsOptions {
	org?: string;
	personal?: boolean;
	limit?: number;
	offset?: number;
}

export interface CreateChatOptions {
	title?: string;
	projectId?: string;
	org?: string;
	personal?: boolean;
}

export interface UpdateChatOptions {
	/** Pass `null` to clear the title. */
	title?: string | null;
	org?: string;
	personal?: boolean;
}

export interface SendMessageOptions {
	content: string;
	org?: string;
	personal?: boolean;
}

export interface SendMessageResult {
	chatId: string;
	assistantMessage: {
		id: string;
		role: "assistant";
		content: string;
	};
}

function tenantQuery(opts: { org?: string; personal?: boolean }): string {
	const params = new URLSearchParams();
	if (opts.org) {
		params.set("org", opts.org);
	}
	if (opts.personal) {
		params.set("personal", "1");
	}
	const qs = params.toString();
	return qs ? `?${qs}` : "";
}

export class ChatsResource {
	constructor(private readonly http: FabricHttpClient) {}

	list(options: ListChatsOptions = {}): Promise<FabricChat[]> {
		const params = new URLSearchParams();
		if (options.org) {
			params.set("org", options.org);
		}
		if (options.personal) {
			params.set("personal", "1");
		}
		if (options.limit !== undefined) {
			params.set("limit", String(options.limit));
		}
		if (options.offset !== undefined) {
			params.set("offset", String(options.offset));
		}
		const qs = params.toString();
		return this.http.get<FabricChat[]>(`/chats${qs ? `?${qs}` : ""}`);
	}

	get(
		id: string,
		options: { org?: string; personal?: boolean } = {},
	): Promise<FabricChat> {
		return this.http.get<FabricChat>(`/chats/${id}${tenantQuery(options)}`);
	}

	async create(options: CreateChatOptions = {}): Promise<FabricChat> {
		const { org, personal, ...body } = options;
		return this.http.post<FabricChat>(
			`/chats${tenantQuery({ org, personal })}`,
			body,
		);
	}

	/** Rename a chat. Pass `null` for `title` to clear it. */
	async rename(
		id: string,
		title: string | null,
		options: { org?: string; personal?: boolean } = {},
	): Promise<FabricChat> {
		return this.http.patch<FabricChat>(
			`/chats/${id}${tenantQuery(options)}`,
			{ title },
		);
	}

	async update(id: string, options: UpdateChatOptions): Promise<FabricChat> {
		const { org, personal, ...body } = options;
		return this.http.patch<FabricChat>(
			`/chats/${id}${tenantQuery({ org, personal })}`,
			body,
		);
	}

	async delete(
		id: string,
		options: { org?: string; personal?: boolean } = {},
	): Promise<{ id: string; deleted: boolean }> {
		return this.http.delete<{ id: string; deleted: boolean }>(
			`/chats/${id}${tenantQuery(options)}`,
		);
	}

	/**
	 * Send a user message and synchronously wait for the assistant turn to
	 * complete. The server appends the message to the chat, runs the model,
	 * persists the assistant reply, and returns it. No streaming — call
	 * returns once the assistant turn is fully generated.
	 */
	async sendMessage(
		chatId: string,
		options: SendMessageOptions,
	): Promise<SendMessageResult> {
		const { org, personal, ...body } = options;
		return this.http.post<SendMessageResult>(
			`/chats/${chatId}/messages${tenantQuery({ org, personal })}`,
			body,
		);
	}
}
