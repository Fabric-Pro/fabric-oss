import { describe, expect, it } from "vitest";
import {
	awaitsDecision,
	countAwaitingDecision,
} from "../instructions-proposal-review";

const row = (over: Record<string, unknown> = {}) => ({
	proposalStatus: "PENDING",
	status: "READY",
	destination: "FABRIC",
	...over,
});

describe("awaitsDecision", () => {
	it("is true for a pending Fabric proposal whose checks are done", () => {
		expect(awaitsDecision(row())).toBe(true);
		expect(awaitsDecision(row({ destination: undefined }))).toBe(true);
	});

	it("is true for one whose checks failed, which a reviewer can still reject", () => {
		expect(awaitsDecision(row({ status: "REJECTED" }))).toBe(true);
		expect(awaitsDecision(row({ status: "FAILED" }))).toBe(true);
	});

	it("is false while the checks are still running", () => {
		expect(awaitsDecision(row({ status: "RECEIVING" }))).toBe(false);
		expect(awaitsDecision(row({ status: "VALIDATING" }))).toBe(false);
	});

	it("is false once the proposal is decided or settled", () => {
		for (const proposalStatus of [
			"APPROVED",
			"REJECTED",
			"MERGED",
			"CLOSED",
		]) {
			expect(awaitsDecision(row({ proposalStatus }))).toBe(false);
		}
	});

	it("is false for a suggestion that is decided on its pull request", () => {
		expect(awaitsDecision(row({ destination: "REPOSITORY" }))).toBe(false);
	});
});

describe("countAwaitingDecision", () => {
	it("counts only the rows a reviewer can decide", () => {
		expect(
			countAwaitingDecision([
				row(),
				row({ status: "VALIDATING" }),
				row({ proposalStatus: "APPROVED" }),
				row({ destination: "REPOSITORY" }),
				row({ status: "FAILED" }),
			]),
		).toBe(2);
	});

	it("is zero for no list yet", () => {
		expect(countAwaitingDecision(undefined)).toBe(0);
		expect(countAwaitingDecision([])).toBe(0);
	});
});
