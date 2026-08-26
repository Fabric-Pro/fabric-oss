/**
 * The `activateNotificationLifecycle` half of `persistCycleTerminal`'s input
 * (Publishing Suite 1C-2b, Fizzy #1850), built so the field is PRESENT ONLY when
 * the `publishing-1c-notify-v1` patch gate is on.
 *
 * Two facts make omission strictly safer than an explicit `false`:
 *
 *   1. `persistCycleTerminal` reads the field with `input.activateNotification-
 *      Lifecycle === true`, so `false` and absent are behaviourally identical —
 *      omitting it changes nothing an operator or a row could observe.
 *   2. The revision that recorded the pre-1C histories did not pass the field at
 *      all. On replay of one of those histories `patched()` returns false, and
 *      passing `false` would hand the already-recorded `persistCycleTerminal`
 *      command an input payload that differs — byte for byte — from the one the
 *      history holds.
 *
 * Whether the TypeScript SDK compares activity INPUT payloads when it detects
 * nondeterminism, or only command type and sequence, is genuinely disputed. This
 * function exists so the workflow does not have to depend on the answer: with the
 * key omitted the two payloads are identical, and the question stops mattering.
 *
 * A local, import-free pure module for the same reason
 * `publishing-suggestion-pr-authors.ts` is one: sandbox-safe and deterministic,
 * so it is importable into the workflow, and directly unit-testable — which is
 * the only way the OFF branch can be asserted at all. Every execution in the
 * workflow harness is fresh, so `patched()` is true in all of them.
 */
export function notificationActivationInput(enabled: boolean): {
	activateNotificationLifecycle?: true;
} {
	// A conditional SPREAD, not a conditional value: `{ activateNotification-
	// Lifecycle: enabled ? true : undefined }` still puts the key on the object.
	return enabled ? { activateNotificationLifecycle: true } : {};
}
