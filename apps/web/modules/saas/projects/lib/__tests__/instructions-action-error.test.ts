import { describe, expect, it } from "vitest";
import {
	instructionActionErrorKey,
	migrationOpenRefusal,
	publishedChanged,
} from "../instructions-action-error";

describe("migrationOpenRefusal", () => {
	function frozen(data: Record<string, unknown>) {
		return {
			code: "CONFLICT",
			data: { reason: "MIGRATION_OPEN", ...data },
			message: "TEXT THAT MUST NOT BE SHOWN",
		};
	}

	it("reads the pull request a paused change is waiting on", () => {
		expect(
			migrationOpenRefusal(
				frozen({
					state: "PROPOSING",
					pullRequest: {
						url: "https://example.com/pr/12",
						externalId: "12",
					},
				}),
			),
		).toEqual({ state: "proposing", pullRequest: "12" });
	});

	it("says the move is still being prepared when no pull request is open yet", () => {
		expect(
			migrationOpenRefusal(
				frozen({ state: "PROPOSING", pullRequest: null }),
			),
		).toEqual({ state: "proposing", pullRequest: null });
	});

	it("tells a merged move that is switching apart from one awaiting its merge", () => {
		expect(
			migrationOpenRefusal(
				frozen({
					state: "SWITCHING",
					pullRequest: {
						url: "https://example.com/pr/12",
						externalId: "12",
					},
				}),
			),
		).toEqual({ state: "switching", pullRequest: "12" });
	});

	it("reads an unfamiliar state as the open one rather than guessing", () => {
		expect(
			migrationOpenRefusal(frozen({ state: "SOMETHING_NEW" })),
		).toEqual({
			state: "proposing",
			pullRequest: null,
		});
	});

	it.each([
		[
			"another conflict",
			{ code: "CONFLICT", data: { reason: "PUBLISHED_CHANGED" } },
		],
		[
			"a different code",
			{ code: "FORBIDDEN", data: { reason: "MIGRATION_OPEN" } },
		],
		["no data", { code: "CONFLICT" }],
		["a plain Error", new Error("boom")],
		["null", null],
	])("is null for %s", (_label, error) => {
		expect(migrationOpenRefusal(error)).toBeNull();
	});

	it("never takes a pull request that is not a string for a number", () => {
		expect(
			migrationOpenRefusal(
				frozen({ state: "PROPOSING", pullRequest: { externalId: 12 } }),
			),
		).toEqual({ state: "proposing", pullRequest: null });
	});
});

describe("instructionActionErrorKey", () => {
	it.each([
		["UNAUTHORIZED", "forbidden"],
		["FORBIDDEN", "forbidden"],
		["NOT_FOUND", "notFound"],
		["CONFLICT", "conflict"],
		["BAD_REQUEST", "badRequest"],
		["PRECONDITION_FAILED", "preconditionFailed"],
		["TOO_MANY_REQUESTS", "tooManyRequests"],
	] as const)("words an error coded %s as %s", (code, key) => {
		expect(instructionActionErrorKey({ code })).toBe(key);
	});

	// A project in Read-only mode refuses every write to its connected sources.
	// It arrives as a CONFLICT, which alone would read as "this changed while
	// you were working": the typed errorCode is what says what it is.
	it("words a write refused by Read-only mode as that, not as a conflict", () => {
		expect(
			instructionActionErrorKey({
				code: "CONFLICT",
				data: { errorCode: "PROJECT_READ_ONLY" },
				message: "TEXT THAT MUST NOT BE SHOWN",
			}),
		).toBe("readOnlyMode");
		expect(
			instructionActionErrorKey({
				code: "CONFLICT",
				data: { errorCode: "SOMETHING_ELSE" },
			}),
		).toBe("conflict");
	});

	// A publish or approval whose move ended while it was being decided: nothing
	// is open any more, and the honest answer is to look again.
	it("words a publish whose move just ended as a change to refresh, not as a move", () => {
		expect(
			instructionActionErrorKey({
				code: "CONFLICT",
				data: { reason: "MIGRATION_CHANGED" },
			}),
		).toBe("conflict");
	});

	it("reads the code off an Error that carries one", () => {
		const error = Object.assign(new Error("A provider said something"), {
			code: "CONFLICT",
		});

		expect(instructionActionErrorKey(error)).toBe("conflict");
	});

	it("falls back to the generic line for an unknown code, never the server's message", () => {
		expect(
			instructionActionErrorKey(
				Object.assign(new Error("Internal detail"), {
					code: "INTERNAL_SERVER_ERROR",
				}),
			),
		).toBe("generic");
	});

	it.each([
		["a plain Error", new Error("boom")],
		["a string", "boom"],
		["null", null],
		["undefined", undefined],
		["a non-string code", { code: 500 }],
	])("falls back to the generic line for %s", (_label, error) => {
		expect(instructionActionErrorKey(error)).toBe("generic");
	});

	it("does not take a name on the Object prototype for a code", () => {
		expect(instructionActionErrorKey({ code: "constructor" })).toBe(
			"generic",
		);
	});
});

describe("publishedChanged", () => {
	it("reads the version a stale publish ran into", () => {
		expect(
			publishedChanged({
				code: "CONFLICT",
				data: { reason: "PUBLISHED_CHANGED", publishedVersion: 9 },
			}),
		).toEqual({ publishedVersion: 9 });
	});

	it("reads nothing published as null", () => {
		expect(
			publishedChanged({
				code: "CONFLICT",
				data: { reason: "PUBLISHED_CHANGED", publishedVersion: null },
			}),
		).toEqual({ publishedVersion: null });
	});

	it("is not triggered by any other conflict or error", () => {
		expect(publishedChanged({ code: "CONFLICT" })).toBeNull();
		expect(
			publishedChanged({
				code: "CONFLICT",
				data: { reason: "PULL_REQUEST_UNRESOLVED" },
			}),
		).toBeNull();
		expect(
			publishedChanged({
				code: "FORBIDDEN",
				data: { reason: "PUBLISHED_CHANGED" },
			}),
		).toBeNull();
		expect(publishedChanged(new Error("boom"))).toBeNull();
		expect(publishedChanged(null)).toBeNull();
	});
});
