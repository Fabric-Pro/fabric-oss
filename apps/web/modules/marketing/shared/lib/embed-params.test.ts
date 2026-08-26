import { describe, expect, it } from "vitest";
import { resolveEmbedParams } from "./embed-params";

describe("resolveEmbedParams", () => {
	it("defaults to light when theme is missing", () => {
		expect(resolveEmbedParams(undefined)).toEqual({ theme: "light" });
		expect(resolveEmbedParams({})).toEqual({ theme: "light" });
	});

	it("honors light and dark", () => {
		expect(resolveEmbedParams({ theme: "light" })).toEqual({
			theme: "light",
		});
		expect(resolveEmbedParams({ theme: "dark" })).toEqual({
			theme: "dark",
		});
	});

	it("falls back to light for unknown values", () => {
		expect(resolveEmbedParams({ theme: "neon" })).toEqual({
			theme: "light",
		});
	});

	it("uses the first value when theme is an array", () => {
		expect(resolveEmbedParams({ theme: ["dark", "light"] })).toEqual({
			theme: "dark",
		});
	});
});
