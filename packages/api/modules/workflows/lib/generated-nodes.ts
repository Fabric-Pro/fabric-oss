/** Preserve the model's data while accepting its common flat-node shorthand. */
export function normalizeGeneratedNodes(nodes: unknown[] | undefined) {
	return nodes?.map((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return value;
		}
		const node = value as Record<string, unknown>;
		if (node.data !== undefined || typeof node.label !== "string") {
			return value;
		}
		const { label, config, ...rest } = node;
		return {
			...rest,
			data: { label, ...(config !== undefined ? { config } : {}) },
		};
	});
}
