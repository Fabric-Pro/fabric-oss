import { normalizeDocumentType } from "@repo/agent-types";
import { describe, expect, it } from "vitest";
import { getDocumentPrompt } from "../index";

describe("srs prompt", () => {
	it("resolves the dedicated config, not the general fallback", () => {
		const config = getDocumentPrompt("srs");
		expect(config.id).toBe("srs");
		expect(config.name).toMatch(/software requirements specification/i);
	});

	it("requires the baseline requirements-specification sections", () => {
		const config = getDocumentPrompt("srs");
		const required = config.sections
			.filter((s) => s.required)
			.map((s) => s.name);
		expect(required).toContain("Introduction & Purpose");
		expect(required).toContain("Scope");
		expect(required).toContain("Functional Requirements");
		expect(required).toContain("Non-Functional Requirements");
		expect(required).toContain("External Interface Requirements");
		expect(required).toContain("Constraints & Assumptions");
		expect(required).toContain("Acceptance Criteria & Verification");
	});

	it("offers a non-required Open Issues & TBDs section for unresolved requirements", () => {
		const config = getDocumentPrompt("srs");
		const openIssues = config.sections.find(
			(s) => s.name === "Open Issues & TBDs",
		);
		expect(openIssues).toBeDefined();
		expect(openIssues?.required).toBe(false);
		expect(openIssues?.semanticGroup).toBe("gaps");
	});

	it("guides requirements to be uniquely identified and verifiable", () => {
		const config = getDocumentPrompt("srs");
		const functional = config.sections.find(
			(s) => s.name === "Functional Requirements",
		);
		expect(functional?.guidance).toMatch(/FR-/);
		expect(functional?.guidance).toMatch(/shall/i);

		const nonFunctional = config.sections.find(
			(s) => s.name === "Non-Functional Requirements",
		);
		expect(nonFunctional?.guidance).toMatch(/NFR-/);
		// Every NFR must carry a measurable target rather than a vague adjective.
		expect(nonFunctional?.guidance).toMatch(/measurable|target/i);
	});

	it("keeps the document at requirements altitude, not design", () => {
		const config = getDocumentPrompt("srs");
		expect(config.persona).toMatch(
			/never HOW|not HOW|WHAT the system must do/i,
		);
		const joined = config.antiPatterns.join(" ").toLowerCase();
		expect(joined).toMatch(/implementation|design/);
		expect(joined).toMatch(/unverifiable|verifiable/);
	});

	it("normalizes SRS -> srs", () => {
		expect(normalizeDocumentType("SRS")).toBe("srs");
	});
});
