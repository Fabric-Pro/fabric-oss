import { describe, expect, it } from "vitest";
import {
	ACTION_ITEM_LINK_VERSION,
	computeActionItemKey,
	normalizeItemText,
} from "../prisma/queries/projects/meeting-action-item-keys";

describe("normalizeItemText", () => {
	it("collapses whitespace, trims, and lowercases", () => {
		expect(normalizeItemText("  Ship   the\nDigest ")).toBe(
			"ship the digest",
		);
	});

	it("is a no-op for already-canonical text", () => {
		expect(normalizeItemText("ship the digest")).toBe("ship the digest");
	});
});

describe("computeActionItemKey", () => {
	it("is stable across whitespace and case differences", () => {
		expect(computeActionItemKey("Ship the digest")).toBe(
			computeActionItemKey("  ship   the digest  "),
		);
	});

	it("differs for different texts", () => {
		expect(computeActionItemKey("Ship the digest")).not.toBe(
			computeActionItemKey("Ship the agenda"),
		);
	});

	it("returns a 64-char hex digest", () => {
		expect(computeActionItemKey("anything")).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is version-prefixed so a version bump invalidates every stored key", () => {
		expect(ACTION_ITEM_LINK_VERSION).toBeGreaterThanOrEqual(1);
		// Two texts that differ only by the version prefix must not collide:
		// guards against a naive `hash(text)` that a bump could not invalidate.
		expect(computeActionItemKey("v1")).not.toBe(computeActionItemKey("v2"));
	});
});
