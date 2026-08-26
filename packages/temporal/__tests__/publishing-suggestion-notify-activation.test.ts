import { describe, expect, it } from "vitest";
import { notificationActivationInput } from "../src/workflows/publishing-suggestion-notify-activation";

/**
 * The OFF branch is unreachable from the workflow harness — every execution in
 * `src/workflows/__tests__/publishing-suggestion-workflow.test.ts` is fresh, so
 * `patched("publishing-1c-notify-v1")` is always true there. This file is the
 * only place the off branch can be asserted at all, which is why the expression
 * lives in a pure module rather than inline at the call site.
 *
 * The property under test is about the KEY, not the value: an old history's
 * recorded `persistCycleTerminal` input carries no `activateNotificationLifecycle`
 * at all, so an explicit `false` would replay a different payload than the one
 * recorded even though `persistCycleTerminal` reads the field with `=== true`
 * and cannot tell them apart.
 */
describe("notificationActivationInput", () => {
	it("omits the key entirely when the patch gate is off", () => {
		const input = notificationActivationInput(false);

		// `toEqual({})` would pass for `{ activateNotificationLifecycle: undefined }`,
		// which still serializes the key. Assert on ownership and on the key set.
		expect(Object.hasOwn(input, "activateNotificationLifecycle")).toBe(
			false,
		);
		expect(Object.keys(input)).toEqual([]);
	});

	it("sets the key to true when the patch gate is on", () => {
		const input = notificationActivationInput(true);

		expect(Object.hasOwn(input, "activateNotificationLifecycle")).toBe(
			true,
		);
		expect(input.activateNotificationLifecycle).toBe(true);
	});

	it("spread into a persist input adds no key when the gate is off", () => {
		// The call site's shape, because spreading is where an `undefined`-valued
		// key would still land on the object.
		const persistInput = {
			cycleId: "cycle-1",
			kind: "SUGGESTIONS" as const,
			...notificationActivationInput(false),
		};

		expect(Object.keys(persistInput).sort()).toEqual(["cycleId", "kind"]);
		expect(
			Object.hasOwn(persistInput, "activateNotificationLifecycle"),
		).toBe(false);
	});
});
