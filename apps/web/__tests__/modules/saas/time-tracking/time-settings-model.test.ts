/**
 * What the time-tracking settings controls show: the project's three-state
 * billable default (its own value or the organization's), the start/stop
 * switch the organization can lock on, and the settings an optimistic save
 * shows before the server answers.
 */

import {
	applyOrganizationSettingsPatch,
	applyProjectSettingsPatch,
	billableDefaultChoice,
	billableDefaultFromChoice,
	type OrganizationTimeSettings,
	organizationDefaultBillable,
	type ProjectTimeSettings,
	startStopSwitch,
} from "@saas/time-tracking/lib/time-settings-model";
import { describe, expect, it } from "vitest";

const project: ProjectTimeSettings = {
	projectId: "project-a",
	billingModel: "FIXED_BID",
	timeRequireStartStop: false,
	timeDefaultBillable: null,
	organization: { timeRequireStartStop: false, timeDefaultBillable: false },
	effective: { startStopRequired: false, defaultBillable: false },
};

const organization: OrganizationTimeSettings = {
	organizationId: "org-1",
	timeRequireStartStop: false,
	timeDefaultBillable: null,
	effective: { startStopRequired: false, defaultBillable: true },
};

describe("billable default", () => {
	it("maps the stored value to a choice and back", () => {
		expect(billableDefaultChoice(null)).toBe("inherit");
		expect(billableDefaultChoice(true)).toBe("billable");
		expect(billableDefaultChoice(false)).toBe("not-billable");

		expect(billableDefaultFromChoice("inherit")).toBeNull();
		expect(billableDefaultFromChoice("billable")).toBe(true);
		expect(billableDefaultFromChoice("not-billable")).toBe(false);
	});

	it("reads an unset organization default as billable", () => {
		expect(organizationDefaultBillable(null)).toBe(true);
		expect(organizationDefaultBillable(false)).toBe(false);
	});
});

describe("startStopSwitch", () => {
	it("follows the project while the organization does not require times", () => {
		expect(startStopSwitch(project)).toEqual({
			checked: false,
			locked: false,
		});
		expect(
			startStopSwitch({ ...project, timeRequireStartStop: true }),
		).toEqual({ checked: true, locked: false });
	});

	it("is on and locked while the organization requires times", () => {
		expect(
			startStopSwitch({
				...project,
				organization: {
					timeRequireStartStop: true,
					timeDefaultBillable: null,
				},
			}),
		).toEqual({ checked: true, locked: true });
	});
});

describe("applyProjectSettingsPatch", () => {
	it("changes only the patched field and recomputes the effective rules", () => {
		const next = applyProjectSettingsPatch(project, {
			timeDefaultBillable: true,
		});

		expect(next).toEqual({
			...project,
			timeDefaultBillable: true,
			effective: { startStopRequired: false, defaultBillable: true },
		});
	});

	it("can set the billable default back to inheriting", () => {
		const own = applyProjectSettingsPatch(project, {
			timeDefaultBillable: true,
		});

		const inherited = applyProjectSettingsPatch(own, {
			timeDefaultBillable: null,
		});

		expect(inherited.timeDefaultBillable).toBeNull();
		expect(inherited.effective.defaultBillable).toBe(false);
	});

	it("keeps fields the patch leaves out", () => {
		const next = applyProjectSettingsPatch(
			{ ...project, timeDefaultBillable: false },
			{ billingModel: "TIME_AND_MATERIALS" },
		);

		expect(next.billingModel).toBe("TIME_AND_MATERIALS");
		expect(next.timeDefaultBillable).toBe(false);
	});
});

describe("applyOrganizationSettingsPatch", () => {
	it("recomputes what a project with no settings of its own gets", () => {
		const next = applyOrganizationSettingsPatch(organization, {
			timeRequireStartStop: true,
			timeDefaultBillable: false,
		});

		expect(next).toEqual({
			...organization,
			timeRequireStartStop: true,
			timeDefaultBillable: false,
			effective: { startStopRequired: true, defaultBillable: false },
		});
	});
});
