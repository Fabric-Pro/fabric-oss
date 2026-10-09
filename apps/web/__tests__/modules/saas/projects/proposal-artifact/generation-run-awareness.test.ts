/**
 * Which open editor writes a regenerated body into a shared collaborative
 * document (Fizzy #2801).
 *
 * Every editor attached to a run it did not start takes the regenerated body
 * when the run completes. Under collaboration they share one Yjs document,
 * and two editors setting the body at once each insert it, so the shared
 * document ends up holding it twice. Each editor therefore says in its
 * awareness state whether it started the run or is attached to one, and
 * exactly one writes:
 *
 * - the editor that started the run, which writes it through its own review,
 *   so no attached editor writes while it is present;
 * - otherwise the attached editor with the smallest awareness client id.
 *
 * Without an awareness there is nothing shared to duplicate into, and every
 * editor takes the body itself.
 */

import {
	appliesAttachedRunBody,
	GENERATION_RUN_AWARENESS_FIELD,
	type GenerationRunRole,
	publishGenerationRunRole,
} from "@saas/projects/components/proposal-artifact/generation-run-awareness";
import { describe, expect, it, vi } from "vitest";

/**
 * An awareness as y-protocols keeps it: one state per client id. `ownRole`
 * "absent" leaves out this editor's own state, as before it reaches the room.
 */
function fakeAwareness(
	clientID: number,
	others: Record<number, GenerationRunRole | null> = {},
	ownRole: GenerationRunRole | null | "absent" = "attached",
) {
	const states = new Map<number, Record<string, unknown>>();
	for (const [id, role] of Object.entries(others)) {
		states.set(Number(id), {
			user: { name: `Reader ${id}` },
			...(role ? { [GENERATION_RUN_AWARENESS_FIELD]: role } : {}),
		});
	}
	if (ownRole !== "absent") {
		states.set(clientID, {
			user: { name: "Me" },
			[GENERATION_RUN_AWARENESS_FIELD]: ownRole,
		});
	}
	return {
		clientID,
		getStates: () => states,
		getLocalState: () => states.get(clientID) ?? null,
		setLocalStateField: vi.fn((field: string, value: unknown) => {
			states.set(clientID, {
				...(states.get(clientID) ?? {}),
				[field]: value,
			});
		}),
	};
}

describe("appliesAttachedRunBody", () => {
	it("applies without an awareness: no shared document to duplicate into", () => {
		expect(appliesAttachedRunBody(null)).toBe(true);
		expect(appliesAttachedRunBody(undefined)).toBe(true);
	});

	it("applies when it is the only attached editor", () => {
		expect(appliesAttachedRunBody(fakeAwareness(7))).toBe(true);
	});

	it("leaves the body to an attached editor with a smaller client id", () => {
		expect(
			appliesAttachedRunBody(fakeAwareness(7, { 3: "attached" })),
		).toBe(false);
	});

	it("applies when every other attached editor has a larger client id", () => {
		expect(
			appliesAttachedRunBody(
				fakeAwareness(3, { 7: "attached", 11: "attached" }),
			),
		).toBe(true);
	});

	it("is elected by the attached editors only: a reader that is not attached does not count", () => {
		expect(appliesAttachedRunBody(fakeAwareness(7, { 3: null }))).toBe(
			true,
		);
	});

	it("leaves the body to the editor that started the run, whatever the client ids", () => {
		expect(appliesAttachedRunBody(fakeAwareness(3, { 7: "started" }))).toBe(
			false,
		);
	});

	it("counts itself before its own state has gone out", () => {
		expect(
			appliesAttachedRunBody(
				fakeAwareness(3, { 7: "attached" }, "absent"),
			),
		).toBe(true);
		expect(
			appliesAttachedRunBody(
				fakeAwareness(7, { 3: "attached" }, "absent"),
			),
		).toBe(false);
	});
});

describe("publishGenerationRunRole", () => {
	it("publishes the role in the editor's awareness state, then clears it", () => {
		const awareness = fakeAwareness(7, {}, null);

		publishGenerationRunRole(awareness, "attached");
		expect(awareness.getLocalState()).toMatchObject({
			[GENERATION_RUN_AWARENESS_FIELD]: "attached",
		});

		publishGenerationRunRole(awareness, null);
		expect(
			awareness.getLocalState()?.[GENERATION_RUN_AWARENESS_FIELD],
		).toBeNull();
		expect(awareness.setLocalStateField).toHaveBeenCalledTimes(2);
	});

	it("does not send the role again when it has not changed", () => {
		const awareness = fakeAwareness(7, {}, "started");

		publishGenerationRunRole(awareness, "started");

		expect(awareness.setLocalStateField).not.toHaveBeenCalled();
	});

	it("sends nothing to clear a role that was never published", () => {
		const awareness = fakeAwareness(7, {}, "absent");

		publishGenerationRunRole(awareness, null);

		expect(awareness.setLocalStateField).not.toHaveBeenCalled();
	});

	it("does nothing without an awareness", () => {
		expect(() => publishGenerationRunRole(null, "attached")).not.toThrow();
		expect(() =>
			publishGenerationRunRole(undefined, "attached"),
		).not.toThrow();
	});
});
