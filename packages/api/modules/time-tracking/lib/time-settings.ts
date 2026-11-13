/**
 * Project and organization time-tracking settings: their wire shape, and
 * which of the requested values actually change something. Also the time
 * zone a member's new time starts in.
 *
 * Settings apply to entries saved from then on. An existing entry keeps the
 * start/stop rule and billable flag it was saved with, so nothing here touches
 * `time_entry`.
 */

import { findUserProfileTimeZone, type TimePolicyRow } from "@repo/database";
import {
	isValidTimeZone,
	resolveEffectiveTimePolicy,
} from "@repo/utils/time-tracking";
import type { LiveTimeTrackingProjectRow } from "./save-entry";

/**
 * The time zone on the caller's profile when it is a real IANA zone, else
 * null. A new entry or timer starts in it; the browser's zone is the
 * fallback.
 */
export async function resolveProfileTimeZone(
	userId: string,
): Promise<string | null> {
	const timeZone = await findUserProfileTimeZone(userId);
	return timeZone && isValidTimeZone(timeZone) ? timeZone : null;
}

/** No settings of its own: what the organization level resolves to. */
const NO_PROJECT_POLICY: TimePolicyRow = {
	timeRequireStartStop: false,
	timeDefaultBillable: null,
};

export function serializeProjectTimeSettings(
	project: LiveTimeTrackingProjectRow,
) {
	return {
		projectId: project.id,
		billingModel: project.billingModel,
		timeRequireStartStop: project.timeRequireStartStop,
		timeDefaultBillable: project.timeDefaultBillable,
		organization: {
			timeRequireStartStop: project.organization.timeRequireStartStop,
			timeDefaultBillable: project.organization.timeDefaultBillable,
		},
		effective: resolveEffectiveTimePolicy({
			org: project.organization,
			project,
		}),
	};
}

export function serializeOrganizationTimeSettings(
	organizationId: string,
	policy: TimePolicyRow,
) {
	return {
		organizationId,
		timeRequireStartStop: policy.timeRequireStartStop,
		timeDefaultBillable: policy.timeDefaultBillable,
		effective: resolveEffectiveTimePolicy({
			org: policy,
			project: NO_PROJECT_POLICY,
		}),
	};
}

type SettingValue = string | boolean | null;

/** What changed, field by field, for the audit row. */
export type SettingChanges = Record<
	string,
	{ before: SettingValue; after: SettingValue }
>;

/**
 * Whether `requested` changes `current`. `undefined` means the caller left the
 * field out, which keeps it.
 */
export function isSettingChange<T extends SettingValue>(
	current: T,
	requested: T | undefined,
): requested is T {
	return requested !== undefined && requested !== current;
}
