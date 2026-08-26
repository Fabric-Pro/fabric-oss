import { describe, expect, it } from "vitest";
import { maskEmail } from "../mask-email";

describe("maskEmail", () => {
	it("masks a standard email address", () => {
		expect(maskEmail("john@example.com")).toBe("j***@example.com");
	});

	it("masks an email with a short local part", () => {
		expect(maskEmail("a@example.com")).toBe("a***@example.com");
	});

	it("masks an email with a multi-segment domain", () => {
		expect(maskEmail("alice@mail.company.org")).toBe(
			"a***@mail.company.org",
		);
	});

	it("handles a degenerate address with no local part", () => {
		// Should not throw; return a safe fallback
		expect(maskEmail("@example.com")).toBe("***@example.com");
	});
});
