import { describe, expect, it } from "vitest";
import {
	GET_STARTED_GROUPS,
	type GsRuntimeGates,
	isGsEntryEnabled,
	pageComponentsFor,
	pageForTab,
} from "../../../../modules/saas/get-started/lib/get-started-registry";

/**
 * The report suite (`REPORT_SUITE_V2`, per organization) moves reports into
 * each project's Reports tab: the sidebar Reports page and its tour must go
 * away while it is on, and the project tab's tour must name its new sub-tabs.
 */

const OFF: GsRuntimeGates = {
	publishingSuite: false,
	todoList: false,
	glossyEdition: false,
	proposalArtifact: false,
	parlumeMeetings: false,
	credentialManager: false,
	reportSuite: false,
};
const ON: GsRuntimeGates = { ...OFF, reportSuite: true };

describe("Get Started — report suite runtime gate", () => {
	it("hides the sidebar Reports item while the suite is on", () => {
		const item = GET_STARTED_GROUPS.flatMap((g) => g.items).find(
			(i) => i.id === "reports",
		);
		expect(item?.hiddenWhen).toBe("reportSuite");
		expect(item && isGsEntryEnabled(item, OFF)).toBe(true);
		expect(item && isGsEntryEnabled(item, ON)).toBe(false);
	});

	it("keeps the project Reports tab entry under both values", () => {
		const item = GET_STARTED_GROUPS.flatMap((g) => g.items).find(
			(i) => i.id === "project-reports",
		);
		expect(item && isGsEntryEnabled(item, OFF)).toBe(true);
		expect(item && isGsEntryEnabled(item, ON)).toBe(true);
	});

	it("withholds the Reports page tour while the suite is on", () => {
		expect(pageForTab("reports-hub", OFF)?.tab).toBe("reports-hub");
		expect(pageForTab("reports-hub", ON)).toBeNull();
	});

	it("names the suite's sub-tabs in the project tab tour", () => {
		const page = pageForTab("reports", ON);
		expect(page).not.toBeNull();
		const tabs = page
			? pageComponentsFor(page, ON).find((c) => c.id === "reports-tabs")
			: undefined;
		expect(tabs?.body).toContain("'My Instances'");
		expect(tabs?.body).toContain("'Templates'");

		const legacy = page
			? pageComponentsFor(page, OFF).find((c) => c.id === "reports-tabs")
			: undefined;
		expect(legacy?.body).toContain("'My Report Instances'");
	});

	it("hiddenWhen loses to nothing but a build-time exclusion", () => {
		expect(isGsEntryEnabled({ hiddenWhen: "reportSuite" }, OFF)).toBe(true);
		expect(isGsEntryEnabled({ hiddenWhen: "reportSuite" }, ON)).toBe(false);
		expect(
			isGsEntryEnabled(
				{ enabled: false, hiddenWhen: "reportSuite" },
				OFF,
			),
		).toBe(false);
	});
});
