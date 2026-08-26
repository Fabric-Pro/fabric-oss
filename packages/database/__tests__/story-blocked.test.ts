import { describe, expect, it } from "vitest";
import {
	blockChangeDescription,
	normalizeBlockReason,
} from "../prisma/queries/projects/story-blocked";

describe("normalizeBlockReason — stored block reason", () => {
	it("keeps a trimmed reason when blocking", () => {
		expect(normalizeBlockReason(true, "  needs the API fix  ")).toBe(
			"needs the API fix",
		);
	});

	it("drops a whitespace-only reason to null when blocking", () => {
		expect(normalizeBlockReason(true, "   ")).toBeNull();
		expect(normalizeBlockReason(true, "")).toBeNull();
		expect(normalizeBlockReason(true, undefined)).toBeNull();
		expect(normalizeBlockReason(true, null)).toBeNull();
	});

	it("always clears the reason when unblocking (even if one is passed)", () => {
		expect(normalizeBlockReason(false, "stale reason")).toBeNull();
		expect(normalizeBlockReason(false, undefined)).toBeNull();
	});
});

describe("blockChangeDescription — version-history label", () => {
	it("includes the reason when blocking with one", () => {
		expect(blockChangeDescription(true, "needs the API fix")).toBe(
			"Blocked: needs the API fix",
		);
	});

	it("is a bare 'Blocked' when blocking without a reason", () => {
		expect(blockChangeDescription(true, null)).toBe("Blocked");
	});

	it("is 'Unblocked' when unblocking", () => {
		expect(blockChangeDescription(false, null)).toBe("Unblocked");
	});
});
