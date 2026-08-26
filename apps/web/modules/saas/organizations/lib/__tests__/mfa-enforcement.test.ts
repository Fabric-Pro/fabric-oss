import { describe, expect, it } from "vitest";
import { shouldEnforceOrgTwoFactor } from "../mfa-enforcement";

const base = {
	twoFactorGloballyEnabled: true,
	isGuest: false,
	userHasTwoFactor: false,
	orgRequiresTwoFactor: true,
};

describe("shouldEnforceOrgTwoFactor", () => {
	it("enforces when the org requires 2FA and a member without 2FA visits", () => {
		expect(shouldEnforceOrgTwoFactor(base)).toBe(true);
	});

	it("does NOT enforce when 2FA is globally disabled (nothing to enroll into)", () => {
		expect(
			shouldEnforceOrgTwoFactor({
				...base,
				twoFactorGloballyEnabled: false,
			}),
		).toBe(false);
	});

	it("does NOT enforce for guests (governed by project membership, not org membership)", () => {
		expect(shouldEnforceOrgTwoFactor({ ...base, isGuest: true })).toBe(
			false,
		);
	});

	it("does NOT enforce when the member already has 2FA enabled", () => {
		expect(
			shouldEnforceOrgTwoFactor({ ...base, userHasTwoFactor: true }),
		).toBe(false);
	});

	it("does NOT enforce when the org has not opted in", () => {
		expect(
			shouldEnforceOrgTwoFactor({ ...base, orgRequiresTwoFactor: false }),
		).toBe(false);
	});

	it("is inert by default: an opted-out org never gates, regardless of member 2FA state", () => {
		for (const userHasTwoFactor of [true, false]) {
			for (const isGuest of [true, false]) {
				expect(
					shouldEnforceOrgTwoFactor({
						twoFactorGloballyEnabled: true,
						isGuest,
						userHasTwoFactor,
						orgRequiresTwoFactor: false,
					}),
				).toBe(false);
			}
		}
	});

	it("only the all-conditions-true row of the truth table enforces", () => {
		const bools = [true, false];
		let enforcedCount = 0;
		for (const twoFactorGloballyEnabled of bools) {
			for (const isGuest of bools) {
				for (const userHasTwoFactor of bools) {
					for (const orgRequiresTwoFactor of bools) {
						if (
							shouldEnforceOrgTwoFactor({
								twoFactorGloballyEnabled,
								isGuest,
								userHasTwoFactor,
								orgRequiresTwoFactor,
							})
						) {
							enforcedCount++;
							// The only row that should enforce.
							expect(twoFactorGloballyEnabled).toBe(true);
							expect(isGuest).toBe(false);
							expect(userHasTwoFactor).toBe(false);
							expect(orgRequiresTwoFactor).toBe(true);
						}
					}
				}
			}
		}
		expect(enforcedCount).toBe(1);
	});
});
