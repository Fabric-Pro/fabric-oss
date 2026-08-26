import { describe, expect, it } from "vitest";
import { isInviteAccountMismatch } from "../invite-account-mismatch";

describe("isInviteAccountMismatch", () => {
	it("returns false when there is no invite email", () => {
		expect(isInviteAccountMismatch("a@x.com", null)).toBe(false);
		expect(isInviteAccountMismatch("a@x.com", undefined)).toBe(false);
		expect(isInviteAccountMismatch("a@x.com", "")).toBe(false);
	});

	it("returns false when there is no session email", () => {
		expect(isInviteAccountMismatch(null, "b@x.com")).toBe(false);
		expect(isInviteAccountMismatch(undefined, "b@x.com")).toBe(false);
		expect(isInviteAccountMismatch("", "b@x.com")).toBe(false);
	});

	it("returns false when emails match (case-insensitive)", () => {
		expect(isInviteAccountMismatch("a@x.com", "a@x.com")).toBe(false);
		expect(isInviteAccountMismatch("A@X.com", "a@x.com")).toBe(false);
	});

	it("returns true when the session email differs from the invite email", () => {
		expect(isInviteAccountMismatch("a@x.com", "b@x.com")).toBe(true);
		// Mixed case on the session side pins case-insensitivity on both sides:
		// dropping .toLowerCase() from either operand would break this.
		expect(isInviteAccountMismatch("A@X.com", "b@x.com")).toBe(true);
	});
});
