import { describe, expect, it } from "vitest";
import {
	getPendingDecisionsIntegrationClause,
	PENDING_DECISIONS_HEADING,
} from "../src/core/pending-decisions-integration";

describe("getPendingDecisionsIntegrationClause", () => {
	it("references the canonical appendix heading", () => {
		const clause = getPendingDecisionsIntegrationClause();
		expect(clause).toContain(PENDING_DECISIONS_HEADING);
		expect(PENDING_DECISIONS_HEADING).toBe(
			"## Resolved Decisions (pending integration)",
		);
	});

	it("instructs the model to integrate, not re-ask, and prune", () => {
		const clause = getPendingDecisionsIntegrationClause();
		// Integrate settled decisions...
		expect(clause).toMatch(/integrate/i);
		// ...never re-ask them (the bug this clause fixes on the agent path)...
		expect(clause).toMatch(/do not re-ask|re-open|re-list/i);
		// ...and delete the appendix afterward.
		expect(clause).toMatch(/delete/i);
		// Non-goals route to a constraints section.
		expect(clause).toMatch(/Out of Scope \/ Constraints/);
	});

	it("survives rebuild-from-scratch stages (Sanity Check / Draft)", () => {
		const clause = getPendingDecisionsIntegrationClause();
		// Decisions must persist even when a later stage rebuilds the doc and
		// "treats prior artifacts as inputs only" — they must not be dropped.
		expect(clause).toMatch(/authoritative/i);
		expect(clause).toMatch(/rebuild|restructur/i);
		expect(clause).toMatch(/never drop/i);
	});

	it("is a non-empty string safe to concatenate verbatim", () => {
		const clause = getPendingDecisionsIntegrationClause();
		expect(typeof clause).toBe("string");
		expect(clause.trim().length).toBeGreaterThan(0);
	});
});
