import { describe, expect, it } from "vitest";
import {
	instructionActionErrorKey,
	publishedChanged,
} from "../instructions-action-error";

describe("instructionActionErrorKey", () => {
	it.each([
		["UNAUTHORIZED", "forbidden"],
		["FORBIDDEN", "forbidden"],
		["NOT_FOUND", "notFound"],
		["CONFLICT", "conflict"],
		["TOO_MANY_REQUESTS", "tooManyRequests"],
	] as const)("words an error coded %s as %s", (code, key) => {
		expect(instructionActionErrorKey({ code })).toBe(key);
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
