import { pageMayDeclareTool } from "@repo/temporal/fabric-page-tool-definitions";
import { selectionAllowsTool } from "../server-selection";
import { jsonResult } from "../tool-results";
import type { GatewaySession, GatewayToolDefinition } from "../types";

/** Discovery describes executable platform schemas, never connected credentials or data. */
export function listPageTools(
	args: Record<string, unknown>,
	session: GatewaySession,
	definitions: GatewayToolDefinition[],
) {
	const query =
		typeof args.query === "string"
			? args.query.trim().slice(0, 200).toLowerCase()
			: "";
	const limit =
		typeof args.limit === "number" && Number.isFinite(args.limit)
			? Math.max(1, Math.min(50, Math.floor(args.limit)))
			: 20;
	const names = new Set(definitions.map((tool) => tool.name));
	const matches = definitions.filter(
		(tool) =>
			pageMayDeclareTool(tool.name, names) &&
			selectionAllowsTool(session, tool.name) &&
			(!query ||
				`${tool.name} ${tool.description}`
					.toLowerCase()
					.includes(query)),
	);
	return jsonResult({
		tools: matches
			.slice(0, limit)
			.map(({ name, description, inputSchema, annotations }) => ({
				name,
				description,
				inputSchema,
				annotations,
			})),
		total: matches.length,
		hasMore: matches.length > limit,
		guidance:
			"Declare the exact names used by fabric.call in runtimeTools. Provide required arguments from inputSchema; fabric_list_features requires projectId, fabric_page_data_set takes records:[{key,value}], and fabric_page_file_read takes id, not fileId. For ADO dashboards discover fabric_get_project_pm_connection, fabric_list_project_pm_members and fabric_get_project_work_item_counts. Chat-only fabric_list_project_features is not a page tool. Narrow query when hasMore is true. Connected reads declare connected:<provider>/<tool>, never the fabric_page_read_connected proxy itself.",
	});
}
