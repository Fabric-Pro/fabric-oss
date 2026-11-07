import { db } from "../client";
import {
	type ReportDiagnosticSource,
	reportDiagnosticProviderSchema,
	safeReportDiagnosticLabel,
} from "./lib/report-public-diagnostics";
import { canReadOrganizationMcpConfigs } from "./organization-permissions";

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
/** Call after report authorization. Public transports use shared labels only; Portal opt-in also rechecks current MCP read authority. */
export async function loadReportDiagnosticSources(
	actor: { userId: string; organizationId?: string | null },
	instance: {
		connections?: unknown;
		template?: { connections?: unknown; definition?: unknown };
	},
	options: { includeOwnedConnectionLabels?: boolean } = {},
): Promise<Map<string, ReportDiagnosticSource>> {
	const connections = record(instance.connections);
	const ids = Array.isArray(connections.mcpConfigs)
		? [
				...new Set(
					connections.mcpConfigs.filter(
						(id): id is string =>
							typeof id === "string" &&
							id.length > 0 &&
							id.length <= 128,
					),
				),
			].slice(0, 50)
		: [];
	const sources = new Map<string, ReportDiagnosticSource>();
	if (!actor.organizationId || !ids.length) {
		return sources;
	}
	const bindings = record(connections.mcpBindings);
	const requirementConfig = record(instance.template?.connections);
	const requirements = Array.isArray(requirementConfig.mcpServers)
		? requirementConfig.mcpServers.map(record)
		: [];
	const definition = record(instance.template?.definition);
	const dataSources = Array.isArray(definition.dataSources)
		? definition.dataSources.map(record)
		: [];
	// A teammate's private display name is not part of a shared report's public result.
	const allowOwned =
		options.includeOwnedConnectionLabels === true &&
		(await canReadOrganizationMcpConfigs(
			actor.userId,
			actor.organizationId,
		));
	const own = allowOwned
		? await db.mCPConfig.findMany({
				where: {
					id: { in: ids },
					userId: actor.userId,
					organizationId: actor.organizationId,
				},
				select: {
					id: true,
					displayName: true,
					mcpServer: { select: { key: true, name: true } },
				},
			})
		: [];
	for (const [index, id] of ids.entries()) {
		const binding = Object.entries(bindings).find(
			([, configId]) => configId === id,
		)?.[0];
		const dataSource = dataSources.find(
			(row) => row.id === binding || row.provider === binding,
		);
		const requirement = requirements.find(
			(row) => row.key === binding || row.key === dataSource?.provider,
		);
		const config = own.find((row) => row.id === id);
		const provider = reportDiagnosticProviderSchema.safeParse(
			dataSource?.provider ?? requirement?.key ?? config?.mcpServer?.key,
		);
		const ownLabel =
			safeReportDiagnosticLabel(config?.displayName, ids) ??
			safeReportDiagnosticLabel(config?.mcpServer?.name, ids);
		const sharedLabel = safeReportDiagnosticLabel(requirement?.name, ids);
		sources.set(id, {
			displayLabel: sharedLabel ?? ownLabel ?? `Source ${index + 1}`,
			providerType: provider.success ? provider.data : "other",
		});
	}
	// Duplicate human names still need distinct visible and accessible reconnect actions.
	const occurrences = new Map<string, number>();
	for (const source of sources.values()) {
		occurrences.set(
			source.displayLabel,
			(occurrences.get(source.displayLabel) ?? 0) + 1,
		);
	}
	const ordinal = new Map<string, number>();
	for (const source of sources.values()) {
		if ((occurrences.get(source.displayLabel) ?? 0) > 1) {
			const label = source.displayLabel;
			const number = (ordinal.get(label) ?? 0) + 1;
			ordinal.set(label, number);
			source.displayLabel = `${label} (${number})`;
		}
	}
	return sources;
}
