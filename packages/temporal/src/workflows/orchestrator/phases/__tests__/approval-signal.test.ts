/**
 * An `approval` signal is the person's answer to one card. Kept by the
 * workflow until the next wait consumes it, an answer that arrives when no
 * card is up would approve the next request unseen, so only an answer to the
 * pending approval counts.
 */
import { describe, expect, it } from "vitest";
import {
	approvalSignalAnswersPending,
	resolveApprovalWait,
} from "../approval-signal";

const pending = { approvalId: "authority-sess-run-call-3" };

describe("approvalSignalAnswersPending", () => {
	it("takes the answer to the pending approval", () => {
		expect(
			approvalSignalAnswersPending(pending, {
				approvalId: "authority-sess-run-call-3",
			}),
		).toBe(true);
	});

	it("drops an answer that arrives when nothing is pending, so it cannot approve the next request", () => {
		expect(
			approvalSignalAnswersPending(null, {
				approvalId: "authority-sess-create-call-1",
			}),
		).toBe(false);
		expect(approvalSignalAnswersPending(null, {})).toBe(false);
	});

	it("drops a late answer to an earlier approval while a newer one is pending", () => {
		expect(
			approvalSignalAnswersPending(pending, {
				approvalId: "authority-sess-create-call-1",
			}),
		).toBe(false);
	});

	it("takes an answer that names no approval as the answer to the pending one", () => {
		expect(approvalSignalAnswersPending(pending, {})).toBe(true);
	});
});

describe("resolveApprovalWait", () => {
	const autoApproval = {
		approved: true,
		feedback: "Auto-approved (approve all)",
	};

	it("keeps waiting while there is no answer and approve-all is off", () => {
		for (const requireExplicitDecision of [false, true]) {
			expect(
				resolveApprovalWait({
					decision: null,
					autoApproveAll: false,
					requireExplicitDecision,
				}),
			).toBeNull();
		}
	});

	it("never lets approve-all settle a checkpoint that requires an explicit decision", () => {
		expect(
			resolveApprovalWait({
				decision: null,
				autoApproveAll: true,
				requireExplicitDecision: true,
			}),
		).toBeNull();
	});

	it("settles an ordinary checkpoint with approve-all, including when it arrives mid-wait", () => {
		const input = {
			decision: null,
			autoApproveAll: false,
			requireExplicitDecision: false,
		};
		expect(resolveApprovalWait(input)).toBeNull();
		input.autoApproveAll = true;
		expect(resolveApprovalWait(input)).toEqual(autoApproval);
	});

	it("takes the person's answer over approve-all", () => {
		const rejection = {
			approved: false,
			feedback: "No",
			approvalId: "authority-sess-run-call-3",
		};
		for (const requireExplicitDecision of [false, true]) {
			expect(
				resolveApprovalWait({
					decision: rejection,
					autoApproveAll: true,
					requireExplicitDecision,
				}),
			).toBe(rejection);
		}
	});
});
