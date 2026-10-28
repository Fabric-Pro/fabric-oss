import { beforeEach, describe, expect, it } from "vitest";
import { type ApprovalCommand, createApprovalGate } from "../approval-gate";
import { createInitialState } from "../types";

const owner = {
	userId: "example-user",
	organizationId: "example-org",
	runId: "example-run",
};
let now = 1_000;
const state = createInitialState({
	...owner,
	executionId: "example-execution",
	executionMode: "balanced",
	message: "Example",
	history: [],
});
let gate: ReturnType<typeof createApprovalGate>;
let command: ApprovalCommand;

beforeEach(() => {
	now = 1_000;
	state.cancelled = false;
	state.approvalHistory = [];
	state.pendingApproval = {
		approvalId: "approval-1",
		stepId: "step-1",
		reason: "Review action",
	};
	gate = createApprovalGate(state, owner, () => now);
	gate.open(1_000, true);
	command = {
		...owner,
		decidedBy: owner.userId,
		approvalId: "approval-1",
		requestId: state.pendingApproval.requestId ?? "",
		approved: true,
	};
});

describe("single-use approval gate", () => {
	it("accepts one decision and rejects a conflicting concurrent decision", () => {
		expect(gate.decide(command)).toMatchObject({
			accepted: true,
			approved: true,
		});
		expect(gate.decide({ ...command, approved: false })).toEqual({
			accepted: false,
			reason: "decided",
		});
		expect(state.approvalDecision?.approved).toBe(true);
	});
	it.each(["approvalId", "requestId", "runId"] as const)(
		"rejects stale %s",
		(key) => {
			expect(gate.decide({ ...command, [key]: "other" })).toEqual({
				accepted: false,
				reason: "stale",
			});
			expect(state.approvalDecision).toBeNull();
		},
	);
	it.each(["organizationId", "decidedBy"] as const)(
		"rejects another %s",
		(key) => {
			expect(gate.decide({ ...command, [key]: "other" })).toEqual({
				accepted: false,
				reason: "forbidden",
			});
		},
	);
	it("expires at the deadline", () => {
		now = 2_000;
		expect(gate.decide(command)).toEqual({
			accepted: false,
			reason: "expired",
		});
	});
	it("does not buffer early or late decisions for the next checkpoint", () => {
		gate.close();
		expect(gate.decide(command).accepted).toBe(false);
		gate.open(1_000, true);
		expect(gate.decide(command).accepted).toBe(false);
		expect(state.approvalDecision).toBeNull();
	});
	it("rejects after cancellation", () => {
		state.cancelled = true;
		expect(gate.decide(command).accepted).toBe(false);
	});
	it("never satisfies an explicit authority checkpoint with approve-all", () => {
		gate.autoApprove();
		expect(state.approvalDecision).toBeNull();
		expect(gate.decide(command).accepted).toBe(true);
	});
	it("permits approve-all for plan checkpoints, once", () => {
		gate.open(1_000, false);
		gate.autoApprove();
		expect(state.approvalDecision?.approved).toBe(true);
		expect(
			gate.decide({
				...command,
				requestId: state.pendingApproval?.requestId ?? "",
			}),
		).toEqual({ accepted: false, reason: "decided" });
	});
});

it("records one authoritative approval history entry independent of HTTP receipt delivery", () => {
	expect(gate.decide(command).accepted).toBe(true);
	expect(gate.decide(command).accepted).toBe(false);
	expect(state.approvalHistory).toEqual([
		expect.objectContaining({
			approvalId: command.approvalId,
			stepId: "step-1",
			approved: true,
			requestedAt: new Date(1000).toISOString(),
			decidedAt: new Date(1000).toISOString(),
		}),
	]);
});
