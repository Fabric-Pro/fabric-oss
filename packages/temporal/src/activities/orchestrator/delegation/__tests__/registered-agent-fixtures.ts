export interface AgentRow {
	id: string;
	agentId: string;
	name: string;
	displayName: string;
	scope: string;
	userId: string | null;
	organizationId: string | null;
	status: string;
	createdAt: Date;
	deploymentUrl: string | null;
	lastHealthCheck: Date | null;
	metadata: Record<string, unknown> | null;
}

export function agentRow(overrides: Partial<AgentRow> = {}): AgentRow {
	return {
		id: "example-system-row",
		agentId: "example-system-agent",
		name: "example-generalist",
		displayName: "Example generalist",
		scope: "SYSTEM",
		userId: null,
		organizationId: null,
		status: "ACTIVE",
		createdAt: new Date("2026-01-01"),
		deploymentUrl: "https://agent.example.com",
		lastHealthCheck: null,
		metadata: { protocols: ["A2A"], tags: ["example-system-tag"] },
		...overrides,
	};
}

/** Evaluate the Prisma filters against synthetic rows without a database. */
export function matchesAgentWhere(
	row: AgentRow,
	where: Record<string, unknown>,
): boolean {
	return Object.entries(where).every(([key, value]) => {
		if (key === "AND" || key === "OR") {
			const conditions = value as Record<string, unknown>[];
			const matches = (condition: Record<string, unknown>) =>
				matchesAgentWhere(row, condition);
			return key === "AND"
				? conditions.every(matches)
				: conditions.some(matches);
		}
		const actual = row[key as keyof AgentRow];
		if (value && typeof value === "object" && "equals" in value) {
			return "mode" in value && value.mode === "insensitive"
				? String(actual).toLowerCase() ===
						String(value.equals).toLowerCase()
				: actual === value.equals;
		}
		if (value && typeof value === "object" && "contains" in value) {
			return String(actual)
				.toLowerCase()
				.includes(String(value.contains).toLowerCase());
		}
		return actual === value;
	});
}
