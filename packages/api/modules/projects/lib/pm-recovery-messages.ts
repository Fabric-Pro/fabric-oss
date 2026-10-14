/**
 * The message for a recovery refused because the item's create claim is
 * too recent (`"pm-recovery-too-recent"`, or Link's `claim-too-recent`):
 * the time is rounded up to the minute, in UTC, so "after" is never early.
 */
export function pmRecoveryTooRecentMessage(
	recoverableAt: Date | null | undefined,
	toolLabel = "your PM tool",
): string {
	if (!recoverableAt) {
		return `A push may still be creating this item in ${toolLabel}. Try again in a few minutes.`;
	}
	const minute = 60_000;
	const rounded = new Date(
		Math.ceil(recoverableAt.getTime() / minute) * minute,
	);
	return `A push may still be creating this item in ${toolLabel}. Try again after ${rounded.toISOString().slice(11, 16)} UTC.`;
}
