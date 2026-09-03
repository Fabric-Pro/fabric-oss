import { describe, expect, it } from "vitest";
import {
	GET_STARTED_GROUPS,
	GET_STARTED_PAGES,
	type GsRuntimeGates,
	isGsEntryEnabled,
	pageForTab,
} from "../../../../modules/saas/get-started/lib/get-started-registry";

/**
 * Publishing Suite is scoped to named organizations, so the guide's entry for
 * it can no longer be a module constant evaluated at build time — one build
 * serves organizations that have it and organizations that do not.
 */

const OFF: GsRuntimeGates = { publishingSuite: false };
const ON: GsRuntimeGates = { publishingSuite: true };

describe("Get Started — Publishing Suite runtime gate", () => {
	it("the drawer item declares the runtime gate, not a build-time value", () => {
		const item = GET_STARTED_GROUPS.flatMap((g) => g.items).find(
			(i) => i.id === "publishing-suite",
		);
		expect(item).toBeDefined();
		expect(item?.runtimeGate).toBe("publishingSuite");
		// A leftover build-time `enabled: false` would win over the gate and
		// hide the entry for an enrolled organization.
		expect(item?.enabled).toBeUndefined();
	});

	it("the page tour declares the runtime gate too", () => {
		const page = GET_STARTED_PAGES.find(
			(p) => p.tab === "publishing-suite",
		);
		expect(page).toBeDefined();
		expect(page?.runtimeGate).toBe("publishingSuite");
		expect(page?.enabled).toBeUndefined();
	});

	it("isGsEntryEnabled follows the gate for a runtime-gated entry", () => {
		const entry = { runtimeGate: "publishingSuite" } as const;
		expect(isGsEntryEnabled(entry, OFF)).toBe(false);
		expect(isGsEntryEnabled(entry, ON)).toBe(true);
	});

	it("a build-time `enabled: false` still wins, and an ungated entry is on", () => {
		expect(isGsEntryEnabled({ enabled: false }, ON)).toBe(false);
		expect(isGsEntryEnabled({}, OFF)).toBe(true);
	});

	it("pageForTab withholds the Publishing tour when the gate is off", () => {
		expect(pageForTab("publishing-suite", OFF)).toBeNull();
		expect(pageForTab("publishing-suite", ON)?.tab).toBe(
			"publishing-suite",
		);
	});

	it("the gate does not disturb ungated page tours", () => {
		// Negative control with its precondition stated: `overview` has no gate
		// of any kind, so it must resolve identically under both gate values.
		expect(pageForTab("overview", OFF)?.tab).toBe("overview");
		expect(pageForTab("overview", ON)?.tab).toBe("overview");
	});
});
