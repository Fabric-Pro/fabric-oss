import { z } from "zod";
import {
	WORKSPACE_DATA_READ_NODE_TYPE,
	WORKSPACE_DATA_WRITE_NODE_TYPE,
} from "./workflow-node-types";

const literalId = z
	.string()
	.min(1)
	.max(128)
	.refine((value) => !/[{}]/.test(value));
const collection = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_.-]+$/);
const recordConfig = z.strictObject({
	frameId: literalId,
	collection,
	key: z.string().min(1).max(1024),
	scope: z.enum(["shared", "mine"]),
});

export const WorkspaceDataReadConfigSchema = recordConfig;
export const WorkspaceDataWriteConfigSchema = recordConfig.extend({
	value: z.string().min(1).max(65536),
	expectedVersion: z.union([
		z.number().int().nonnegative(),
		z.string().min(1).max(1024),
	]),
});

const dataNodeIdentity = z.looseObject({
	id: z.unknown().optional(),
	type: z.enum([
		WORKSPACE_DATA_READ_NODE_TYPE,
		WORKSPACE_DATA_WRITE_NODE_TYPE,
	]),
});

export const WorkspaceDataNodeSchema = z.discriminatedUnion("type", [
	z.looseObject({
		id: z.string().min(1),
		type: z.literal(WORKSPACE_DATA_READ_NODE_TYPE),
		data: z.looseObject({ config: WorkspaceDataReadConfigSchema }),
	}),
	z.looseObject({
		id: z.string().min(1),
		type: z.literal(WORKSPACE_DATA_WRITE_NODE_TYPE),
		data: z.looseObject({ config: WorkspaceDataWriteConfigSchema }),
	}),
]);

export function readPublishedWorkspaceDataNode(nodes: unknown, nodeId: string) {
	const node = Array.isArray(nodes)
		? nodes.find((value) => {
				const identity = dataNodeIdentity.safeParse(value);
				return identity.success && identity.data.id === nodeId;
			})
		: undefined;
	return WorkspaceDataNodeSchema.parse(node);
}

export function workflowWorkspaceDataProblems(nodes: unknown): string[] {
	if (!Array.isArray(nodes)) {
		return [];
	}
	return nodes.flatMap((node) => {
		const identity = dataNodeIdentity.safeParse(node);
		if (
			!identity.success ||
			WorkspaceDataNodeSchema.safeParse(node).success
		) {
			return [];
		}
		const name =
			typeof identity.data.id === "string"
				? identity.data.id
				: "Workspace data";
		return [
			`${name}: invalid Workspace data configuration (literal frame, collection and scope; writes require JSON text and expectedVersion)`,
		];
	});
}
