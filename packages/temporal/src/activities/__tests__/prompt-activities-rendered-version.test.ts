/**
 * Fizzy #2807: a regenerated Proposal's version history read "Prompt: … v3"
 * although the run rendered the prompt's newest version. Both renderers render
 * the newest version of the prompt they resolve, so the version they report
 * has to be that one — never the version a binding happens to pin, which is
 * months older when the same prompt is also bound at a second tier.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { promptQueries } = vi.hoisted(() => ({
	promptQueries: {
		getPromptById: vi.fn(),
		getBoundPromptForAgent: vi.fn(),
		incrementPromptUsage: vi.fn(),
	},
}));

vi.mock("@repo/database/prisma/queries/prompts", () => promptQueries);

const { renderPromptWithContext, fetchAndRenderPrompt } = await import(
	"../prompt-activities"
);

const CURRENT = "Write the client-facing proposal.";
const OLDER = "Write the proposal with internal notes first.";

beforeEach(() => {
	vi.clearAllMocks();
	promptQueries.getPromptById.mockResolvedValue({
		id: "prompt_proposal",
		format: "MARKDOWN",
		// Ordered version-desc, as the query returns them.
		versions: [
			{ id: "pv_9", version: 9, content: CURRENT },
			{ id: "pv_3", version: 3, content: OLDER },
		],
	});
	promptQueries.incrementPromptUsage.mockResolvedValue(undefined);
	// The binding in force pins an older version than the prompt's newest.
	promptQueries.getBoundPromptForAgent.mockResolvedValue({
		id: "prompt_proposal",
		name: "Project Proposal Document",
		scope: "SYSTEM",
		format: "MARKDOWN",
		version: { id: "pv_3", version: 3, content: OLDER, variables: null },
	});
});

describe("renderPromptWithContext", () => {
	it("reports the id of the version it rendered", async () => {
		const result = await renderPromptWithContext({
			promptId: "prompt_proposal",
		});

		expect(result.rendered).toContain(CURRENT);
		expect(result.version).toBe(9);
		expect(result.versionId).toBe("pv_9");
	});
});

describe("fetchAndRenderPrompt", () => {
	it("attributes the run to the version it rendered, not the binding's pin", async () => {
		const result = await fetchAndRenderPrompt({
			agentName: "project_document_generator",
			userId: "user_1",
			organizationId: "org_example",
			documentType: "PROPOSAL",
		});

		expect(result?.rendered).toContain(CURRENT);
		expect(result?.rendered).not.toContain(OLDER);
		expect(result?.promptVersionId).toBe("pv_9");
	});
});
