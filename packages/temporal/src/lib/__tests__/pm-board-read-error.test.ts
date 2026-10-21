import { describe, expect, it } from "vitest";
import { pmBoardContextNote, pmBoardReadError } from "../pm-board-read-error";

describe("PM board credentials classification", () => {
	it.each([
		"Authority check failed: connection reset",
		"Runtime authority required",
		"board 14031 timed out after 40300ms",
	])("keeps a generic note for %s", (message) => {
		expect(
			pmBoardContextNote("fizzy", pmBoardReadError(new Error(message))),
		).toContain("Couldn't read your Fizzy board");
	});
	it.each([
		"Authentication failed: HTTP Token: Access denied",
		"HTTP 401",
		"HTTP 403",
		"auth failed",
		"authorization failed",
		"oauth failed",
		"unauthorized",
		"unauthorised",
		"forbidden",
		"credentials were refused",
		"credential refused",
		"invalid api key",
		"invalid token",
	])("classifies %s as credentials", (message) => {
		expect(pmBoardReadError(new Error(message))).toBe("credentials");
	});
	it("takes an error kind without re-classifying it", () => {
		expect(pmBoardContextNote("fizzy", "credentials")).toContain(
			"credentials were refused",
		);
	});
	it.each(["circular", "bigint"])(
		"does not throw for %s error output",
		(kind) => {
			const output: Record<string, unknown> = {};
			output.value = kind === "circular" ? output : 1n;
			expect(pmBoardReadError({ output })).toBe("other");
		},
	);
});
