import { describe, expect, it } from "vitest";
import { isInviteAccountMismatch } from "../invite-account-mismatch";

describe("isInviteAccountMismatch", () => {
	it("returns false when there is no invite email", () => {
		expect(isInviteAccountMismatch("a@example.com", null)).toBe(false);
		expect(isInviteAccountMismatch("a@example.com", undefined)).toBe(false);
		expect(isInviteAccountMismatch("a@example.com", "")).toBe(false);
	});

	it("returns false when there is no session email", () => {
		expect(isInviteAccountMismatch(null, "b@example.com")).toBe(false);
		expect(isInviteAccountMismatch(undefined, "b@example.com")).toBe(false);
		expect(isInviteAccountMismatch("", "b@example.com")).toBe(false);
	});

	it("returns false when emails match (case-insensitive)", () => {
		expect(isInviteAccountMismatch("a@example.com", "a@example.com")).toBe(
			false,
		);
		expect(isInviteAccountMismatch("A@Example.com", "a@example.com")).toBe(
			false,
		);
	});

	it("returns true when the session email differs from the invite email", () => {
		expect(isInviteAccountMismatch("a@example.com", "b@example.com")).toBe(
			true,
		);
		// Mixed case on the session side pins case-insensitivity on both sides:
		// dropping .toLowerCase() from either operand would break this.
		expect(isInviteAccountMismatch("A@Example.com", "b@example.com")).toBe(
			true,
		);
	});
});
