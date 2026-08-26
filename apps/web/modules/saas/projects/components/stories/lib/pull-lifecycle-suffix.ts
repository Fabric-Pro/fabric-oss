/**
 * Toast suffix for a Pull-from-PM lifecycle outcome.
 *
 * Maps the reconcile result `action` value returned by
 * `reconcileStoryTerminalStatus` (in `@repo/temporal`) to the short suffix
 * appended after "<Story> pulled from <PM tool>" in the success toast.
 *
 * Source of truth for the action enum:
 * `packages/temporal/src/activities/pm-integration/reconcile-story-terminal-status.ts`
 * (`ReconcileStoryTerminalResult.action`):
 * `"checkmark-only" | "auto-hidden" | "auto-unhid" | "unhide-proposed" |
 *  "already-applied" | "non-terminal-passthrough"`.
 *
 * Pure function. Never throws. Unknown / undefined actions (and the
 * intentionally silent `already-applied` / `non-terminal-passthrough` cases)
 * return an empty string so the base toast renders unchanged.
 */

const PULL_LIFECYCLE_SUFFIX: Record<string, string> = {
	"auto-hidden": " • marked done & hidden",
	"auto-unhid": " • restored",
	"unhide-proposed": " • unhide suggested in Review Center",
	"checkmark-only": " • marked done",
};

/**
 * Map a Pull reconcile `action` to its toast suffix. Returns `""` for
 * `already-applied`, `non-terminal-passthrough`, unknown values, and
 * `undefined` so the function is always safe to interpolate into the toast.
 */
export function pullLifecycleSuffix(
	lifecycleAction: string | undefined,
): string {
	if (!lifecycleAction) {
		return "";
	}
	return PULL_LIFECYCLE_SUFFIX[lifecycleAction] ?? "";
}
