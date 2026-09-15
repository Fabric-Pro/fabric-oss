/**
 * Detect a Prisma unique-constraint violation (`P2002`) without depending on
 * the generated client class at runtime (keeps procedure tests mockable).
 *
 * Partial unique indexes created in raw migration SQL (plan §F2:
 * `coding_run_one_active_per_story`, `weave_execution_one_active_per_story`)
 * surface as `P2002` like any other unique index. When `indexName` is given
 * the match is narrowed to that index where Prisma reports it (`meta.target`
 * or the error message); if Prisma reports no target at all the code alone
 * decides, which is the fail-closed choice for a conflict check.
 */
export function isUniqueConstraintViolation(
	error: unknown,
	indexName?: string,
): boolean {
	if (!error || typeof error !== "object") {
		return false;
	}
	const record = error as {
		code?: unknown;
		meta?: { target?: unknown };
		message?: unknown;
	};
	if (record.code !== "P2002") {
		return false;
	}
	if (!indexName) {
		return true;
	}
	const target = record.meta?.target;
	if (typeof target === "string") {
		return target.includes(indexName);
	}
	if (Array.isArray(target)) {
		return target.some(
			(t) => typeof t === "string" && t.includes(indexName),
		);
	}
	if (
		typeof record.message === "string" &&
		record.message.includes(indexName)
	) {
		return true;
	}
	// No target reported: rely on the code alone.
	return target === undefined || target === null;
}
