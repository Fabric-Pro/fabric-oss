/**
 * Finding-driven revision of one Proposal section (Fizzy #2946): a mocked
 * model answers, and the real placeholder, structure and echo checks judge
 * it. The splice is checked against the real section map.
 */

import {
	buildSectionMap,
	findSection,
} from "@repo/utils/proposal-artifact/section-hash";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	generateText: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	trackUsage: vi.fn(),
	logInfo: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class AIProviderNotConfiguredError extends Error {},
	generateText: mocks.generateText,
	getAIModelWithMetadata: mocks.getAIModelWithMetadata,
}));
vi.mock("@repo/logs", () => ({
	logger: {
		info: mocks.logInfo,
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));
// The settled-decisions module is imported for its pure join only; its
// database reads never run here.
vi.mock("@repo/database", () => ({}));

const {
	locateSectionTarget,
	reviseProposalSection,
	sectionBody,
	spliceSectionBody,
} = await import("../revise-section");
const { AIProviderNotConfiguredError } = await import("@repo/ai");

const DIAGRAM = [
	"```mermaid",
	"%% fabric-visual: k3v9q2m7x1a8c4d6",
	"flowchart TD",
	'  s0["Discovery"] --> s1["Build"]',
	"```",
].join("\n");
const SLOT =
	'<visual-slot data-slot-id="slot-1" data-kind="timeline"></visual-slot>';

const DOCUMENT = [
	"# Example Proposal",
	"",
	"## 1. Executive Summary",
	"",
	"We propose a pilot for Example Org.",
	"",
	"## 2. Scope",
	"",
	"The pilot covers the data migration.",
	"",
	"### 2.1 Out of Scope",
	"",
	"Hardware purchases are out of scope.",
	"",
	"## 3. Team",
	"",
	"A delivery lead and two engineers.",
	"",
	"## 4. Approach",
	"",
	"We start with discovery, agree the plan with the client team, and then build the platform in two phases.",
	"",
	DIAGRAM,
	"",
	SLOT,
	"",
	"The rollout follows in Q3 2026.",
	"",
	"## 5. Pricing",
	"",
	"A fixed fee of 40k.",
	"",
].join("\n");

const APPROACH_KEY = (() => {
	const section = buildSectionMap(DOCUMENT).sections.find(
		(entry) => entry.headingText === "4. Approach",
	);
	if (!section) {
		throw new Error("fixture has no Approach section");
	}
	return section.key;
})();

const INSTRUCTION =
	"State that the discovery phase takes two weeks and ends with a written plan.";
const TOKEN_1 = "<<<FABRIC_VISUAL_1>>>";
const TOKEN_2 = "<<<FABRIC_VISUAL_2>>>";

function input(overrides: Record<string, unknown> = {}) {
	return {
		organizationId: "org-1",
		projectId: "project-1",
		userId: "user-1",
		documentContent: DOCUMENT,
		sectionKey: APPROACH_KEY,
		instruction: INSTRUCTION,
		promptText: "Write for external readers.",
		settledBlock: null,
		carried: { responseTexts: [], findingTitles: [] },
		internalInstruction: true as const,
		...overrides,
	};
}

function modelWrites(...texts: string[]) {
	for (const text of texts) {
		mocks.generateText.mockResolvedValueOnce({
			text,
			finishReason: "stop",
			usage: {},
		});
	}
}

const REVISED = [
	"We start with a two-week discovery phase that ends in a written plan, and then build.",
	"",
	TOKEN_1,
	"",
	TOKEN_2,
	"",
	"The rollout follows in Q3 2026.",
].join("\n");

/** Every section's own text but the target's, by key. */
function otherSections(markdown: string, except: string): string[] {
	const lines = markdown.split("\n");
	return buildSectionMap(markdown)
		.sections.filter((section) => section.key !== except)
		.map(
			(section) =>
				`${section.key}\n${lines.slice(section.startLine - 1, section.endLine).join("\n")}`,
		);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: { provider: "OPENAI" },
		trackUsage: mocks.trackUsage,
	});
});

describe("reviseProposalSection", () => {
	it("returns a candidate for section 4 that leaves every other section byte-identical when spliced", async () => {
		modelWrites(REVISED);

		const result = await reviseProposalSection(input());

		expect(result.status).toBe("CANDIDATE");
		if (result.status !== "CANDIDATE") {
			return;
		}
		expect(result.body).not.toMatch(/^#/m);
		const spliced = spliceSectionBody(DOCUMENT, APPROACH_KEY, result.body);
		expect(spliced).not.toBeNull();
		expect(otherSections(spliced as string, APPROACH_KEY)).toEqual(
			otherSections(DOCUMENT, APPROACH_KEY),
		);
		expect(spliced).toContain("## 4. Approach\n\nWe start with a two-week");
		const before = findSection(buildSectionMap(DOCUMENT), APPROACH_KEY);
		const after = findSection(
			buildSectionMap(spliced as string),
			APPROACH_KEY,
		);
		expect(after?.proseHash).not.toBe(before?.proseHash);
		expect(mocks.trackUsage).toHaveBeenCalledTimes(1);
	});

	it("sends the diagram and the visual slot as placeholders and restores them byte for byte", async () => {
		modelWrites(REVISED);

		const result = await reviseProposalSection(input());

		const { prompt } = mocks.generateText.mock.calls[0][0];
		expect(prompt).toContain(TOKEN_1);
		expect(prompt).toContain(TOKEN_2);
		const target = prompt.slice(
			prompt.indexOf("<target_section>"),
			prompt.indexOf("</target_section>"),
		);
		expect(target).not.toContain("flowchart");
		expect(target).not.toContain("visual-slot");
		expect(target).not.toContain("## 4. Approach");
		expect(result).toEqual({
			status: "CANDIDATE",
			body: [
				"We start with a two-week discovery phase that ends in a written plan, and then build.",
				"",
				DIAGRAM,
				"",
				SLOT,
				"",
				"The rollout follows in Q3 2026.",
			].join("\n"),
		});
	});

	it("labels the instruction internal guidance and keeps it out of the system text", async () => {
		modelWrites(REVISED);

		await reviseProposalSection(
			input({ settledBlock: "<<<FABRIC_SETTLED_DECISIONS>>>\n- x" }),
		);

		const { instructions, prompt } = mocks.generateText.mock.calls[0][0];
		expect(prompt).toContain(`<internal_guidance>\n${INSTRUCTION}`);
		expect(prompt).toContain(DOCUMENT.trimEnd());
		expect(instructions).not.toContain(INSTRUCTION);
		expect(instructions.startsWith("Write for external readers.")).toBe(
			true,
		);
		expect(instructions).toContain("Never quote it");
		expect(
			instructions.endsWith("<<<FABRIC_SETTLED_DECISIONS>>>\n- x"),
		).toBe(true);
	});

	it("refuses an output that drops a placeholder after one retry", async () => {
		const dropped = REVISED.replace(`${TOKEN_1}\n\n`, "");
		modelWrites(dropped, dropped);

		const result = await reviseProposalSection(input());

		expect(result).toEqual({ status: "INVALID_CANDIDATE" });
		expect(mocks.generateText).toHaveBeenCalledTimes(2);
		expect(mocks.generateText.mock.calls[1][0].prompt).toContain(
			"dropped a placeholder",
		);
		expect(mocks.trackUsage).toHaveBeenCalledTimes(1);
	});

	it("refuses an output that adds a heading, setext included", async () => {
		modelWrites(
			`${REVISED}\n\n### 4.1 Discovery\n\nTwo weeks.`,
			`${REVISED}\n\nDiscovery\n---------\n\nTwo weeks.`,
		);

		const result = await reviseProposalSection(input());

		expect(result).toEqual({ status: "INVALID_CANDIDATE" });
		expect(mocks.generateText.mock.calls[1][0].prompt).toContain(
			"added a heading",
		);
	});

	it("accepts a heading-shaped line inside a fence", async () => {
		modelWrites(`${REVISED}\n\n\`\`\`text\n# not a heading\n\`\`\``);

		const result = await reviseProposalSection(input());

		expect(result.status).toBe("CANDIDATE");
	});

	it("refuses a repeated or inline placeholder", async () => {
		modelWrites(
			`${REVISED}\n\n${TOKEN_1}`,
			REVISED.replace(`\n\n${TOKEN_2}`, ` ${TOKEN_2}`),
		);

		const result = await reviseProposalSection(input());

		expect(result).toEqual({ status: "INVALID_CANDIDATE" });
	});

	it("refuses a placeholder the section never held", async () => {
		const invented = `${REVISED}\n\n<<<FABRIC_VISUAL_3>>>`;
		modelWrites(invented, invented);

		const result = await reviseProposalSection(input());

		expect(result).toEqual({ status: "INVALID_CANDIDATE" });
		expect(mocks.generateText.mock.calls[1][0].prompt).toContain(
			"added a placeholder that was not in the section",
		);
	});

	it("holds an unclosed diagram fence through the end of the section", async () => {
		const unclosed = DOCUMENT.replace(
			"## 5. Pricing\n\nA fixed fee of 40k.\n",
			"## 5. Pricing\n\nA fixed fee of 40k.\n\n```mermaid\nflowchart TD\n  a --> b\n",
		);
		const pricingKey = buildSectionMap(unclosed).sections.find(
			(entry) => entry.headingText === "5. Pricing",
		)?.key;
		modelWrites(`A fixed fee of 45k.\n\n${TOKEN_1}`);

		const result = await reviseProposalSection(
			input({ documentContent: unclosed, sectionKey: pricingKey }),
		);

		const { prompt } = mocks.generateText.mock.calls[0][0];
		const target = prompt.slice(
			prompt.indexOf("<target_section>"),
			prompt.indexOf("</target_section>"),
		);
		expect(target).toContain(TOKEN_1);
		expect(target).not.toContain("flowchart");
		expect(result).toEqual({
			status: "CANDIDATE",
			body: expect.stringContaining(
				"A fixed fee of 45k.\n\n```mermaid\nflowchart TD\n  a --> b",
			),
		});
	});

	it("succeeds on the retry after a refused first answer", async () => {
		modelWrites(REVISED.replace(TOKEN_2, ""), REVISED);

		const result = await reviseProposalSection(input());

		expect(result.status).toBe("CANDIDATE");
		expect(mocks.generateText).toHaveBeenCalledTimes(2);
	});

	it("refuses a truncated answer without a retry", async () => {
		mocks.generateText.mockResolvedValueOnce({
			text: REVISED,
			finishReason: "length",
			usage: {},
		});

		const result = await reviseProposalSection(input());

		expect(result).toEqual({ status: "INVALID_CANDIDATE" });
		expect(mocks.generateText).toHaveBeenCalledTimes(1);
	});

	it("refuses an answer far longer than the section", async () => {
		modelWrites(
			`${REVISED}\n\n${"More text. ".repeat(400)}`,
			`${REVISED}\n\n${"More text. ".repeat(400)}`,
		);

		const result = await reviseProposalSection(input());

		expect(result).toEqual({ status: "INVALID_CANDIDATE" });
	});

	it("answers RESPONSE_ECHOED when the candidate repeats a carried answer, after one retry", async () => {
		const answer =
			"The client agreed that discovery runs for exactly two weeks and finishes with a signed written plan.";
		const echoing = REVISED.replace(
			"We start with a two-week discovery phase that ends in a written plan, and then build.",
			`${answer} Then we build.`,
		);
		modelWrites(echoing, echoing);

		const result = await reviseProposalSection(
			input({ carried: { responseTexts: [answer], findingTitles: [] } }),
		);

		expect(result).toEqual({ status: "RESPONSE_ECHOED" });
		expect(mocks.generateText.mock.calls[1][0].prompt).toContain(
			"in your own words",
		);
		const logged = JSON.stringify(mocks.logInfo.mock.calls);
		expect(logged).not.toContain("signed written plan");
	});

	it("answers RESPONSE_ECHOED for a 12-word run of the recommendation", async () => {
		const recommendation =
			"Explain that the discovery phase lasts two weeks and closes with a written delivery plan for approval";
		const echoing = REVISED.replace(
			"We start with a two-week discovery phase that ends in a written plan, and then build.",
			"We explain that the discovery phase lasts two weeks and closes with a written delivery plan for approval.",
		);
		modelWrites(echoing, echoing);

		const result = await reviseProposalSection(
			input({
				instruction: recommendation,
				carried: {
					responseTexts: [],
					findingTitles: ["Discovery length unclear", recommendation],
				},
			}),
		);

		expect(result).toEqual({ status: "RESPONSE_ECHOED" });
	});

	it("does not count a run the document already holds as an echo", async () => {
		const kept =
			"We start with discovery, agree the plan with the client team, and then build the platform in two phases.";
		const carried = { responseTexts: [kept], findingTitles: [] };
		modelWrites(REVISED.replace("The rollout follows in Q3 2026.", kept));

		const result = await reviseProposalSection(input({ carried }));

		expect(result.status).toBe("CANDIDATE");
	});

	it("answers AI_PROVIDER_NOT_CONFIGURED without a model call", async () => {
		mocks.getAIModelWithMetadata.mockRejectedValueOnce(
			new AIProviderNotConfiguredError("not configured"),
		);

		const result = await reviseProposalSection(input());

		expect(result).toEqual({ status: "AI_PROVIDER_NOT_CONFIGURED" });
		expect(mocks.generateText).not.toHaveBeenCalled();
		expect(mocks.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "COMPLEX" },
			expect.objectContaining({
				organizationId: "org-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		);
	});

	it("answers SECTION_NOT_FOUND for an unknown key and for the preamble", async () => {
		expect(
			await reviseProposalSection(input({ sectionKey: "p1:missing#0" })),
		).toEqual({ status: "SECTION_NOT_FOUND" });
		expect(
			await reviseProposalSection(input({ sectionKey: "p1:@preamble" })),
		).toEqual({ status: "SECTION_NOT_FOUND" });
		expect(mocks.generateText).not.toHaveBeenCalled();
	});

	it("revises only a parent's own lines, never its subsection", async () => {
		const scopeKey = buildSectionMap(DOCUMENT).sections.find(
			(section) => section.headingText === "2. Scope",
		)?.key as string;
		modelWrites("The pilot covers the data migration and its testing.");

		const result = await reviseProposalSection(
			input({ sectionKey: scopeKey }),
		);

		expect(result.status).toBe("CANDIDATE");
		const spliced = spliceSectionBody(
			DOCUMENT,
			scopeKey,
			(result as { body: string }).body,
		) as string;
		expect(spliced).toContain(
			"## 2. Scope\n\nThe pilot covers the data migration and its testing.\n\n### 2.1 Out of Scope\n\nHardware purchases are out of scope.",
		);
		expect(otherSections(spliced, scopeKey)).toEqual(
			otherSections(DOCUMENT, scopeKey),
		);
	});
});

describe("spliceSectionBody", () => {
	it("keeps a setext heading's two lines fixed", () => {
		const document =
			"Intro\n\nScope\n-----\n\nOld text.\n\n## Next\n\nKept.";
		const key = buildSectionMap(document).sections.find(
			(section) => section.headingText === "Scope",
		)?.key as string;
		const target = locateSectionTarget(document, key);

		expect(target && sectionBody(target)).toBe("Old text.");
		expect(spliceSectionBody(document, key, "New text.")).toBe(
			"Intro\n\nScope\n-----\n\nNew text.\n\n## Next\n\nKept.",
		);
	});

	it("revises the last section and keeps the document's final newline", () => {
		const key = buildSectionMap(DOCUMENT).sections.find(
			(section) => section.headingText === "5. Pricing",
		)?.key as string;

		expect(spliceSectionBody(DOCUMENT, key, "A fixed fee of 45k.")).toBe(
			DOCUMENT.replace("A fixed fee of 40k.", "A fixed fee of 45k."),
		);
	});

	it("gives an empty section a body between blank lines", () => {
		const document = "## Empty\n## Next\n\nKept.";
		const key = buildSectionMap(document).sections[0].key;

		expect(spliceSectionBody(document, key, "Now filled.")).toBe(
			"## Empty\n\nNow filled.\n\n## Next\n\nKept.",
		);
	});

	it("reads a CRLF document by its normalised lines", () => {
		const crlf = DOCUMENT.replace(/\n/g, "\r\n");

		expect(spliceSectionBody(crlf, APPROACH_KEY, "Short.")).toBe(
			spliceSectionBody(DOCUMENT, APPROACH_KEY, "Short."),
		);
	});
});
