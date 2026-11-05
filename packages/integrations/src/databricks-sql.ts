import { setTimeout as delay } from "node:timers/promises";
import * as databricksModule from "@repo/databricks";
const databricks =
	typeof databricksModule.DatabricksApiClient === "function"
		? databricksModule
		: ((databricksModule as { default?: typeof databricksModule })
				.default ?? databricksModule);
const {
	createOAuthM2MProvider,
	DatabricksApiClient,
	validateDatabricksWorkspaceOrigin,
} = databricks;
type DatabricksApiClient = InstanceType<typeof DatabricksApiClient>;

export type DatabricksSqlCredentials = Record<string, string>;
export type DatabricksSqlParameter = {
	name: string;
	type:
		| "STRING"
		| "BOOLEAN"
		| "INT"
		| "BIGINT"
		| "DOUBLE"
		| "DATE"
		| "TIMESTAMP";
	value: string | null;
};
export class DatabricksSqlError extends Error {
	constructor(
		message: string,
		readonly statementId?: string,
	) {
		super(message);
	}
}
const MAX_BYTES = 1_000_000;
const MAX_ROWS = 1000;
const ID = /^[a-zA-Z0-9-]{1,128}$/;

function clientFor(
	credentials: DatabricksSqlCredentials,
	fetchImpl = globalThis.fetch,
) {
	const host = validateDatabricksWorkspaceOrigin(
		credentials.DATABRICKS_HOST || "",
	);
	const { DATABRICKS_CLIENT_ID: clientId, DATABRICKS_CLIENT_SECRET: secret } =
		credentials;
	if (!clientId || !secret)
		throw new DatabricksSqlError(
			"Databricks SQL credentials are incomplete. Reconnect the selected connection.",
		);
	const boundedFetch: typeof fetch = async (input, init) => {
		if (new URL(String(input)).origin !== host)
			throw new DatabricksSqlError(
				"Databricks returned an unexpected origin.",
			);
		const response = await fetchImpl(input, {
			...init,
			redirect: "error",
			signal: init?.signal ?? AbortSignal.timeout(15_000),
		});
		if ([204, 205, 304].includes(response.status)) return response;
		const reader = response.body?.getReader();
		const parts: Uint8Array[] = [];
		let bytes = 0;
		if (reader) {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					bytes += value.byteLength;
					if (bytes > MAX_BYTES + 100_000) {
						await reader.cancel();
						throw new DatabricksSqlError(
							"Databricks response exceeded the result size limit.",
						);
					}
					parts.push(value);
				}
			} finally {
				reader.releaseLock();
			}
		}
		return new Response(Buffer.concat(parts), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
	const tokenProvider = createOAuthM2MProvider(
		host,
		clientId,
		secret,
		boundedFetch,
	);
	// Statement POSTs must never be automatically retried after an ambiguous response.
	return {
		host,
		client: new DatabricksApiClient({
			host,
			tokenProvider,
			fetchImpl: boundedFetch,
			maxRetries: 0,
		}),
	};
}
async function request<T>(
	client: DatabricksApiClient,
	method: string,
	path: string,
	body?: unknown,
	signal?: AbortSignal,
): Promise<T> {
	try {
		return await client.request<T>(method, path, body, { signal });
	} catch (error) {
		if (signal?.aborted)
			throw new DatabricksSqlError(
				"Databricks SQL was cancelled or timed out.",
			);
		if (error instanceof DatabricksSqlError) throw error;
		// Provider response bodies can contain SQL, row values, or credentials.
		throw new DatabricksSqlError(
			"Databricks SQL request failed. Check the selected connection and warehouse permissions.",
		);
	}
}
export async function listDatabricksSqlWarehouses(
	credentials: DatabricksSqlCredentials,
	fetchImpl?: typeof fetch,
) {
	const { client } = clientFor(credentials, fetchImpl);
	const result = await request<{
		warehouses?: Array<{ id: string; name: string; state: string }>;
	}>(
		client,
		"GET",
		"/api/2.0/sql/warehouses",
		undefined,
		AbortSignal.timeout(15_000),
	);
	return (result.warehouses ?? [])
		.slice(0, 500)
		.filter((w) => ID.test(w.id))
		.map((w) => ({ id: w.id, name: w.name, state: w.state }));
}
export async function verifyDatabricksSqlConnection(
	credentials: DatabricksSqlCredentials,
) {
	try {
		const warehouses = await listDatabricksSqlWarehouses(credentials);
		return {
			success: true,
			message: `Connected — ${warehouses.length} SQL warehouses visible`,
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof DatabricksSqlError
					? error.message
					: "Invalid Databricks SQL connection",
		};
	}
}
interface Chunk {
	data_array?: Array<Array<string | null>>;
	next_chunk_internal_link?: string;
}
interface Statement {
	statement_id?: string;
	status: { state: string };
	manifest?: {
		schema?: { columns?: Array<{ name: string; type_name?: string }> };
		truncated?: boolean;
	};
	result?: Chunk;
}
/** One bounded statement against existing running compute. No automatic preview, compute start, or job creation. */
export async function executeDatabricksSql(
	credentials: DatabricksSqlCredentials,
	input: {
		warehouseId: string;
		statement: string;
		parameters?: DatabricksSqlParameter[];
		rowLimit?: number;
		signal?: AbortSignal;
		fetchImpl?: typeof fetch;
		pollIntervalMs?: number;
	},
) {
	if (!ID.test(input.warehouseId))
		throw new DatabricksSqlError("Select a SQL warehouse.");
	if (
		!input.statement.trim() ||
		input.statement.length > 50_000 ||
		input.statement.includes("{{")
	)
		throw new DatabricksSqlError(
			"SQL must be static text. Use named parameters for values from earlier steps.",
		);
	const parameters = input.parameters ?? [];
	if (
		parameters.length > 50 ||
		parameters.some(
			(p) =>
				!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(p.name) ||
				![
					"STRING",
					"BOOLEAN",
					"INT",
					"BIGINT",
					"DOUBLE",
					"DATE",
					"TIMESTAMP",
				].includes(p.type) ||
				(p.value !== null &&
					(typeof p.value !== "string" || p.value.length > 20_000)),
		) ||
		new Set(parameters.map((p) => p.name)).size !== parameters.length
	)
		throw new DatabricksSqlError(
			"SQL parameters must have unique names, supported types, and bounded values.",
		);
	const rowLimit = Math.min(
		MAX_ROWS,
		Math.max(1, Math.floor(input.rowLimit ?? 100)),
	);
	if (!Number.isFinite(rowLimit))
		throw new DatabricksSqlError("Result row limit is invalid.");
	const { client, host } = clientFor(credentials, input.fetchImpl);
	const signal = AbortSignal.any([
		AbortSignal.timeout(90_000),
		...(input.signal ? [input.signal] : []),
	]);
	let id: string | undefined;
	let terminal = false;
	try {
		const warehouse = await request<{ state: string }>(
			client,
			"GET",
			`/api/2.0/sql/warehouses/${input.warehouseId}`,
			undefined,
			signal,
		);
		if (warehouse.state !== "RUNNING")
			throw new DatabricksSqlError(
				"The selected warehouse is not running. Start it in Databricks, then run this workflow again.",
			);
		let statement: Statement;
		try {
			statement = await request<Statement>(
				client,
				"POST",
				"/api/2.0/sql/statements",
				{
					warehouse_id: input.warehouseId,
					statement: input.statement,
					parameters,
					format: "JSON_ARRAY",
					disposition: "INLINE",
					byte_limit: MAX_BYTES,
					row_limit: rowLimit,
					wait_timeout: "0s",
					on_wait_timeout: "CONTINUE",
				},
				signal,
			);
		} catch {
			throw new DatabricksSqlError(
				"Databricks did not confirm submission. The statement may have started; check Databricks query history before running again.",
			);
		}
		if (!statement.statement_id || !ID.test(statement.statement_id))
			throw new DatabricksSqlError(
				"Databricks did not return a valid statement ID. Check query history before running again.",
			);
		id = statement.statement_id;
		while (["PENDING", "RUNNING"].includes(statement.status.state)) {
			await delay(input.pollIntervalMs ?? 1000, undefined, { signal });
			statement = await request<Statement>(
				client,
				"GET",
				`/api/2.0/sql/statements/${id}`,
				undefined,
				signal,
			);
		}
		terminal = ["SUCCEEDED", "FAILED", "CANCELED", "CLOSED"].includes(
			statement.status.state,
		);
		if (statement.status.state !== "SUCCEEDED")
			throw new DatabricksSqlError(
				"Databricks SQL did not succeed. Inspect the statement in Databricks query history.",
				id,
			);
		const rows: Array<Array<string | null>> = [];
		let chunk = statement.result;
		let pages = 0;
		let bytes = 0;
		while (chunk) {
			const data = chunk.data_array ?? [];
			bytes += Buffer.byteLength(JSON.stringify(data));
			if (bytes > MAX_BYTES || rows.length + data.length > rowLimit)
				throw new DatabricksSqlError(
					"Databricks results exceeded the configured limit.",
					id,
				);
			rows.push(...data);
			const next = chunk.next_chunk_internal_link;
			if (!next) break;
			const pageUrl = new URL(next, host);
			if (
				++pages > 20 ||
				!next.startsWith("/") ||
				next.startsWith("//") ||
				pageUrl.origin !== host ||
				!new RegExp(
					`^/api/2[.]0/sql/statements/${id}/result/chunks/[0-9]+$`,
				).test(pageUrl.pathname) ||
				[...pageUrl.searchParams].some(
					([key, value]) =>
						key !== "row_offset" || !/^[0-9]+$/.test(value),
				)
			)
				throw new DatabricksSqlError(
					"Databricks returned an invalid result page.",
					id,
				);
			chunk = await request<Chunk>(
				client,
				"GET",
				next,
				undefined,
				signal,
			);
		}
		return {
			statementId: id,
			workspaceUrl: host,
			columns: statement.manifest?.schema?.columns ?? [],
			rows,
			truncated: statement.manifest?.truncated ?? false,
		};
	} catch (error) {
		if (id && !terminal) {
			try {
				await request(
					client,
					"POST",
					`/api/2.0/sql/statements/${id}/cancel`,
					undefined,
					AbortSignal.timeout(5000),
				);
			} catch {
				throw new DatabricksSqlError(
					"Databricks cancellation was not confirmed. Check query history before running again.",
					id,
				);
			}
		}
		throw new DatabricksSqlError(
			error instanceof DatabricksSqlError
				? error.message
				: "Databricks SQL was cancelled or timed out.",
			id,
		);
	}
}
