import { ExecuteCodeRequestSchema } from "@repo/sandbox/dynamic-worker";
import { z } from "zod";
import { SCRIPT_TRANSFORM_NODE_TYPE } from "./workflow-node-types";

const InputKeysSchema = z.preprocess(
	(value) => {
		if (value === "") {
			return undefined;
		}
		if (typeof value === "string" && value.length <= 16384) {
			try {
				return JSON.parse(value);
			} catch {
				return value;
			}
		}
		return value;
	},
	z
		.array(
			z
				.string()
				.min(1)
				.max(256)
				.refine((key) => key.trim().length > 0),
		)
		.min(1)
		.max(32)
		.refine(
			(keys) => new Set(keys).size === keys.length,
			"Input keys must be unique",
		)
		.optional(),
);

/** The function body receives `inputs` and execution metadata, returning JSON. */
export const WorkspaceScriptConfigSchema = ExecuteCodeRequestSchema.omit({
	inputs: true,
	execution: true,
}).extend({
	inputKeys: InputKeysSchema,
	timeout: ExecuteCodeRequestSchema.shape.timeout
		.unwrap()
		.max(10000)
		.default(5000),
});

const ScriptNodeIdentitySchema = z.looseObject({
	id: z.unknown().optional(),
	type: z.literal(SCRIPT_TRANSFORM_NODE_TYPE),
});

const ScriptNodeSchema = ScriptNodeIdentitySchema.extend({
	id: z.string().optional(),
	data: z.looseObject({ config: WorkspaceScriptConfigSchema }),
});

export function readPublishedScriptConfig(nodes: unknown, nodeId: string) {
	const node = Array.isArray(nodes)
		? nodes.find((value) => {
				const parsed = ScriptNodeIdentitySchema.safeParse(value);
				return parsed.success && parsed.data.id === nodeId;
			})
		: undefined;
	return ScriptNodeSchema.parse(node).data.config;
}

export function workflowScriptProblems(nodes: unknown): string[] {
	if (!Array.isArray(nodes)) {
		return [];
	}
	return nodes.flatMap((node) => {
		const parsed = ScriptNodeIdentitySchema.safeParse(node);
		if (!parsed.success) {
			return [];
		}
		const config = ScriptNodeSchema.safeParse(node);
		const name =
			typeof parsed.data.id === "string"
				? parsed.data.id
				: "Script Transform";
		return config.success
			? []
			: [
					`${name}: invalid script configuration (JavaScript/TypeScript, 32 KiB source, 1–10 second response deadline)`,
				];
	});
}
