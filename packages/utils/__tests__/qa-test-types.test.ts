/**
 * `resolveRequiredTestTypes` and friends.
 *
 * This list reaches a drafting prompt and a settings page, and the two must
 * agree about what a project requires. The cases that matter are the ones where
 * "empty" and "explicit" could be confused: empty means FOLLOW THE TIER, and
 * getting that backwards would silently stop every project that never opened
 * the control from requiring anything at all.
 */

import { describe, expect, it } from "vitest";

import {
	defaultTestTypesForDepth,
	isOverridingDepthDefault,
	QA_TEST_TYPES,
	resolveRequiredTestTypes,
	resolveScepticRoles,
	scepticRolesSuppressedByDepth,
} from "../lib/qa-test-types";

describe("defaultTestTypesForDepth", () => {
	it("gives the light tier functional cases only", () => {
		expect(defaultTestTypesForDepth("EASY")).toEqual(["functional"]);
	});

	it("adds integration and end-to-end at the standard tier", () => {
		expect(defaultTestTypesForDepth("AVERAGE")).toEqual([
			"functional",
			"integration",
			"e2e",
		]);
	});

	it("adds security and accessibility at the enterprise tier", () => {
		expect(defaultTestTypesForDepth("HARD")).toEqual([
			"functional",
			"integration",
			"e2e",
			"security",
			"accessibility",
		]);
	});

	it("leaves performance out of every tier default", () => {
		// Available to select, never automatic: a performance case is written
		// where a criterion names one, which is what the tier copy has always said.
		for (const depth of ["EASY", "AVERAGE", "HARD"]) {
			expect(defaultTestTypesForDepth(depth)).not.toContain(
				"performance",
			);
		}
	});

	it("falls back to the standard tier for an unknown value", () => {
		expect(defaultTestTypesForDepth("WHATEVER")).toEqual(
			defaultTestTypesForDepth("AVERAGE"),
		);
		expect(defaultTestTypesForDepth(null)).toEqual(
			defaultTestTypesForDepth("AVERAGE"),
		);
	});
});

describe("resolveRequiredTestTypes", () => {
	it("follows the tier when nothing is stored", () => {
		// The load-bearing case: every project that predates the column stores
		// an empty array, and must keep behaving exactly as its tier says.
		expect(resolveRequiredTestTypes("EASY", [])).toEqual(["functional"]);
		expect(resolveRequiredTestTypes("EASY", null)).toEqual(["functional"]);
		expect(resolveRequiredTestTypes("EASY", undefined)).toEqual([
			"functional",
		]);
	});

	it("uses the stored list when there is one", () => {
		expect(resolveRequiredTestTypes("EASY", ["security"])).toEqual([
			"security",
		]);
	});

	it("returns a stored list in canonical order, not click order", () => {
		expect(
			resolveRequiredTestTypes("AVERAGE", [
				"e2e",
				"functional",
				"security",
			]),
		).toEqual(["functional", "e2e", "security"]);
	});

	it("drops unknown values rather than passing them to a prompt", () => {
		expect(
			resolveRequiredTestTypes("EASY", ["functional", "chaos-monkey"]),
		).toEqual(["functional"]);
	});

	it("falls back to the tier when every stored value is unknown", () => {
		// Not an empty requirement list: a row of typos must not read as
		// "this project requires nothing".
		expect(resolveRequiredTestTypes("HARD", ["nonsense"])).toEqual(
			defaultTestTypesForDepth("HARD"),
		);
	});

	it("ignores duplicates", () => {
		expect(
			resolveRequiredTestTypes("EASY", ["security", "security"]),
		).toEqual(["security"]);
	});
});

describe("isOverridingDepthDefault", () => {
	it("is false when nothing is stored", () => {
		expect(isOverridingDepthDefault("AVERAGE", [])).toBe(false);
		expect(isOverridingDepthDefault("AVERAGE", null)).toBe(false);
	});

	it("is false when the stored list matches the tier exactly", () => {
		// Selecting the tier's own set by hand is not an override, so the page
		// must not claim the tier has stopped deciding when it still does.
		expect(
			isOverridingDepthDefault("AVERAGE", [
				"functional",
				"integration",
				"e2e",
			]),
		).toBe(false);
	});

	it("is false when the stored list matches the tier in a different order", () => {
		expect(
			isOverridingDepthDefault("AVERAGE", [
				"e2e",
				"functional",
				"integration",
			]),
		).toBe(false);
	});

	it("is true when the stored list differs from the tier", () => {
		expect(
			isOverridingDepthDefault("EASY", ["functional", "security"]),
		).toBe(true);
		expect(isOverridingDepthDefault("HARD", ["functional"])).toBe(true);
	});
});

describe("the type list itself", () => {
	it("is the six kinds the settings page offers", () => {
		expect([...QA_TEST_TYPES]).toEqual([
			"functional",
			"integration",
			"e2e",
			"security",
			"performance",
			"accessibility",
		]);
	});
});

/**
 * Depth caps the sceptic roles (product ruling, 2026-07-31).
 *
 * The tier could not previously do what it said: roles were independent of depth
 * and all five default ON, so a project set to Light still received security,
 * performance and accessibility cases. The escape hatch matters as much as the
 * cap — a team that explicitly asks for a dimension must keep its lens.
 */
describe("resolveScepticRoles", () => {
	const ALL = ["security", "ux", "performance", "accessibility", "edgeCase"];

	it("drops the roles Light excludes, and keeps the ones with no dimension", () => {
		expect(
			resolveScepticRoles({
				depth: "EASY",
				requiredTestTypes: [],
				scepticRoles: ALL,
				scepticRolesEnabled: true,
			}),
		).toEqual(["ux", "edgeCase"]);
	});

	it("keeps a lens the project explicitly asked for, at any depth", () => {
		// The escape hatch. Capping against the TIER rather than the effective
		// types would silently overrule somebody who ticked the box.
		expect(
			resolveScepticRoles({
				depth: "EASY",
				requiredTestTypes: ["functional", "security"],
				scepticRoles: ALL,
				scepticRolesEnabled: true,
			}),
		).toEqual(["security", "ux", "edgeCase"]);
	});

	it("keeps security and accessibility at the deepest tier", () => {
		// HARD's defaults include both; performance is in no tier's default, so
		// it stays capped until somebody selects it.
		expect(
			resolveScepticRoles({
				depth: "HARD",
				requiredTestTypes: [],
				scepticRoles: ALL,
				scepticRolesEnabled: true,
			}),
		).toEqual(["security", "ux", "accessibility", "edgeCase"]);
	});

	it("returns nothing when roles are switched off", () => {
		expect(
			resolveScepticRoles({
				depth: "HARD",
				requiredTestTypes: [],
				scepticRoles: ALL,
				scepticRolesEnabled: false,
			}),
		).toEqual([]);
	});
});

describe("scepticRolesSuppressedByDepth", () => {
	it("names the roles the depth is silencing, so the page can say so", () => {
		// A chip shown as on while it produces nothing is the failure this
		// replaced; the settings page needs the list to explain itself.
		expect(
			scepticRolesSuppressedByDepth({
				depth: "EASY",
				requiredTestTypes: [],
				scepticRoles: ["security", "ux", "accessibility"],
				scepticRolesEnabled: true,
			}),
		).toEqual(["security", "accessibility"]);
	});

	it("names nothing when the depth suppresses nothing", () => {
		expect(
			scepticRolesSuppressedByDepth({
				depth: "HARD",
				requiredTestTypes: [],
				scepticRoles: ["security", "ux"],
				scepticRolesEnabled: true,
			}),
		).toEqual([]);
	});
});
