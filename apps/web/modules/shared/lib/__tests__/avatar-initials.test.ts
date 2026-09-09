import { describe, expect, it } from "vitest";
import { getAvatarInitials } from "../avatar-initials";

describe("getAvatarInitials", () => {
	it("renders first and last initial for standard full names", () => {
		expect(getAvatarInitials("Jane Smith")).toBe("JS");
		expect(getAvatarInitials("John Doe")).toBe("JD");
	});

	it("converts lowercase names to uppercase initials", () => {
		expect(getAvatarInitials("jane smith")).toBe("JS");
		expect(getAvatarInitials("casey jordan")).toBe("CJ");
	});

	it("handles multi-word names with middle names by picking first and last words", () => {
		expect(getAvatarInitials("Jane Marie Smith")).toBe("JS");
		expect(getAvatarInitials("Alex Morgan Taylor")).toBe("AT");
	});

	it("handles single-word names gracefully (AC3 fallback)", () => {
		expect(getAvatarInitials("Alex")).toBe("AL");
		expect(getAvatarInitials("Jordan")).toBe("JO");
		expect(getAvatarInitials("A")).toBe("A");
	});

	it("handles email addresses by tokenizing local part without emitting punctuation", () => {
		expect(getAvatarInitials("j.smith@example.com")).toBe("JS");
		expect(getAvatarInitials("jane.smith@example.com")).toBe("JS");
		expect(getAvatarInitials("john_doe@example.com")).toBe("JD");
		expect(getAvatarInitials("user-name@example.com")).toBe("UN");
		expect(getAvatarInitials("alex+tag@example.com")).toBe("AT");
		expect(getAvatarInitials("x@example.com")).toBe("X");
	});

	it("strips trailing punctuation in single-word tokens", () => {
		expect(getAvatarInitials("J.")).toBe("J");
		expect(getAvatarInitials("User.")).toBe("US");
	});

	it("preserves astral code points and surrogate pairs", () => {
		expect(getAvatarInitials("😀nna Smith")).toBe("😀S");
		expect(getAvatarInitials("😀")).toBe("😀");
	});

	it("handles hyphenated and apostrophe names", () => {
		expect(getAvatarInitials("Jean-Luc Picard")).toBe("JP");
		expect(getAvatarInitials("O'Connor")).toBe("OC");
	});

	it("handles irregular whitespace cleanly", () => {
		expect(getAvatarInitials("  Jane   Smith  ")).toBe("JS");
		expect(getAvatarInitials("Jane\tSmith")).toBe("JS");
		expect(getAvatarInitials("Jane\nSmith")).toBe("JS");
	});

	it("honors custom and default fallbacks without throwing", () => {
		expect(getAvatarInitials("")).toBe("");
		expect(getAvatarInitials("   ")).toBe("");
		expect(getAvatarInitials(null)).toBe("");
		expect(getAvatarInitials(undefined)).toBe("");
		expect(getAvatarInitials(null, "?")).toBe("?");
		expect(getAvatarInitials("", "ME")).toBe("ME");
		expect(getAvatarInitials(undefined, "U")).toBe("U");
		expect(getAvatarInitials(null, "—")).toBe("—");
	});
});
