import { describe, expect, it } from "vitest";
import {
	pendingProjectOnNewChat,
	pendingProjectOnOpen,
} from "../pending-project";

describe("pending project across conversations (#2040)", () => {
	it("restores the opened conversation's project", () => {
		expect(
			pendingProjectOnOpen({ pending: null, restored: null }, "p_a"),
		).toEqual({ pending: "p_a", restored: "p_a" });
	});

	it("drops a restored project when the next conversation has none (A → B)", () => {
		const afterA = pendingProjectOnOpen(
			{ pending: null, restored: null },
			"p_a",
		);
		expect(pendingProjectOnOpen(afterA, null)).toEqual({
			pending: null,
			restored: null,
		});
	});

	it("returns a restored project to the page default on New (A → New)", () => {
		const afterA = pendingProjectOnOpen(
			{ pending: null, restored: null },
			"p_a",
		);
		expect(pendingProjectOnNewChat(afterA, "p_default")).toEqual({
			pending: "p_default",
			restored: null,
		});
	});

	it("keeps a project the user picked, on open and on New", () => {
		const picked = { pending: "p_mine", restored: null };
		expect(pendingProjectOnOpen(picked, null)).toEqual(picked);
		expect(pendingProjectOnNewChat(picked, null)).toEqual(picked);
	});

	it("does not claim the user's own pick when their new chat stores it", () => {
		const picked = { pending: "p_mine", restored: null };
		const afterCreate = pendingProjectOnOpen(picked, "p_mine");
		expect(afterCreate).toEqual(picked);
		expect(pendingProjectOnNewChat(afterCreate, null)).toEqual(picked);
	});

	it("leaves a removed project removed", () => {
		const removed = { pending: null, restored: "p_a" };
		expect(pendingProjectOnOpen(removed, null)).toEqual(removed);
		expect(pendingProjectOnNewChat(removed, "p_default")).toEqual(removed);
	});
});
