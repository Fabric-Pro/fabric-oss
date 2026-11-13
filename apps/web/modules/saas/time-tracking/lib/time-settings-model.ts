/**
 * The time-tracking settings screens' view of a project's and an
 * organization's time policy: what each control shows, and the settings an
 * optimistic save puts on screen before the server answers.
 */

import {
	PROJECT_BILLING_MODEL_VALUES,
	type ProjectBillingModel,
	resolveEffectiveTimePolicy,
} from "@repo/utils/time-tracking";
import type { orpcClient } from "@shared/lib/orpc-client";

export type ProjectTimeSettings = Awaited<
	ReturnType<typeof orpcClient.timeTracking.getProjectSettings>
>;

export type ProjectTimeSettingsPatch = Omit<
	Parameters<typeof orpcClient.timeTracking.updateProjectSettings>[0],
	"projectId"
>;

export type OrganizationTimeSettings = Awaited<
	ReturnType<typeof orpcClient.timeTracking.getOrganizationSettings>
>;

export type OrganizationTimeSettingsPatch = Omit<
	Parameters<typeof orpcClient.timeTracking.updateOrganizationSettings>[0],
	"organizationId"
>;

/** A project's billable default: its own value, or the organization's. */
export type BillableDefaultChoice = "inherit" | "billable" | "not-billable";

export const BILLABLE_DEFAULT_CHOICES: readonly BillableDefaultChoice[] = [
	"inherit",
	"billable",
	"not-billable",
];

export function isBillableDefaultChoice(
	value: string,
): value is BillableDefaultChoice {
	return (BILLABLE_DEFAULT_CHOICES as readonly string[]).includes(value);
}

export function isProjectBillingModel(
	value: string,
): value is ProjectBillingModel {
	return (PROJECT_BILLING_MODEL_VALUES as readonly string[]).includes(value);
}

/** `null` is the project inheriting the organization's default. */
export function billableDefaultChoice(
	value: boolean | null,
): BillableDefaultChoice {
	if (value === null) {
		return "inherit";
	}
	return value ? "billable" : "not-billable";
}

export function billableDefaultFromChoice(
	choice: BillableDefaultChoice,
): boolean | null {
	switch (choice) {
		case "inherit":
			return null;
		case "billable":
			return true;
		case "not-billable":
			return false;
		default: {
			const unhandled: never = choice;
			throw new Error(`Unhandled billable default: ${String(unhandled)}`);
		}
	}
}

/** The organization's billable default as entries get it: unset is billable. */
export function organizationDefaultBillable(value: boolean | null): boolean {
	return value ?? true;
}

/**
 * The project's start/stop switch. The organization's requirement applies to
 * every project and a project cannot lift it, so while it is on the switch
 * shows on and cannot be changed here.
 */
export function startStopSwitch(settings: {
	timeRequireStartStop: boolean;
	organization: { timeRequireStartStop: boolean };
}): { checked: boolean; locked: boolean } {
	const locked = settings.organization.timeRequireStartStop;
	return { checked: locked || settings.timeRequireStartStop, locked };
}

/** The project's settings with `patch` applied, as the server will save them. */
export function applyProjectSettingsPatch(
	settings: ProjectTimeSettings,
	patch: ProjectTimeSettingsPatch,
): ProjectTimeSettings {
	const next = {
		...settings,
		billingModel: patch.billingModel ?? settings.billingModel,
		timeRequireStartStop:
			patch.timeRequireStartStop ?? settings.timeRequireStartStop,
		timeDefaultBillable:
			patch.timeDefaultBillable === undefined
				? settings.timeDefaultBillable
				: patch.timeDefaultBillable,
	};
	return {
		...next,
		effective: resolveEffectiveTimePolicy({
			org: settings.organization,
			project: next,
		}),
	};
}

/** The organization's settings with `patch` applied. */
export function applyOrganizationSettingsPatch(
	settings: OrganizationTimeSettings,
	patch: OrganizationTimeSettingsPatch,
): OrganizationTimeSettings {
	const next = {
		...settings,
		timeRequireStartStop:
			patch.timeRequireStartStop ?? settings.timeRequireStartStop,
		timeDefaultBillable:
			patch.timeDefaultBillable ?? settings.timeDefaultBillable,
	};
	return {
		...next,
		effective: resolveEffectiveTimePolicy({
			org: next,
			project: { timeRequireStartStop: false, timeDefaultBillable: null },
		}),
	};
}
