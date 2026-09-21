/**
 * A select-honouring, where-evaluating Prisma stand-in for the status-sync
 * decision tests (Fizzy #2304, spec §6 rule 1).
 *
 * Copied from the reads-only fake in
 * `src/activities/publishing-shared/__tests__/contributor-names.test.ts`
 * (lines 50-174: the operator helpers, `matchesWhere`, `applySelect` and the
 * table factory) and extended for the status-sync compare-and-set:
 * - reads honour a plain `orderBy` (`{ field: "asc" | "desc" }`, or an array
 *   of them), so "append to the end of the column" is computed, not canned;
 * - `updateMany` applies `data` only to the rows its `where` matches and
 *   returns Prisma's `{ count }`, so a story that changed between the read and
 *   the write yields count 0 — the `raced` outcome — for real.
 *
 * Loud by design: an operator, `orderBy` shape or update operation this fake
 * does not model throws instead of matching everything, and a selected field
 * or a written column missing from a fixture row is a fixture defect. A read
 * that stops selecting a field the decision needs therefore shows up as a
 * failing assertion, not as a silently narrower row.
 */

export type Row = Record<string, unknown>;

export interface RecordedCall {
	table: string;
	method: string;
	args: Record<string, unknown>;
}

function equals(value: unknown, operand: unknown): boolean {
	if (value instanceof Date && operand instanceof Date) {
		return value.getTime() === operand.getTime();
	}
	return value === operand;
}

function matchesCondition(value: unknown, condition: unknown): boolean {
	if (
		condition === null ||
		condition instanceof Date ||
		typeof condition === "string" ||
		typeof condition === "number" ||
		typeof condition === "boolean"
	) {
		return equals(value, condition);
	}
	if (typeof condition !== "object") {
		throw new Error(`fake db: unsupported condition ${String(condition)}`);
	}
	return Object.entries(condition as Record<string, unknown>).every(
		([operator, operand]) => {
			switch (operator) {
				case "in":
					if (!Array.isArray(operand)) {
						throw new Error("fake db: `in` needs an array");
					}
					return operand.some((o) => equals(value, o));
				case "not":
					return !matchesCondition(value, operand);
				case "gt":
					return (
						value instanceof Date &&
						operand instanceof Date &&
						value.getTime() > operand.getTime()
					);
				case "lt":
					return (
						value instanceof Date &&
						operand instanceof Date &&
						value.getTime() < operand.getTime()
					);
				default:
					throw new Error(
						`fake db: unsupported operator "${operator}"`,
					);
			}
		},
	);
}

function matchesWhere(row: Row, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, condition]) => {
		if (key === "OR") {
			if (!Array.isArray(condition)) {
				throw new Error("fake db: `OR` needs an array");
			}
			return condition.some((clause) =>
				matchesWhere(row, clause as Record<string, unknown>),
			);
		}
		if (key === "AND") {
			if (!Array.isArray(condition)) {
				throw new Error("fake db: `AND` needs an array");
			}
			return condition.every((clause) =>
				matchesWhere(row, clause as Record<string, unknown>),
			);
		}
		// Prisma ignores an `undefined` where-condition, so the fake does too.
		if (condition === undefined) {
			return true;
		}
		if (!(key in row)) {
			throw new Error(`fake db: fixture row has no field "${key}"`);
		}
		return matchesCondition(row[key], condition);
	});
}

/**
 * Projects a row down to the fields a `select` named, the way Prisma would:
 * only keys selected as exactly `true` are copied (a nested relation select is
 * not modelled and is left out). A selected scalar missing from the fixture is
 * a fixture defect, so the fake throws instead of guessing.
 */
function applySelect(row: Row, select: Record<string, unknown>): Row {
	const projected: Row = {};
	for (const [key, wanted] of Object.entries(select)) {
		if (wanted !== true) {
			continue;
		}
		if (!(key in row)) {
			throw new Error(`fake db: fixture row has no field "${key}"`);
		}
		projected[key] = row[key];
	}
	return projected;
}

function sortValue(row: Row, field: string): number | string {
	if (!(field in row)) {
		throw new Error(`fake db: fixture row has no field "${field}"`);
	}
	const value = row[field];
	if (value instanceof Date) {
		return value.getTime();
	}
	if (typeof value === "number" || typeof value === "string") {
		return value;
	}
	// Postgres NULLS ordering is not modelled — a fixture needing it is a gap.
	throw new Error(
		`fake db: orderBy over ${String(value)} in "${field}" is not modelled`,
	);
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
	if (orderBy === undefined) {
		return rows;
	}
	const clauses = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap(
		(clause) => Object.entries(clause as Record<string, unknown>),
	);
	for (const [field, direction] of clauses) {
		if (direction !== "asc" && direction !== "desc") {
			throw new Error(
				`fake db: unsupported orderBy on "${field}": ${JSON.stringify(direction)}`,
			);
		}
	}
	return [...rows].sort((a, b) => {
		for (const [field, direction] of clauses) {
			const av = sortValue(a, field);
			const bv = sortValue(b, field);
			if (av !== bv) {
				const ascending = av < bv ? -1 : 1;
				return direction === "asc" ? ascending : -ascending;
			}
		}
		return 0;
	});
}

function applyData(row: Row, data: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(data)) {
		if (!(key in row)) {
			throw new Error(
				`fake db: fixture row has no column "${key}" to write`,
			);
		}
		if (
			value !== null &&
			typeof value === "object" &&
			!(value instanceof Date)
		) {
			throw new Error(
				`fake db: unsupported update operation on "${key}"`,
			);
		}
		row[key] = value;
	}
}

/**
 * One fake Prisma table over `rows()` (read lazily, so a test can replace the
 * fixture array between cases). Every call is appended to `calls` with its
 * arguments, for exact `toEqual` assertions on `where` / `data`.
 */
export function createFakeTable(
	name: string,
	rows: () => Row[],
	calls: RecordedCall[],
) {
	const read = (args: Record<string, unknown>, method: string): Row[] => {
		calls.push({ table: name, method, args });
		const where = (args.where ?? {}) as Record<string, unknown>;
		const matched = sortRows(
			rows().filter((row) => matchesWhere(row, where)),
			args.orderBy,
		);
		const fields = args.select as Record<string, unknown> | undefined;
		return matched.map((row) =>
			fields ? applySelect(row, fields) : { ...row },
		);
	};
	return {
		findUnique: async (args: Record<string, unknown>) =>
			read(args, "findUnique")[0] ?? null,
		findFirst: async (args: Record<string, unknown>) =>
			read(args, "findFirst")[0] ?? null,
		findMany: async (args: Record<string, unknown>) =>
			read(args, "findMany"),
		updateMany: async (args: Record<string, unknown>) => {
			calls.push({ table: name, method: "updateMany", args });
			const where = (args.where ?? {}) as Record<string, unknown>;
			const data = (args.data ?? {}) as Record<string, unknown>;
			const matched = rows().filter((row) => matchesWhere(row, where));
			for (const row of matched) {
				applyData(row, data);
			}
			return { count: matched.length };
		},
	};
}
