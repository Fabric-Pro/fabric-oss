/**
 * An in-memory `workflowIntegration` delegate for tests that need the real
 * `where` clauses applied to real rows. A `<PROVIDER>_OAUTH_APP` row and a
 * connection row share provider, user and organization, so whether a
 * selector picks the right one depends entirely on its clause; a mock that
 * returns a canned row cannot tell.
 *
 * Only the operators the integration handlers use are understood: scalar
 * equality (including `null`), `{ in: [...] }` and `NOT`. Anything else
 * throws, so a clause this matcher does not model fails the suite instead of
 * silently matching. Like Prisma, a key whose value is `undefined` is
 * ignored, so a clause that passes `userId: undefined` matches every
 * member's row here exactly as it would in production. `findFirst` returns the first match in insertion order,
 * so seeding the app row first makes a selector that does not exclude it find
 * it.
 */

export type StoredRow = {
	id: string;
	userId: string;
	organizationId: string | null;
	provider: string;
	name: string;
	isActive: boolean;
	credentials: string | null;
	settings?: unknown;
	lastUsedAt?: Date | null;
};

type Where = Record<string, unknown>;

function matchesField(value: unknown, condition: unknown, key: string) {
	if (condition === null || typeof condition !== "object") {
		return value === condition;
	}
	const keys = Object.keys(condition);
	if (keys.length === 1 && keys[0] === "in") {
		const allowed = (condition as { in: unknown }).in;
		if (!Array.isArray(allowed)) {
			throw new Error(
				`fake workflowIntegration: \`in\` on ${key} needs an array`,
			);
		}
		return allowed.includes(value);
	}
	throw new Error(
		`fake workflowIntegration: unsupported filter ${JSON.stringify(condition)} on ${key}`,
	);
}

function matchesWhere(row: StoredRow, where: Where): boolean {
	return Object.entries(where).every(([key, condition]) => {
		// Prisma drops a condition whose value is `undefined`.
		if (condition === undefined) {
			return true;
		}
		if (key === "NOT") {
			return !matchesWhere(row, condition as Where);
		}
		return matchesField(row[key as keyof StoredRow], condition, key);
	});
}

export function createWorkflowIntegrationStore() {
	const rows: StoredRow[] = [];
	let nextId = 1;

	const copy = (row: StoredRow) => ({ ...row });

	return {
		rows,
		reset() {
			rows.length = 0;
			nextId = 1;
		},
		row(id: string): StoredRow {
			const found = rows.find((candidate) => candidate.id === id);
			if (!found) {
				throw new Error(`row ${id} missing`);
			}
			return found;
		},
		delegate: {
			findFirst: async ({ where }: { where: Where }) => {
				const found = rows.find((row) => matchesWhere(row, where));
				return found ? copy(found) : null;
			},
			findMany: async ({ where }: { where: Where }) =>
				rows.filter((row) => matchesWhere(row, where)).map(copy),
			create: async ({ data }: { data: Partial<StoredRow> }) => {
				const created: StoredRow = {
					id: `created-${nextId++}`,
					userId: "",
					organizationId: null,
					provider: "",
					name: "",
					isActive: true,
					credentials: null,
					...data,
				};
				rows.push(created);
				return copy(created);
			},
			update: async ({
				where,
				data,
			}: {
				where: { id: string };
				data: Partial<StoredRow>;
			}) => {
				const target = rows.find((row) => row.id === where.id);
				if (!target) {
					throw new Error(`update: row ${where.id} missing`);
				}
				Object.assign(target, data);
				return copy(target);
			},
			deleteMany: async ({ where }: { where: Where }) => {
				const hit = rows.filter((row) => matchesWhere(row, where));
				for (const row of hit) {
					rows.splice(rows.indexOf(row), 1);
				}
				return { count: hit.length };
			},
			updateMany: async ({
				where,
				data,
			}: {
				where: Where;
				data: Partial<StoredRow>;
			}) => {
				const hit = rows.filter((row) => matchesWhere(row, where));
				for (const row of hit) {
					Object.assign(row, data);
				}
				return { count: hit.length };
			},
		},
	};
}
