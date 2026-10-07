/**
 * The up-front clarity gate knows the organization (Fizzy #2719).
 *
 * An Advisor turn that may search the organization's company context still
 * asked "Which company should I describe?" for "our company": the gate saw
 * only the message, the conversation and the attached project. It now gets
 * the line the preload built for that turn, behind
 * `orchestrator-clarity-organization-context-v1`. The marker is asked only
 * when the preload offered company context, so every other turn records none
 * and sends exactly the input it always did (no `organizationContext` key).
 *
 * Read as source, as clarity-project-context-wiring.test.ts does: importing a
 * workflow module pulls in the Temporal sandbox machinery.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
	join(process.cwd(), "src/workflows/orchestrator/index.ts"),
	"utf-8",
);

describe("clarity organization context — workflow wiring", () => {
	it("takes the line the preload built for the turn", () => {
		expect(workflow).toMatch(
			/const companyContextHint =\s*state\.preloadedResources\?\.companyContext\?\.hint;/,
		);
	});

	it("asks the marker only when there is a line to send and a loop that can search", () => {
		expect(workflow).toMatch(
			/const clarityOrganizationContext =\s*companyContextHint &&\s*usesIterativeExecution\(input\.executionMode\) &&\s*patched\("orchestrator-clarity-organization-context-v1"\)\s*\?\s*companyContextHint\s*:\s*undefined;/,
		);
	});

	it("adds organizationContext only when set (other turns' input has no such key)", () => {
		expect(workflow).toMatch(
			/\.\.\.\(clarityOrganizationContext\s*\?\s*\{ organizationContext: clarityOrganizationContext \}\s*:\s*\{\}\)/,
		);
		expect(workflow).not.toMatch(
			/^\s*organizationContext: companyContextHint/m,
		);
	});

	it("is sent by the up-front gate only, not by the per-step checks of a plan", () => {
		expect(workflow.match(/organizationContext:/g)).toHaveLength(1);
	});
});
