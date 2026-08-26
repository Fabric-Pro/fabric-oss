import type { SyncCursor } from "../../../workflows/connector-sync/types";
import type { ConnectorCredentials, Document, Resource } from "./types";

interface SnowflakeSyncConfig {
	accountIdentifier?: string;
	database?: string;
	schema?: string;
	warehouse?: string;
	role?: string;
	tables?: string[];
	maxRowsPerTable?: number;
}

interface SnowflakeStatementResponse {
	statementHandle?: string;
	data?: string[][];
	resultSetMetaData?: {
		rowType?: Array<{
			name?: string;
		}>;
	};
}

interface BigQuerySyncConfig {
	projectId?: string;
	datasetId?: string;
	tables?: string[];
	maxRowsPerTable?: number;
}

function getSnowflakeToken(credentials: ConnectorCredentials): string | null {
	return typeof credentials.apiKey === "string"
		? credentials.apiKey
		: typeof credentials.accessToken === "string"
			? credentials.accessToken
			: null;
}

function normalizeSnowflakeAccountIdentifier(
	accountIdentifier: string,
): string {
	const normalized = accountIdentifier
		.trim()
		.replace(/^https?:\/\//, "")
		.replace(/\/+$/, "")
		.replace(/\.snowflakecomputing\.com$/i, "");
	return normalized;
}

function quoteSnowflakeIdentifier(identifier: string): string {
	return `"${identifier.replace(/"/g, '""')}"`;
}

async function executeSnowflakeStatement(input: {
	token: string;
	config: SnowflakeSyncConfig;
	statement: string;
}): Promise<SnowflakeStatementResponse> {
	if (!input.config.accountIdentifier) {
		throw new Error("Snowflake accountIdentifier is required");
	}

	const account = normalizeSnowflakeAccountIdentifier(
		input.config.accountIdentifier,
	);
	const response = await fetch(
		`https://${account}.snowflakecomputing.com/api/v2/statements`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${input.token}`,
				"Content-Type": "application/json",
				Accept: "application/json",
				"X-Snowflake-Authorization-Token-Type": "OAUTH",
			},
			body: JSON.stringify({
				statement: input.statement,
				timeout: 60,
				database: input.config.database,
				schema: input.config.schema,
				warehouse: input.config.warehouse,
				role: input.config.role,
			}),
		},
	);

	if (!response.ok) {
		throw new Error(`Snowflake SQL API error ${response.status}`);
	}

	return (await response.json()) as SnowflakeStatementResponse;
}

function getSnowflakeConfig(
	providerConfig: Record<string, unknown>,
): SnowflakeSyncConfig {
	return providerConfig as SnowflakeSyncConfig;
}

function getBigQueryToken(credentials: ConnectorCredentials): string | null {
	return typeof credentials.apiKey === "string"
		? credentials.apiKey
		: typeof credentials.accessToken === "string"
			? credentials.accessToken
			: null;
}

function getBigQueryConfig(
	providerConfig: Record<string, unknown>,
): BigQuerySyncConfig {
	return providerConfig as BigQuerySyncConfig;
}

async function fetchBigQueryJson<T>(input: {
	token: string;
	path: string;
	query?: Record<string, string>;
}): Promise<T> {
	const queryString = input.query
		? `?${new URLSearchParams(input.query).toString()}`
		: "";
	const response = await fetch(
		`https://bigquery.googleapis.com/bigquery/v2/${input.path}${queryString}`,
		{
			headers: {
				Authorization: `Bearer ${input.token}`,
				Accept: "application/json",
			},
		},
	);

	if (!response.ok) {
		throw new Error(
			`BigQuery API error ${response.status} for ${input.path}`,
		);
	}

	return (await response.json()) as T;
}

export async function testSnowflakeConnection(
	credentials: ConnectorCredentials,
) {
	return getSnowflakeToken(credentials) !== null;
}

export async function testBigQueryConnection(
	credentials: ConnectorCredentials,
) {
	return getBigQueryToken(credentials) !== null;
}

export async function discoverSnowflakeResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const token = getSnowflakeToken(input.credentials);
	if (!token) {
		throw new Error("Snowflake token is required");
	}

	const config = getSnowflakeConfig(input.providerConfig);
	if (!config.accountIdentifier || !config.database || !config.schema) {
		throw new Error(
			"Snowflake accountIdentifier, database, and schema are required",
		);
	}

	if (config.tables?.length) {
		return config.tables.map((tableName) => ({
			id: `snowflake:${config.database}.${config.schema}.${tableName}`,
			name: tableName,
			type: "snowflake-table",
			metadata: {
				database: config.database,
				schema: config.schema,
				tableName,
			},
		}));
	}

	const statement = `SELECT TABLE_NAME, COALESCE(COMMENT, '') AS COMMENT FROM ${quoteSnowflakeIdentifier(config.database)}.INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '${config.schema.replace(/'/g, "''")}' ORDER BY TABLE_NAME LIMIT 100`;
	const result = await executeSnowflakeStatement({
		token,
		config,
		statement,
	});

	return (result.data ?? []).map((row) => ({
		id: `snowflake:${config.database}.${config.schema}.${row[0]}`,
		name: row[0],
		type: "snowflake-table",
		metadata: {
			database: config.database,
			schema: config.schema,
			tableName: row[0],
			comment: row[1] || null,
		},
	}));
}

export async function fetchSnowflakeResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
	providerConfig?: Record<string, unknown>;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const token = getSnowflakeToken(input.credentials);
	if (!token) {
		throw new Error("Snowflake token is required");
	}

	const config = getSnowflakeConfig(input.providerConfig ?? {});
	const database =
		typeof input.resource.metadata?.database === "string"
			? input.resource.metadata.database
			: config.database;
	const schema =
		typeof input.resource.metadata?.schema === "string"
			? input.resource.metadata.schema
			: config.schema;
	const tableName =
		typeof input.resource.metadata?.tableName === "string"
			? input.resource.metadata.tableName
			: input.resource.name;

	if (!config.accountIdentifier || !database || !schema || !tableName) {
		throw new Error("Snowflake resource metadata is incomplete");
	}

	const maxRows = Math.max(
		1,
		Math.min(
			typeof config.maxRowsPerTable === "number"
				? config.maxRowsPerTable
				: 25,
			100,
		),
	);
	const statement = `SELECT * FROM ${quoteSnowflakeIdentifier(database)}.${quoteSnowflakeIdentifier(schema)}.${quoteSnowflakeIdentifier(tableName)} LIMIT ${maxRows}`;
	const result = await executeSnowflakeStatement({
		token,
		config,
		statement,
	});

	const columns =
		result.resultSetMetaData?.rowType?.map(
			(column) => column.name ?? "column",
		) ?? [];
	const rows = result.data ?? [];
	const renderedRows = rows.map((row, rowIndex) => {
		const mapped = row
			.map(
				(value, columnIndex) =>
					`${columns[columnIndex] ?? `column_${columnIndex + 1}`}: ${value}`,
			)
			.join("\n");
		return `Row ${rowIndex + 1}\n${mapped}`;
	});
	const content = [
		"Snowflake table snapshot",
		`Database: ${database}`,
		`Schema: ${schema}`,
		`Table: ${tableName}`,
		"",
		renderedRows.join("\n\n---\n\n") || "(No rows returned)",
	].join("\n");

	return {
		documents: [
			{
				id: `snowflake-table-${database}-${schema}-${tableName}`,
				externalId: `snowflake:${database}.${schema}.${tableName}`,
				title: `${database}.${schema}.${tableName}`,
				content,
				contentHash: `${tableName}:${rows.length}:${columns.join(",")}`,
				metadata: {
					resourceType: "table",
					database,
					schema,
					tableName,
					columnNames: columns,
					rowCountSampled: rows.length,
				},
				sizeBytes: Buffer.byteLength(content, "utf8"),
				textLength: content.length,
			},
		],
		newCursor: {
			connectorId: input.connectorId,
			provider: "SNOWFLAKE",
			cursorType: "incremental",
			cursor: new Date().toISOString(),
			lastSyncedAt: new Date().toISOString(),
		},
	};
}

export async function discoverBigQueryResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const token = getBigQueryToken(input.credentials);
	if (!token) {
		throw new Error("BigQuery token is required");
	}

	const config = getBigQueryConfig(input.providerConfig);
	if (!config.projectId || !config.datasetId) {
		throw new Error("BigQuery projectId and datasetId are required");
	}

	if (config.tables?.length) {
		return config.tables.map((tableName) => ({
			id: `bigquery:${config.projectId}.${config.datasetId}.${tableName}`,
			name: tableName,
			type: "bigquery-table",
			metadata: {
				projectId: config.projectId,
				datasetId: config.datasetId,
				tableName,
			},
		}));
	}

	const result = await fetchBigQueryJson<{
		tables?: Array<{
			tableReference?: {
				projectId?: string;
				datasetId?: string;
				tableId?: string;
			};
			friendlyName?: string;
			description?: string;
		}>;
	}>({
		token,
		path: `projects/${config.projectId}/datasets/${config.datasetId}/tables`,
		query: {
			maxResults: "100",
		},
	});

	const resources: Resource[] = [];
	for (const table of result.tables ?? []) {
		const ref = table.tableReference;
		if (!ref?.projectId || !ref.datasetId || !ref.tableId) {
			continue;
		}

		resources.push({
			id: `bigquery:${ref.projectId}.${ref.datasetId}.${ref.tableId}`,
			name: table.friendlyName || ref.tableId,
			type: "bigquery-table",
			metadata: {
				projectId: ref.projectId,
				datasetId: ref.datasetId,
				tableName: ref.tableId,
				description: table.description ?? null,
			},
		});
	}

	return resources;
}

export async function fetchBigQueryResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
	providerConfig?: Record<string, unknown>;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const token = getBigQueryToken(input.credentials);
	if (!token) {
		throw new Error("BigQuery token is required");
	}

	const config = getBigQueryConfig(input.providerConfig ?? {});
	const projectId =
		typeof input.resource.metadata?.projectId === "string"
			? input.resource.metadata.projectId
			: config.projectId;
	const datasetId =
		typeof input.resource.metadata?.datasetId === "string"
			? input.resource.metadata.datasetId
			: config.datasetId;
	const tableName =
		typeof input.resource.metadata?.tableName === "string"
			? input.resource.metadata.tableName
			: input.resource.name;

	if (!projectId || !datasetId || !tableName) {
		throw new Error("BigQuery resource metadata is incomplete");
	}

	const maxRows = Math.max(
		1,
		Math.min(
			typeof config.maxRowsPerTable === "number"
				? config.maxRowsPerTable
				: 25,
			100,
		),
	);
	const result = await fetchBigQueryJson<{
		schema?: {
			fields?: Array<{ name?: string }>;
		};
		rows?: Array<{
			f?: Array<{ v?: unknown }>;
		}>;
	}>({
		token,
		path: `projects/${projectId}/datasets/${datasetId}/tables/${tableName}/data`,
		query: {
			maxResults: String(maxRows),
		},
	});

	const columns =
		result.schema?.fields?.map((field) => field.name ?? "column") ?? [];
	const rows = result.rows ?? [];
	const renderedRows = rows.map((row, rowIndex) => {
		const mapped = (row.f ?? [])
			.map(
				(value, columnIndex) =>
					`${columns[columnIndex] ?? `column_${columnIndex + 1}`}: ${String(value.v ?? "")}`,
			)
			.join("\n");
		return `Row ${rowIndex + 1}\n${mapped}`;
	});
	const content = [
		"BigQuery table snapshot",
		`Project: ${projectId}`,
		`Dataset: ${datasetId}`,
		`Table: ${tableName}`,
		"",
		renderedRows.join("\n\n---\n\n") || "(No rows returned)",
	].join("\n");

	return {
		documents: [
			{
				id: `bigquery-table-${projectId}-${datasetId}-${tableName}`,
				externalId: `bigquery:${projectId}.${datasetId}.${tableName}`,
				title: `${projectId}.${datasetId}.${tableName}`,
				content,
				contentHash: `${tableName}:${rows.length}:${columns.join(",")}`,
				metadata: {
					resourceType: "table",
					projectId,
					datasetId,
					tableName,
					columnNames: columns,
					rowCountSampled: rows.length,
				},
				sizeBytes: Buffer.byteLength(content, "utf8"),
				textLength: content.length,
			},
		],
		newCursor: {
			connectorId: input.connectorId,
			provider: "BIGQUERY",
			cursorType: "incremental",
			cursor: new Date().toISOString(),
			lastSyncedAt: new Date().toISOString(),
		},
	};
}
