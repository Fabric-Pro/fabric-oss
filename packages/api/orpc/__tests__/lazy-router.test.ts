import { isLazy, isProcedure, unlazyRouter } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { router } from "../router";

describe("router", () => {
	it("mounts every module router lazily, so a request only evaluates its own module", () => {
		// Arrange
		const entries = Object.entries(router);

		// Act
		const eager = entries.filter(([, value]) => !isLazy(value));

		// Assert
		expect(entries.length).toBeGreaterThan(40);
		expect(eager.map(([key]) => key)).toEqual([]);
	});

	it("resolves every module router to procedures, so a module that fails to load is caught", async () => {
		// Arrange
		const keys = Object.keys(router);

		// Act
		const resolved = (await unlazyRouter(router)) as Record<
			string,
			unknown
		>;

		// Assert
		expect(Object.keys(resolved)).toEqual(keys);
		const empty = keys.filter((key) => {
			const value = resolved[key];
			return (
				!isProcedure(value) &&
				(typeof value !== "object" ||
					value === null ||
					Object.keys(value).length === 0)
			);
		});
		expect(empty).toEqual([]);
	}, 300_000);
});
