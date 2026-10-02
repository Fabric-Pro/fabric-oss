/**
 * Both prompt renderers decide whether to show the project's wizard features
 * from the retrieved context: retrieved context defines the product, so the
 * features line drops out when there is any. Company context (Fizzy #2719)
 * arrives in the same list, marked as vendor material — it describes the
 * organization writing the document, not this product, so it must not push
 * the features out. A project with no context of its own keeps them.
 */

import { VENDOR_CONTEXT_MARKER } from "@repo/agent-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { promptQueries } = vi.hoisted(() => ({
	promptQueries: {
		getPromptById: vi.fn(),
		getPromptByKey: vi.fn(),
		incrementPromptUsage: vi.fn(),
	},
}));

vi.mock("@repo/database/prisma/queries/prompts", () => promptQueries);

const { renderPromptWithContext, fetchAndRenderPromptByKey } = await import(
	"../prompt-activities"
);

const PROMPT = {
	id: "prompt_1",
	format: "MARKDOWN",
	versions: [{ version: 3, content: "Write the proposal." }],
};

const PROJECT_CONTEXT = {
	name: "Warehouse modernization",
	description: "Replace paper-based picking.",
	techStack: ["React"],
	features: ["Barcode scanning", "Pick-path optimization"],
};

const FEATURES_LINE = "- Features: Barcode scanning, Pick-path optimization";

const VENDOR_ENTRY = `${VENDOR_CONTEXT_MARKER}\n[Source: Case study]\nWe rolled out scanning at a regional distributor.`;
const PROJECT_ENTRY = "The client picks 4,000 orders a day on paper.";

beforeEach(() => {
	vi.clearAllMocks();
	promptQueries.getPromptById.mockResolvedValue(PROMPT);
	promptQueries.getPromptByKey.mockResolvedValue(PROMPT);
	promptQueries.incrementPromptUsage.mockResolvedValue(undefined);
});

const renderers = [
	[
		"renderPromptWithContext",
		(ragContexts: string[]) =>
			renderPromptWithContext({
				promptId: "prompt_1",
				projectContext: PROJECT_CONTEXT,
				ragContexts,
			}).then((result) => result.rendered),
	],
	[
		"fetchAndRenderPromptByKey",
		(ragContexts: string[]) =>
			fetchAndRenderPromptByKey({
				promptKey: "proposal_template",
				userId: "user_1",
				organizationId: "org_example",
				projectContext: PROJECT_CONTEXT,
				ragContexts,
			}).then((result) => result?.rendered ?? ""),
	],
] as const;

describe.each(renderers)("%s", (_name, render) => {
	it("keeps the wizard features when only vendor entries were retrieved", async () => {
		const rendered = await render([VENDOR_ENTRY]);

		expect(rendered).toContain(FEATURES_LINE);
		// The vendor material still reaches the prompt, labeled.
		expect(rendered).toContain(VENDOR_CONTEXT_MARKER);
		expect(rendered).toContain(
			"We rolled out scanning at a regional distributor.",
		);
	});

	it("drops the wizard features when the project has context of its own", async () => {
		const rendered = await render([PROJECT_ENTRY, VENDOR_ENTRY]);

		expect(rendered).not.toContain(FEATURES_LINE);
		expect(rendered).toContain(PROJECT_ENTRY);
		expect(rendered).toContain(VENDOR_CONTEXT_MARKER);
	});

	it("keeps the wizard features with no retrieved context at all, as before", async () => {
		const rendered = await render([]);

		expect(rendered).toContain(FEATURES_LINE);
		expect(rendered).not.toContain("## Retrieved Context");
	});
});
