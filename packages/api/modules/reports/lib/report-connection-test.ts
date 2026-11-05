/**
 * The live test of a report's MCP connections: connect to each server and
 * count the read-only tools the report can use, without running the report.
 * The report page's "Test connections" (`instances/test-connections`) shows
 * every connection's result; every Generate (`report-generation`) tests the
 * connections of the report's required data sources first and refuses a run
 * one of them would fail. Both use the run's own helpers (deriveProviders,
 * classifyToolOutcome, classifyConnectionError), so neither can disagree with
 * the run about a server.
 */

import {
	db,
	getWorkflowIntegrationById,
	resolveReportMcpConfig,
} from "@repo/database";
import { genericSourceDataType } from "@repo/database/prisma/queries/lib/report-data-types";
import { getCachedMcpClientForConfig } from "@repo/mcp";
import type { McpServerDiagnostic } from "@repo/temporal/report-diagnostics";
import {
	classifyConnectionError,
	classifyToolOutcome,
	deriveProviders,
	isReadOnlyTool,
	REPORT_CONNECTION_REFUSAL_PREFIX,
	redactMessage,
} from "@repo/temporal/report-diagnostics";

/**
 * How long one server may hold a Generate before it counts as failed. The MCP
 * client bounds each connection attempt at 15 seconds but not listing the tools,
 * so a server that connects and then hangs would hold the mutation for good. This
 * leaves room for one retry of a slow connect.
 */
const GENERATE_PROBE_TIMEOUT_MS = 30_000;

type ConnectionTenant = { userId: string; organizationId: string | null };

type TestedReport = {
	connections: unknown;
	template: { definition: unknown; connections: unknown };
};

type McpDataSource = {
	id?: string;
	key?: string;
	provider?: string;
	mcpServerKey?: string;
	/** Asks for a data type: it names no server, whatever tool is bound to it. */
	generic: boolean;
	required: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function definitionSources(definition: unknown): Record<string, unknown>[] {
	return isRecord(definition) && Array.isArray(definition.dataSources)
		? definition.dataSources.filter(isRecord)
		: [];
}

/** The definition's data sources that read through an MCP server. */
function mcpDataSources(definition: unknown): McpDataSource[] {
	return definitionSources(definition)
		.filter((source) => (text(source.type) ?? "mcp") === "mcp")
		.map((source) => ({
			id: text(source.id),
			key: text(source.key),
			provider: text(source.provider),
			mcpServerKey: isRecord(source.config)
				? text(source.config.mcpServerKey)
				: undefined,
			generic: genericSourceDataType(source) !== null,
			// A data source is required unless its template says otherwise, as a run reads it.
			required: source.required !== false,
		}));
}

/** The name the report page gives a data source: its template entry's, else its provider. */
function sourceName(
	source: McpDataSource,
	templateConnections: unknown,
): string {
	const servers =
		isRecord(templateConnections) &&
		Array.isArray(templateConnections.mcpServers)
			? templateConnections.mcpServers.filter(isRecord)
			: [];
	const keys = [source.key, source.provider, source.id].filter(Boolean);
	const entry = servers.find((server) => keys.includes(text(server.key)));
	return text(entry?.name) ?? source.provider ?? source.id ?? "A data source";
}

/**
 * Connects to each config and reports its read-only-tool availability. The
 * probes run concurrently, each with its own connection timeout, so one dead
 * server does not hold up the others.
 */
export async function probeReportConnections(
	configIds: string[],
	definition: unknown,
	tenant: ConnectionTenant,
	{ timeoutMs }: { timeoutMs?: number } = {},
): Promise<McpServerDiagnostic[]> {
	const providers = deriveProviders(
		definitionSources(definition).map((source) => ({
			provider: text(source.provider),
			config: {
				mcpServerKey: isRecord(source.config)
					? text(source.config.mcpServerKey)
					: undefined,
			},
		})),
	);

	// Friendly-name fallback for connections that fail before the server
	// identifies itself (otherwise the UI shows a raw config id).
	const displayRows = configIds.length
		? await db.mCPConfig.findMany({
				// TENANT ISOLATION (SOC 2 CC6.1): scope the display-name
				// lookup to the caller's tenant so a stray/foreign configId
				// can never surface another tenant's config/server names.
				where: {
					id: { in: configIds },
					...(tenant.organizationId
						? { organizationId: tenant.organizationId }
						: { userId: tenant.userId, organizationId: null }),
				},
				select: {
					id: true,
					displayName: true,
					mcpServer: { select: { name: true } },
				},
			})
		: [];
	const displayNames: Record<string, string> = {};
	for (const r of displayRows) {
		const name = r.displayName || r.mcpServer?.name;
		if (name) {
			displayNames[r.id] = name;
		}
	}

	return Promise.all(
		configIds.map(async (configId): Promise<McpServerDiagnostic> => {
			try {
				const connect = async () => {
					const result = await getCachedMcpClientForConfig({
						configId,
						userId: tenant.userId,
						organizationId: tenant.organizationId ?? undefined,
						// Only lists the server's tools.
						access: "read",
					});
					return { result, allTools: await result.client.tools() };
				};
				const { result, allTools } = await (timeoutMs
					? Promise.race([
							connect(),
							new Promise<never>((_, reject) => {
								setTimeout(
									() =>
										reject(
											new Error(
												"Connection test timed out",
											),
										),
									timeoutMs,
								);
							}),
						])
					: connect());
				const serverName =
					result.serverName || displayNames[configId] || configId;
				const total = Object.keys(allTools).length;
				let readOnly = 0;
				for (const toolName of Object.keys(allTools)) {
					if (isReadOnlyTool(toolName, providers)) {
						readOnly++;
					}
				}
				return {
					configId,
					serverName,
					outcome: classifyToolOutcome(total, readOnly),
					toolCount: total,
					readOnlyToolCount: readOnly,
				};
			} catch (error) {
				const raw =
					error instanceof Error ? error.message : String(error);
				const serverName =
					(isRecord(error) ? text(error.serverName) : undefined) ||
					displayNames[configId] ||
					configId;
				return {
					configId,
					serverName,
					outcome: classifyConnectionError(error),
					toolCount: 0,
					readOnlyToolCount: 0,
					errorMessage: redactMessage(raw),
				};
			}
		}),
	);
}

/**
 * The configs the report's required data sources run on, each with the name
 * the report page shows for its source. A binding resolves as the run
 * resolves it (`resolveReportMcpConfig`). An optional source never counts: a
 * run skips it when it fails. An unbound required source is left to the
 * readiness check, which asks for it to be connected. A report keyed by no
 * data source (an older one) runs on its raw configs, so all of them count.
 */
async function requiredSourceConfigs(
	report: TestedReport,
	tenant: ConnectionTenant,
): Promise<Map<string, string>> {
	const connections = isRecord(report.connections) ? report.connections : {};
	const bindings = isRecord(connections.mcpBindings)
		? connections.mcpBindings
		: {};
	const sources = mcpDataSources(report.template.definition).map(
		(source) => ({
			source,
			stored: [source.id, source.provider, source.key]
				.map((key) => (key ? text(bindings[key]) : undefined))
				.find((configId) => configId !== undefined),
		}),
	);
	const required = new Map<string, string>();
	if (!sources.some(({ stored }) => stored)) {
		for (const configId of stringList(connections.mcpConfigs)) {
			required.set(configId, configId);
		}
		return required;
	}
	for (const { source, stored } of sources) {
		if (!source.required || !stored) {
			continue;
		}
		const resolved = await resolveReportMcpConfig({
			storedConfigId: stored,
			serverKeys: source.generic
				? []
				: [
						source.provider,
						source.key,
						source.id,
						source.mcpServerKey,
					].filter((key): key is string => key !== undefined),
			userId: tenant.userId,
			organizationId: tenant.organizationId ?? undefined,
		});
		required.set(
			resolved?.configId ?? stored,
			sourceName(source, report.template.connections),
		);
	}
	return required;
}

/**
 * The required integrations someone switched off since the report was saved, by
 * name. An integration has no sign-in to test live: `isActive` is the only state it
 * stores, so whether its credentials still work shows only when a run uses them.
 */
async function switchedOffIntegrations(
	report: TestedReport,
	tenant: ConnectionTenant,
): Promise<string[]> {
	const declared = isRecord(report.template.connections)
		? report.template.connections.integrations
		: undefined;
	const connections = isRecord(report.connections) ? report.connections : {};
	const bindings = isRecord(connections.integrationBindings)
		? connections.integrationBindings
		: {};
	const required = (Array.isArray(declared) ? declared : [])
		.filter(isRecord)
		.flatMap((source) => {
			const key = text(source.key);
			const integrationId = key ? text(bindings[key]) : undefined;
			return source.required === true && key && integrationId
				? [{ name: text(source.name) ?? key, integrationId }]
				: [];
		});
	const states = await Promise.all(
		required.map(async ({ name, integrationId }) => ({
			name,
			integration: await getWorkflowIntegrationById(
				integrationId,
				tenant.userId,
				tenant.organizationId ?? undefined,
			),
		})),
	);
	return states
		.filter(({ integration }) => integration?.isActive === false)
		.map(({ name }) => name);
}

/** Why a connection test did not pass, in words for the person who pressed Generate. */
function failureReason(outcome: McpServerDiagnostic["outcome"]): string {
	switch (outcome) {
		case "connected":
			return "it connected";
		case "auth_failed":
			return "its sign-in was refused or has expired";
		case "unreachable":
			return "its server could not be reached";
		case "zero_tools":
			return "its server offers no tools";
		case "no_read_only_tools":
			return "its server offers no tools the report can read with";
		case "error":
			return "the connection test failed";
		default: {
			const unhandled: never = outcome;
			throw new Error(`Unhandled connection outcome: ${unhandled}`);
		}
	}
}

/**
 * Why the report cannot be generated now because a required data source does
 * not connect, naming each source that failed, or `null` when every required
 * source passes the live test (or the report has none).
 */
export async function reportSourceConnectionFailure(
	report: TestedReport,
	tenant: ConnectionTenant,
): Promise<string | null> {
	const switchedOff = await switchedOffIntegrations(report, tenant);
	const required = await requiredSourceConfigs(report, tenant);
	const diagnostics =
		required.size > 0
			? await probeReportConnections(
					[...required.keys()],
					report.template.definition,
					tenant,
					{ timeoutMs: GENERATE_PROBE_TIMEOUT_MS },
				)
			: [];
	const failed = diagnostics.filter(
		(diagnostic) => diagnostic.outcome !== "connected",
	);
	if (switchedOff.length === 0 && failed.length === 0) {
		return null;
	}
	const named = [
		...switchedOff.map((name) => `${name}: it is switched off`),
		...failed.map((diagnostic) => {
			const name = required.get(diagnostic.configId);
			return `${name && name !== diagnostic.configId ? name : diagnostic.serverName}: ${failureReason(diagnostic.outcome)}`;
		}),
	];
	return `${REPORT_CONNECTION_REFUSAL_PREFIX}, so the report was not generated. ${named.join("; ")}. Fix the connection on the report page, then generate again.`;
}
