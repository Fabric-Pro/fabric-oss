/** Pure target validation shared with the disposable Prisma CLI helper. */
export function disposableTarget(
	mode: "reset" | "diff",
	env: { DIRECT_URL?: string; SHADOW_DATABASE_URL?: string },
): string;
