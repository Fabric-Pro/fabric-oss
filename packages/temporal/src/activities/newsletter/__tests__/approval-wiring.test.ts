import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW = readFileSync(
	join(__dirname, "../../../workflows/generate-and-send-newsletter.ts"),
	"utf8",
);
const ACTIVITIES_INDEX = readFileSync(
	join(__dirname, "../../index.ts"),
	"utf8",
);

describe("approval-gate wiring (Fizzy 1869, static scan)", () => {
	it("registers holdNewsletterForApprovalActivity in the top-level named export block", () => {
		expect(ACTIVITIES_INDEX).toContain("holdNewsletterForApprovalActivity");
	});

	it("gates the park branch behind the newsletter-approval-gate-2026-07-09 patch", () => {
		expect(WORKFLOW).toContain(
			'patched("newsletter-approval-gate-2026-07-09")',
		);
	});

	it("invokes the hold activity", () => {
		expect(WORKFLOW).toContain("holdNewsletterForApprovalActivity(");
	});

	it("registers sendNewsletterApprovalEmailsActivity in the top-level named export block", () => {
		expect(ACTIVITIES_INDEX).toContain(
			"sendNewsletterApprovalEmailsActivity",
		);
	});

	it("gates the reviewer email behind its own patch, after the hold", () => {
		// Its own gate so pre-patch histories replay the hold-only sequence.
		expect(WORKFLOW).toContain(
			'patched("newsletter-approval-email-2026-08-10")',
		);
		const holdIdx = WORKFLOW.indexOf("holdNewsletterForApprovalActivity(");
		const mailIdx = WORKFLOW.indexOf(
			"sendNewsletterApprovalEmailsActivity({",
		);
		expect(holdIdx).toBeGreaterThan(-1);
		expect(mailIdx).toBeGreaterThan(holdIdx);
	});
	// That a thrown reviewer email does NOT reach the outer catch — which
	// finalizes the send as FAILED and would kill a reviewable draft — is proven
	// behaviourally in workflows/__tests__/newsletter-approval-email.test.ts. A
	// source scan can find a `try {` before the call but cannot show the
	// matching catch encloses it.

	it("places the park branch after the hasMajorFeatures guard and before the chat-delivery patch check", () => {
		const hasMajorFeaturesIdx = WORKFLOW.indexOf(
			"if (!content.hasMajorFeatures)",
		);
		const approvalGateIdx = WORKFLOW.indexOf(
			'patched("newsletter-approval-gate-2026-07-09")',
		);
		const chatDeliveryIdx = WORKFLOW.indexOf(
			'patched("newsletter-chat-delivery-2026-07-08")',
		);
		expect(hasMajorFeaturesIdx).toBeGreaterThan(-1);
		expect(approvalGateIdx).toBeGreaterThan(-1);
		expect(chatDeliveryIdx).toBeGreaterThan(-1);
		expect(approvalGateIdx).toBeGreaterThan(hasMajorFeaturesIdx);
		expect(chatDeliveryIdx).toBeGreaterThan(approvalGateIdx);
	});
});
