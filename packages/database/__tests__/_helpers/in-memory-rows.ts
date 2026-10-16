/**
 * A table of plain rows that answers the small slice of Prisma `where` and
 * `orderBy` the paging and ownership queries use: equality, `in`, `lt`, `gt`,
 * `contains` (insensitive), `OR` and `AND`. It exists so a test can drive a
 * query's real predicates over data and see which rows come back, instead of
 * asserting the shape of the arguments. It is not a Prisma stand-in: a
 * predicate it does not know throws, so a query that starts using one fails
 * loudly here rather than matching everything.
 */

export type Row = Record<string, unknown>;

function compare(a: unknown, b: unknown): number {
	const left = a instanceof Date ? a.getTime() : a;
	const right = b instanceof Date ? b.getTime() : b;
	if (left === right) {
		return 0;
	}
	return (left as number) < (right as number) ? -1 : 1;
}

function matchesField(actual: unknown, condition: unknown): boolean {
	if (
		condition !== null &&
		typeof condition === "object" &&
		!(condition instanceof Date)
	) {
		const operators = condition as Record<string, unknown>;
		return Object.entries(operators).every(([operator, expected]) => {
			switch (operator) {
				case "in":
					return (expected as unknown[]).includes(actual);
				case "gt":
					return compare(actual, expected) > 0;
				case "lt":
					return compare(actual, expected) < 0;
				case "contains":
					return (
						typeof actual === "string" &&
						actual
							.toLowerCase()
							.includes(String(expected).toLowerCase())
					);
				case "mode":
					return true;
				default:
					throw new Error(
						`in-memory rows: unsupported operator ${operator}`,
					);
			}
		});
	}
	return compare(actual, condition) === 0;
}

export function matchesWhere(row: Row, where: Row | undefined): boolean {
	if (!where) {
		return true;
	}
	return Object.entries(where).every(([field, condition]) => {
		if (condition === undefined) {
			return true;
		}
		if (field === "OR") {
			return (condition as Row[]).some((branch) =>
				matchesWhere(row, branch),
			);
		}
		if (field === "AND") {
			return (condition as Row[]).every((branch) =>
				matchesWhere(row, branch),
			);
		}
		return matchesField(row[field], condition);
	});
}

export function sortRows(
	rows: Row[],
	orderBy: Array<Record<string, "asc" | "desc">> | undefined,
): Row[] {
	if (!orderBy) {
		return rows;
	}
	return [...rows].sort((a, b) => {
		for (const term of orderBy) {
			for (const [field, direction] of Object.entries(term)) {
				const result = compare(a[field], b[field]);
				if (result !== 0) {
					return direction === "asc" ? result : -result;
				}
			}
		}
		return 0;
	});
}
