import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW = readFileSync(
	join(__dirname, "../../../workflows/send-approved-newsletter.ts"),
	"utf8",
);
const WORKFLOWS_INDEX = readFileSync(
	join(__dirname, "../../../workflows/index.ts"),
	"utf8",
);
const ACTIVITIES_INDEX = readFileSync(
	join(__dirname, "../../index.ts"),
	"utf8",
);

describe("send-approved-newsletter wiring (Fizzy 1869, static scan)", () => {
	it("exports sendApprovedNewsletterWorkflow from the workflows barrel", () => {
		expect(WORKFLOWS_INDEX).toContain("sendApprovedNewsletterWorkflow");
		expect(WORKFLOWS_INDEX).toContain("./send-approved-newsletter");
	});

	it("registers loadApprovedNewsletterSendActivity in the top-level named export block", () => {
		expect(ACTIVITIES_INDEX).toContain(
			"loadApprovedNewsletterSendActivity",
		);
	});

	it('uses expectStatus: "APPROVED" on every finalizeNewsletterSendActivity call', () => {
		const calls: string[] = [];
		let searchFrom = 0;
		while (true) {
			const callIdx = WORKFLOW.indexOf(
				"finalizeNewsletterSendActivity(",
				searchFrom,
			);
			if (callIdx === -1) {
				break;
			}
			const openParenIdx =
				callIdx + "finalizeNewsletterSendActivity(".length;
			// Find the matching closing paren by depth-tracking (the call body
			// itself contains nested braces/parens).
			let depth = 1;
			let i = openParenIdx;
			for (; i < WORKFLOW.length && depth > 0; i++) {
				if (WORKFLOW[i] === "(") {
					depth++;
				} else if (WORKFLOW[i] === ")") {
					depth--;
				}
			}
			const body = WORKFLOW.slice(openParenIdx, i);
			calls.push(body);
			searchFrom = i;
		}
		expect(calls.length).toBeGreaterThan(0);
		for (const body of calls) {
			expect(body).toContain('expectStatus: "APPROVED"');
		}
	});

	it('contains an outer catch that finalizes status: "FAILED" (recovery path)', () => {
		expect(WORKFLOW).toContain("} catch (error) {");
		expect(WORKFLOW).toContain('status: "FAILED"');
	});

	it('guards the outer-catch finalize with expectStatus: "APPROVED" too', () => {
		const catchIdx = WORKFLOW.indexOf("} catch (error) {");
		expect(catchIdx).toBeGreaterThan(-1);
		const tail = WORKFLOW.slice(catchIdx);
		expect(tail).toContain('status: "FAILED"');
		expect(tail).toContain('expectStatus: "APPROVED"');
	});
});
