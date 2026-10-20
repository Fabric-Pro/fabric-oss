export function orchestratorMemoryMetadata(context: {
	userId: string;
	organizationId?: string;
}): Record<string, unknown> {
	return {
		type: "orchestrator-memory",
		identityType: context.organizationId ? "org" : "user",
		identifierKey: context.organizationId || context.userId,
		...(context.organizationId
			? { organizationId: context.organizationId }
			: { userId: context.userId, organizationId: null }),
	};
}

export function matchesAgentMetadata(
	actual: Record<string, unknown> | undefined,
	expected: Record<string, unknown>,
): boolean {
	return (
		actual != null &&
		Object.entries(expected).every(([key, value]) =>
			value === null
				? actual[key] === null || actual[key] === undefined
				: actual[key] === value,
		)
	);
}
