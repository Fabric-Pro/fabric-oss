type SeedDefaultMcpConfigsForTenant =
	typeof import("@repo/agent-core/backend").seedDefaultMcpConfigsForTenant;

export const seedDefaultMcpConfigsForTenant: SeedDefaultMcpConfigsForTenant =
	async (params) => {
		const { seedDefaultMcpConfigsForTenant } = await import(
			"@repo/agent-core/backend"
		);
		return seedDefaultMcpConfigsForTenant(params);
	};
