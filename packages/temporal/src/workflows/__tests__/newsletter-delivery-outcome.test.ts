import { describe, expect, it } from "vitest";
import { computeDeliveryOutcome } from "../newsletter-delivery-outcome";

const email0 = {
	attempted: false,
	errored: false,
	recipientCount: 0,
	sentCount: 0,
	failedCount: 0,
};
const chat0 = {
	attempted: false,
	errored: false,
	targetCount: 0,
	sentCount: 0,
	failedCount: 0,
	skippedCount: 0,
};

describe("computeDeliveryOutcome", () => {
	it("EMAIL-only, no subscribers → SKIPPED_EMPTY/NO_SUBSCRIBERS", () => {
		expect(
			computeDeliveryOutcome({
				wantEmail: true,
				wantChat: false,
				email: email0,
				chat: chat0,
			}),
		).toEqual({
			status: "SKIPPED_EMPTY",
			skipReason: "NO_SUBSCRIBERS",
			advanceLastSentAt: false,
		});
	});
	it("CHAT-only, no targets → SKIPPED_EMPTY/NO_CHAT_TARGETS", () => {
		expect(
			computeDeliveryOutcome({
				wantEmail: false,
				wantChat: true,
				email: email0,
				chat: chat0,
			}),
		).toEqual({
			status: "SKIPPED_EMPTY",
			skipReason: "NO_CHAT_TARGETS",
			advanceLastSentAt: false,
		});
	});
	it("CHAT-only, all posted → SENT + advance", () => {
		expect(
			computeDeliveryOutcome({
				wantEmail: false,
				wantChat: true,
				email: email0,
				chat: {
					...chat0,
					attempted: true,
					targetCount: 2,
					sentCount: 2,
				},
			}),
		).toEqual({
			status: "SENT",
			skipReason: null,
			advanceLastSentAt: true,
		});
	});
	it("BOTH, email sent, chat all failed → PARTIAL + advance", () => {
		expect(
			computeDeliveryOutcome({
				wantEmail: true,
				wantChat: true,
				email: {
					...email0,
					attempted: true,
					recipientCount: 3,
					sentCount: 3,
				},
				chat: {
					...chat0,
					attempted: true,
					targetCount: 2,
					failedCount: 2,
				},
			}),
		).toEqual({
			status: "PARTIAL",
			skipReason: null,
			advanceLastSentAt: true,
		});
	});
	it("F1: email activity THREW (errored) + chat sent → PARTIAL, never SENT", () => {
		expect(
			computeDeliveryOutcome({
				wantEmail: true,
				wantChat: true,
				email: {
					...email0,
					attempted: true,
					errored: true,
					recipientCount: 3,
					sentCount: 0,
					failedCount: 3,
				},
				chat: {
					...chat0,
					attempted: true,
					targetCount: 1,
					sentCount: 1,
				},
			}),
		).toEqual({
			status: "PARTIAL",
			skipReason: null,
			advanceLastSentAt: true,
		});
	});
	it("BOTH, everything failed → FAILED, no advance", () => {
		expect(
			computeDeliveryOutcome({
				wantEmail: true,
				wantChat: true,
				email: {
					...email0,
					attempted: true,
					recipientCount: 2,
					failedCount: 2,
				},
				chat: { ...chat0, attempted: true, errored: true },
			}),
		).toEqual({
			status: "FAILED",
			skipReason: null,
			advanceLastSentAt: false,
		});
	});
});
