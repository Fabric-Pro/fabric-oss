import { type DatabricksApiClient, getDatabricksClient } from "./api-client";

// ---------------------------------------------------------------------------
// Databricks Genie Agents Conversational API Types
// ---------------------------------------------------------------------------

export type GenieMessageStatus =
	| "SUBMITTED"
	| "FETCHING_METADATA"
	| "FILTERING_CONTEXT"
	| "ASKING_AI"
	| "PENDING_WAREHOUSE"
	| "EXECUTING_QUERY"
	| "COMPLETED"
	| "FAILED"
	| "QUERY_RESULT_EXPIRED"
	| "CANCELLED";

export interface GenieAttachmentText {
	content: string;
}

export interface GenieAttachmentQuery {
	title?: string;
	description?: string;
	query: string;
	statement_id?: string;
}

export interface GenieAttachment {
	attachment_id?: string;
	text?: GenieAttachmentText;
	query?: GenieAttachmentQuery;
}

export interface GenieMessageResponse {
	id: string;
	space_id: string;
	conversation_id: string;
	content: string;
	status: GenieMessageStatus;
	attachments?: GenieAttachment[];
	error?: {
		error: string;
		type?: string;
	};
}

export interface GenieStartConversationResponse {
	conversation_id: string;
	message_id: string;
	conversation?: {
		id: string;
		space_id: string;
		title?: string;
	};
	message?: GenieMessageResponse;
}

export interface GenieQueryResultStatementResponse {
	statement_response?: {
		status?: { state?: string };
		manifest?: {
			schema?: {
				columns?: Array<{ name: string; type_name?: string }>;
			};
			total_row_count?: number;
		};
		result?: {
			data_array?: Array<Array<string | number | boolean | null>>;
		};
	};
}

export interface GenieAskResult {
	spaceId: string;
	conversationId: string;
	messageId: string;
	status: GenieMessageStatus;
	text: string[];
	queries: Array<{
		attachmentId?: string;
		title?: string;
		description?: string;
		sql: string;
		columns?: string[];
		rows?: Array<Array<string | number | boolean | null>>;
	}>;
}

const TERMINAL_GENIE_STATUSES: ReadonlySet<GenieMessageStatus> = new Set([
	"COMPLETED",
	"FAILED",
	"QUERY_RESULT_EXPIRED",
	"CANCELLED",
]);

// ---------------------------------------------------------------------------
// Databricks Genie Client
// ---------------------------------------------------------------------------

export class DatabricksGenieClient {
	private readonly api: DatabricksApiClient;

	constructor(api?: DatabricksApiClient) {
		this.api = api ?? getDatabricksClient();
	}

	async startConversation(
		spaceId: string,
		content: string,
		options?: { signal?: AbortSignal },
	): Promise<GenieStartConversationResponse> {
		return this.api.request<GenieStartConversationResponse>(
			"POST",
			`/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}/start-conversation`,
			{ content },
			options,
		);
	}

	async createMessage(
		spaceId: string,
		conversationId: string,
		content: string,
		options?: { signal?: AbortSignal },
	): Promise<GenieMessageResponse> {
		return this.api.request<GenieMessageResponse>(
			"POST",
			`/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
			{ content },
			options,
		);
	}

	async getMessage(
		spaceId: string,
		conversationId: string,
		messageId: string,
		options?: { signal?: AbortSignal },
	): Promise<GenieMessageResponse> {
		return this.api.request<GenieMessageResponse>(
			"GET",
			`/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
			undefined,
			options,
		);
	}

	async getMessageAttachmentQueryResult(
		spaceId: string,
		conversationId: string,
		messageId: string,
		attachmentId: string,
		options?: { signal?: AbortSignal },
	): Promise<GenieQueryResultStatementResponse> {
		return this.api.request<GenieQueryResultStatementResponse>(
			"GET",
			`/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/query-result`,
			undefined,
			options,
		);
	}

	/**
	 * Sends a natural-language question to a Databricks Genie Agent, polls until
	 * completion, and returns the synthesized text answers, generated SQL, and
	 * query result rows.
	 */
	async askGenieAgent(
		agentOrSpaceId: string,
		content: string,
		options?: {
			conversationId?: string;
			pollIntervalMs?: number;
			maxWaitMs?: number;
			signal?: AbortSignal;
		},
	): Promise<GenieAskResult> {
		return this.askSpace(agentOrSpaceId, content, options);
	}

	/**
	 * Alias for `askGenieAgent` using the underlying `/api/2.0/genie/spaces/{id}`
	 * REST endpoint parameter name.
	 */
	async askSpace(
		spaceId: string,
		content: string,
		options?: {
			conversationId?: string;
			pollIntervalMs?: number;
			maxWaitMs?: number;
			signal?: AbortSignal;
		},
	): Promise<GenieAskResult> {
		const normalizedSpaceId = spaceId.trim();
		if (!normalizedSpaceId) {
			throw new Error("Genie Agent ID is required");
		}
		const pollIntervalMs = options?.pollIntervalMs ?? 1500;
		const maxWaitMs = options?.maxWaitMs ?? 60_000;
		const startedAt = Date.now();

		let conversationId = options?.conversationId?.trim();
		let messageId: string;

		if (conversationId) {
			const msg = await this.createMessage(
				normalizedSpaceId,
				conversationId,
				content,
				{ signal: options?.signal },
			);
			messageId = msg.id;
		} else {
			const started = await this.startConversation(
				normalizedSpaceId,
				content,
				{
					signal: options?.signal,
				},
			);
			conversationId =
				started.conversation_id ?? started.conversation?.id ?? "";
			messageId = started.message_id ?? started.message?.id ?? "";
		}

		if (!conversationId || !messageId) {
			throw new Error(
				"Genie Agent did not return a valid conversationId and messageId",
			);
		}

		let message = await this.getMessage(
			normalizedSpaceId,
			conversationId,
			messageId,
			{ signal: options?.signal },
		);

		let pollAttempt = 0;
		while (!TERMINAL_GENIE_STATUSES.has(message.status)) {
			if (Date.now() - startedAt >= maxWaitMs) {
				break;
			}
			const delayMs = Math.min(
				Math.round(pollIntervalMs * 1.25 ** pollAttempt),
				10_000,
			);
			pollAttempt += 1;
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, delayMs);
				options?.signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(
							options.signal?.reason ??
								new Error("Aborted waiting for Genie Agent"),
						);
					},
					{ once: true },
				);
			});
			message = await this.getMessage(
				normalizedSpaceId,
				conversationId,
				messageId,
				{ signal: options?.signal },
			);
		}

		const text: string[] = [];
		const queries: GenieAskResult["queries"] = [];

		for (const attachment of message.attachments ?? []) {
			if (attachment.text?.content) {
				text.push(attachment.text.content);
			}
			if (attachment.query?.query) {
				let columns: string[] | undefined;
				let rows:
					| Array<Array<string | number | boolean | null>>
					| undefined;

				if (
					attachment.attachment_id &&
					message.status === "COMPLETED"
				) {
					try {
						const queryResult =
							await this.getMessageAttachmentQueryResult(
								spaceId,
								conversationId,
								messageId,
								attachment.attachment_id,
								{ signal: options?.signal },
							);
						columns =
							queryResult.statement_response?.manifest?.schema?.columns?.map(
								(col) => col.name,
							);
						rows =
							queryResult.statement_response?.result?.data_array;
					} catch {
						// Best-effort result retrieval; SQL is still returned.
					}
				}

				queries.push({
					attachmentId: attachment.attachment_id,
					title: attachment.query.title,
					description: attachment.query.description,
					sql: attachment.query.query,
					columns,
					rows,
				});
			}
		}

		return {
			spaceId,
			conversationId,
			messageId,
			status: message.status,
			text,
			queries,
		};
	}
}

// ---------------------------------------------------------------------------
// Databricks Lakebase & Genie Agents Production Configuration
// ---------------------------------------------------------------------------

export interface DatabricksLakebaseConfig {
	instanceName?: string;
	databaseUrl?: string;
	unityCatalog: string;
	unitySchema: string;
	defaultGenieAgentId?: string;
	/** Backward-compatible alias for `defaultGenieAgentId`. */
	defaultGenieSpaceId?: string;
	enabled: boolean;
}

/**
 * Resolves Databricks Lakebase (Serverless Postgres + pgvector + Delta table sync)
 * and Genie Agents settings for production deployments.
 */
export function getDatabricksLakebaseConfig(
	env: NodeJS.ProcessEnv = process.env,
): DatabricksLakebaseConfig {
	const instanceName = env.DATABRICKS_LAKEBASE_INSTANCE_NAME?.trim();
	const databaseUrl = env.DATABRICKS_LAKEBASE_DATABASE_URL?.trim();
	const unityCatalog =
		env.DATABRICKS_UNITY_CATALOG?.trim() || "fabric_production";
	const unitySchema = env.DATABRICKS_UNITY_SCHEMA?.trim() || "telemetry";
	const defaultGenieAgentId =
		env.DATABRICKS_GENIE_DEFAULT_AGENT_ID?.trim() ||
		env.DATABRICKS_GENIE_DEFAULT_SPACE_ID?.trim() ||
		undefined;

	return {
		instanceName: instanceName || undefined,
		databaseUrl: databaseUrl || undefined,
		unityCatalog,
		unitySchema,
		defaultGenieAgentId,
		defaultGenieSpaceId: defaultGenieAgentId,
		enabled: Boolean(instanceName || databaseUrl || defaultGenieAgentId),
	};
}
