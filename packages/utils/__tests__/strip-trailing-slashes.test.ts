import { expect, it } from "vitest";
import { stripTrailingSlashes } from "../strip-trailing-slashes";

it("removes only trailing separators in linear time", () => {
	for (const value of [
		"",
		"/",
		"///",
		"https://example.com/v1///",
		"a/b",
		"a/\n",
	]) {
		expect(stripTrailingSlashes(value)).toBe(value.replace(/\/+$/, ""));
	}
	const input = `${"/".repeat(50_000)}x`;
	const start = performance.now();
	expect(stripTrailingSlashes(input)).toBe(input);
	expect(performance.now() - start).toBeLessThan(250);
});
