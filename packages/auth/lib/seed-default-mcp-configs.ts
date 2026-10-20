type SeedDefaultMcpConfigsForTenant =
	typeof import("@repo/agent-core/services/seed-default-mcp-configs").seedDefaultMcpConfigsForTenant;

export const seedDefaultMcpConfigsForTenant: SeedDefaultMcpConfigsForTenant =
	async (params) => {
		const { seedDefaultMcpConfigsForTenant } = await import(
			"@repo/agent-core/services/seed-default-mcp-configs"
		);
		return seedDefaultMcpConfigsForTenant(params);
	};
