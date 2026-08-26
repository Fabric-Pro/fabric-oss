import { describe, expect, it } from "vitest";
import {
	hashTerminalStatuses,
	resolveTerminalSet,
} from "../pm-terminal-config";

describe("resolveTerminalSet", () => {
	it("falls back to the built-in set when empty/null", () => {
		expect(resolveTerminalSet(null)).toEqual(["Closed", "Done", "Removed"]);
		expect(resolveTerminalSet([])).toEqual(["Closed", "Done", "Removed"]);
	});
	it("returns the configured set verbatim when non-empty", () => {
		expect(resolveTerminalSet(["Shipped"])).toEqual(["Shipped"]);
	});
});

describe("hashTerminalStatuses", () => {
	it("is order- and case-insensitive", () => {
		expect(hashTerminalStatuses(["Done", "Closed"])).toBe(
			hashTerminalStatuses(["closed", "done"]),
		);
	});
	it("distinguishes different sets", () => {
		expect(hashTerminalStatuses(["Done"])).not.toBe(
			hashTerminalStatuses(["Done", "Closed"]),
		);
	});
	it("does not collide on delimiter-bearing statuses (Codex round-3)", () => {
		// A delimiter join would map both of these to "a|b|c".
		expect(hashTerminalStatuses(["a|b", "c"])).not.toBe(
			hashTerminalStatuses(["a", "b|c"]),
		);
	});
});
