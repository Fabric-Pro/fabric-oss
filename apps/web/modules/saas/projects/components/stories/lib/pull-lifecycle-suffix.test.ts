import { describe, expect, it } from "vitest";
import { pullLifecycleSuffix } from "./pull-lifecycle-suffix";

describe("pullLifecycleSuffix", () => {
	it("appends ' • marked done & hidden' for auto-hidden", () => {
		expect(pullLifecycleSuffix("auto-hidden")).toBe(
			" • marked done & hidden",
		);
	});

	it("appends ' • restored' for auto-unhid", () => {
		expect(pullLifecycleSuffix("auto-unhid")).toBe(" • restored");
	});

	it("appends ' • unhide suggested in Review Center' for unhide-proposed", () => {
		expect(pullLifecycleSuffix("unhide-proposed")).toBe(
			" • unhide suggested in Review Center",
		);
	});

	it("appends ' • marked done' for checkmark-only", () => {
		expect(pullLifecycleSuffix("checkmark-only")).toBe(" • marked done");
	});

	it("returns '' for already-applied", () => {
		expect(pullLifecycleSuffix("already-applied")).toBe("");
	});

	it("returns '' for non-terminal-passthrough", () => {
		expect(pullLifecycleSuffix("non-terminal-passthrough")).toBe("");
	});

	it("returns '' for undefined", () => {
		expect(pullLifecycleSuffix(undefined)).toBe("");
	});

	it("returns '' for an unknown action value", () => {
		expect(pullLifecycleSuffix("something-else")).toBe("");
	});
});
