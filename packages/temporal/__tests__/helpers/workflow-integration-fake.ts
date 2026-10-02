/**
 * In-memory stand-in for `db.workflowIntegration` reads, so a test can seed
 * several members' connections in one organization and let the code under
 * test pick from them with Prisma-like `where` semantics instead of a mock
 * that returns whatever the test pre-decided.
 *
 * Supported `where` shapes are the ones the credential lookups use: scalar
 * equality (including `null`), `{ in: [...] }`, and `NOT: { name: ... }`.
 * Anything else throws, so a lookup that grows a new operator fails loudly
 * here rather than matching every row. Like Prisma, a key whose value is
 * `undefined` is ignored — so a lookup that passes `userId: undefined`
 * matches every member's row here exactly as it would in production.
 */

export interface FakeWorkflowIntegrationRow {
	id: string;
	userId: string;
	organizationId: string | null;
	provider: string;
	name: string;
	credentials: string;
	isActive: boolean;
	settings?: unknown;
}

function matchesValue(actual: unknown, expected: unknown): boolean {
	if (expected === null || typeof expected !== "object") {
		return actual === expected;
	}
	const operators = expected as Record<string, unknown>;
	const keys = Object.keys(operators);
	if (keys.length === 1 && Array.isArray(operators.in)) {
		return operators.in.includes(actual);
	}
	throw new Error(
		`workflow-integration-fake: unsupported operator ${JSON.stringify(expected)}`,
	);
}

function matchesWhere(
	row: FakeWorkflowIntegrationRow,
	where: Record<string, unknown> = {},
): boolean {
	for (const [key, expected] of Object.entries(where)) {
		// Prisma drops a condition whose value is `undefined`.
		if (expected === undefined) {
			continue;
		}
		if (key === "NOT") {
			const not = expected as Record<string, unknown>;
			if (matchesWhere(row, not)) {
				return false;
			}
			continue;
		}
		if (key === "OR" || key === "AND") {
			throw new Error(
				`workflow-integration-fake: unsupported combinator ${key}`,
			);
		}
		const actual = (row as unknown as Record<string, unknown>)[key];
		if (!matchesValue(actual, expected)) {
			return false;
		}
	}
	return true;
}

export function createWorkflowIntegrationFake(
	rows: FakeWorkflowIntegrationRow[],
) {
	return {
		findFirst: async (args?: { where?: Record<string, unknown> }) =>
			rows.find((row) => matchesWhere(row, args?.where)) ?? null,
		findMany: async (args?: { where?: Record<string, unknown> }) =>
			rows.filter((row) => matchesWhere(row, args?.where)),
	};
}

/** One active connection row; `credentials` stays plaintext for the fake. */
export function connectionRow(
	overrides: Partial<FakeWorkflowIntegrationRow> &
		Pick<FakeWorkflowIntegrationRow, "id" | "userId" | "provider">,
): FakeWorkflowIntegrationRow {
	return {
		organizationId: "org-example",
		name: overrides.provider,
		credentials: JSON.stringify({ access_token: `${overrides.id}-token` }),
		isActive: true,
		...overrides,
	};
}
