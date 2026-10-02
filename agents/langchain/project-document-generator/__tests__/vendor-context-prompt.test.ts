/**
 * Company context (Fizzy #2719) reaches this agent as vendor-marked entries in
 * `ragContexts`. The agent's prompt drops the project's wizard features when
 * retrieved context exists, because that context defines the product — but
 * vendor material describes the organization writing the document, not this
 * product, so a project with no context of its own keeps its features.
 */

import { VENDOR_CONTEXT_MARKER } from "@repo/agent-types";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../prompts";

const PROJECT_CONTEXT = {
	name: "Warehouse modernization",
	techStack: ["React", "Node.js"],
	features: ["Barcode scanning"],
};

const VENDOR_ENTRY = `${VENDOR_CONTEXT_MARKER}\n[Source: Case study]\nWe rolled out scanning at a regional distributor.`;

describe("agent prompt with company context", () => {
	it("keeps the wizard features when only vendor entries were retrieved", () => {
		const prompt = buildSystemPrompt(
			undefined,
			"proposal",
			PROJECT_CONTEXT,
			[VENDOR_ENTRY],
			undefined,
		);

		expect(prompt).toContain("**Key Features:**");
		expect(prompt).toContain(VENDOR_CONTEXT_MARKER);
	});

	it("drops the wizard features when the project has context of its own", () => {
		const prompt = buildSystemPrompt(
			undefined,
			"proposal",
			PROJECT_CONTEXT,
			["The client picks orders on paper.", VENDOR_ENTRY],
			undefined,
		);

		expect(prompt).not.toContain("**Key Features:**");
	});
});
