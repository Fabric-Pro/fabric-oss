/**
 * `findActionById` accepts four identifier shapes, two of which are not unique
 * across plugins: "create-ticket" is a slug on Linear, Zendesk AND
 * Freshservice. The previous implementation walked the registry
 * plugin-by-plugin trying all four strategies per action, so a bare slug on an
 * early plugin beat an exact action-ID match on a later one and the winner
 * depended on Map insertion order.
 */

import { describe, expect, it, vi } from "vitest";

import "../../plugins";
import { findActionById, getAllActions } from "../../plugins";

describe("findActionById", () => {
	it("resolves a full action ID", () => {
		const action = findActionById("linear/create-ticket");

		expect(action?.integrationType).toBe("LINEAR");
		expect(action?.slug).toBe("create-ticket");
	});

	it("resolves a node type", () => {
		const action = findActionById("zendesk-create-ticket");

		expect(action?.integrationType).toBe("ZENDESK");
		expect(action?.slug).toBe("create-ticket");
	});

	it("prefers an exact action ID over a bare slug on another plugin", () => {
		// Regression: whichever plugin the registry iterated first used to win
		// on its bare slug before this exact match was ever considered.
		const action = findActionById("freshservice/create-ticket");

		expect(action?.integrationType).toBe("FRESHSERVICE");
	});

	it("refuses an ambiguous bare slug instead of guessing a plugin", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {
			// silence the expected diagnostic
		});

		const owners = getAllActions().filter(
			(action) => action.slug === "create-ticket",
		);
		// Guard the premise: this test is meaningless if the slug is unique.
		expect(owners.length).toBeGreaterThan(1);

		expect(findActionById("create-ticket")).toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("Ambiguous action identifier"),
		);

		warn.mockRestore();
	});

	it("still resolves a slug that only one plugin claims", () => {
		const owners = getAllActions().filter(
			(action) => action.slug === "list-designs",
		);
		expect(owners).toHaveLength(1);

		expect(findActionById("list-designs")?.integrationType).toBe("CANVA");
	});

	it("returns undefined for an unknown identifier", () => {
		expect(findActionById("nope")).toBeUndefined();
		expect(findActionById(undefined)).toBeUndefined();
		expect(findActionById(null)).toBeUndefined();
	});
});
