import {
	getReportProjectKnowledge,
	isProjectKnowledgeSource,
} from "@repo/database";
import type {
	DataSourceDefinition,
	DataSourceHandler,
	FetchContext,
	InstanceConnections,
} from "../types";

/** Only the implemented, read-only project knowledge operation is registered. */
export class FabricDataSourceHandler implements DataSourceHandler {
	type = "fabric" as const;
	supportedProviders = ["fabric_project"];
	async validateConnection(
		source: DataSourceDefinition,
		_connections: InstanceConnections,
		_userId: string,
		organizationId?: string,
	) {
		return organizationId && isProjectKnowledgeSource(source)
			? { valid: true }
			: {
					valid: false,
					error: "Choose a project audience for Project knowledge",
				};
	}
	async fetchData(
		source: DataSourceDefinition,
		_connections: InstanceConnections,
		context: FetchContext,
	) {
		if (!context.organizationId || !isProjectKnowledgeSource(source)) {
			throw new Error(
				"Project knowledge requires an organization report",
			);
		}
		const result = await getReportProjectKnowledge({
			executionId: context.executionId,
			sourceId: source.id,
			userId: context.userId,
			organizationId: context.organizationId,
			dateRange: context.dateRange,
		});
		return {
			success: true,
			data: result.records,
			recordCount: result.records.length,
			hasMore:
				result.hasMore ||
				result.records.some((record) => record.truncated),
			metadata: {
				provider: "fabric_project",
				operation: "project_knowledge",
				fetchedAt: new Date().toISOString(),
				provenance: result.records.map(
					({
						id,
						kind,
						title,
						revision,
						updatedAt,
						excerptHash,
						citation,
					}) => ({
						id,
						kind,
						title,
						revision,
						updatedAt,
						excerptHash,
						citation,
					}),
				),
			},
		};
	}
}
