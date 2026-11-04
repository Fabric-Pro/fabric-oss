/** A stale receipt flag must never hide an execution's later terminal outcome. */
export function isTaskAdmissionUnresolved(
	status: string,
	state: unknown,
): boolean {
	if (
		status !== "PENDING" ||
		!state ||
		typeof state !== "object" ||
		Array.isArray(state)
	)
		return false;
	const admission = (state as Record<string, unknown>).admission;
	return (
		!!admission &&
		typeof admission === "object" &&
		!Array.isArray(admission) &&
		(admission as Record<string, unknown>).status === "UNRESOLVED"
	);
}
