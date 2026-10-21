import { z } from "zod";
import { NATIVE_PLATFORM_READ_NODE_TYPE } from "./workflow-node-types";

export const NATIVE_PLATFORM_READ_TOOL_NAMES = [
	"fabric_get_project_pm_connection",
	"fabric_list_project_pm_members",
	"fabric_list_project_pm_work_item_types",
	"fabric_get_project_work_item_counts",
	"fabric_list_project_pm_assigned_items",
	"fabric_get_project_pm_item_snapshots",
] as const;

export const NATIVE_PLATFORM_READ_MAX_BYTES = 128 * 1024;

export const NativePlatformReadConfigSchema = z.strictObject({
	toolName: z.enum(NATIVE_PLATFORM_READ_TOOL_NAMES),
	arguments: z.string().min(1).max(16384),
});

const identity = z.looseObject({
	id: z.unknown().optional(),
	type: z.literal(NATIVE_PLATFORM_READ_NODE_TYPE),
});
const nodeSchema = identity.extend({
	id: z.string().min(1),
	data: z.looseObject({ config: NativePlatformReadConfigSchema }),
});

export function readPublishedNativePlatformReadConfig(
	nodes: unknown,
	nodeId: string,
) {
	const node = Array.isArray(nodes)
		? nodes.find((value) => {
				const parsed = identity.safeParse(value);
				return parsed.success && parsed.data.id === nodeId;
			})
		: undefined;
	return nodeSchema.parse(node).data.config;
}

export function workflowNativePlatformReadProblems(nodes: unknown): string[] {
	if (!Array.isArray(nodes)) {
		return [];
	}
	return nodes.flatMap((node) => {
		const parsed = identity.safeParse(node);
		if (!parsed.success || nodeSchema.safeParse(node).success) {
			return [];
		}
		const name =
			typeof parsed.data.id === "string"
				? parsed.data.id
				: "Native Platform Read";
		return [
			`${name}: invalid native read configuration (registered literal read-only tool and JSON argument template)`,
		];
	});
}
