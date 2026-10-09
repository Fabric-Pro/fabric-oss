/**
 * `generateProposalVisuals` (Fizzy #2801): detection over the Main sections,
 * one extraction per detected opportunity, mermaid fences with their colors
 * filled from the document's Style and the recipient brand, comparisons as
 * tables, stat never produced, and the content returned unchanged on any
 * failure.
 *
 * The Glossy library calls are mocked here; their model attribution is
 * pinned against the real calls in `visuals-attribution.test.ts`.
 */

import {
	deriveGlossyPalette,
	fillVisualColors,
} from "@repo/utils/glossy/visual-colors";
import { visualSpecToMermaid } from "@repo/utils/glossy/visual-templates";
import { toMermaidFence } from "@repo/utils/proposal-artifact/visual-insert";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
	db: { projectDocument: { updateMany: vi.fn() } },
	getDocumentStyle: vi.fn(),
	getRecipientBrand: vi.fn(),
}));
const detect = vi.hoisted(() => ({ detectGlossyOpportunities: vi.fn() }));
const extract = vi.hoisted(() => ({ extractGlossyVisual: vi.fn() }));
const activity = vi.hoisted(() => ({
	/** The attempt's cancellation signal; none outside an activity. */
	cancellation: undefined as AbortController | undefined,
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", () => database);
vi.mock("../../../lib/glossy/model", () => ({
	GLOSSY_AI_PROVIDER_NOT_CONFIGURED_MESSAGE: "Configure an AI provider.",
}));
vi.mock("../../../lib/glossy/detect-opportunities", () => detect);
vi.mock("../../../lib/glossy/extract-visual", () => extract);
vi.mock("../../glossy-edition/shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../glossy-edition/shared")>()),
	currentCancellationSignal: () => activity.cancellation?.signal,
}));
vi.mock("../../lib/activity-logger", () => ({
	activityLogger: activity.logger,
}));

import { CancelledFailure } from "@temporalio/common";
import { generateProposalVisuals } from "../visuals";

const MAIN = [
	"# Example Proposal",
	"",
	"## Timeline and Milestones",
	"",
	"Discovery runs in March, build in April and launch in May.",
	"",
	"- Discovery: March",
	"- Build: April",
	"",
	"## Options",
	"",
	"Option A is faster; option B is cheaper.",
	"",
	"## Delivery Approach",
	"",
	"We work in two-week iterations.",
	"",
	"```mermaid",
	"flowchart LR",
	"a --> b",
	"```",
	"",
	"## Investment",
	"",
	"",
	"### Payment Schedule",
	"",
	"Half on signature, half on launch.",
].join("\n");

const INPUT = {
	projectId: "project-1",
	documentId: "doc-1",
	organizationId: "org-1",
	userId: "user-1",
	liveRunId: "live-run-1",
	content: MAIN,
	planEligible: true,
};

const TIMELINE = {
	kind: "timeline" as const,
	items: [
		{ date: "March", label: "Discovery" },
		{ date: "May", label: "Launch" },
	],
};

const COMPARISON = {
	kind: "comparison" as const,
	items: [
		{ title: "Option A", points: ["Faster"] },
		{ title: "Option B", points: ["Cheaper"] },
	],
};

type DetectionCall = {
	featureKey?: string;
	planEligible?: boolean;
	documentType: string;
	limit?: number;
	sections: Array<{
		sectionKey: string;
		heading: string | null;
		markdown: string;
		reservedKinds?: readonly string[];
	}>;
};

function detectionCall(): DetectionCall {
	const call = detect.detectGlossyOpportunities.mock.calls[0]?.[0];
	if (!call) {
		throw new Error("detection was not called");
	}
	return call as DetectionCall;
}

function keyOf(heading: string): string {
	const section = detectionCall().sections.find(
		(entry) => entry.heading === heading,
	);
	if (!section) {
		throw new Error(`no section ${heading}`);
	}
	return section.sectionKey;
}

/** Detection proposes `kind` for each named heading. */
function detects(entries: Array<[heading: string, kind: string]>) {
	detect.detectGlossyOpportunities.mockImplementation(
		async (input: DetectionCall) => ({
			status: "detected",
			discarded: 0,
			opportunities: entries.map(([heading, kind]) => {
				const section = input.sections.find(
					(entry) => entry.heading === heading,
				);
				return {
					sectionKey: section?.sectionKey ?? heading,
					kind,
					reason: "",
				};
			}),
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	activity.cancellation = undefined;
	database.db.projectDocument.updateMany.mockResolvedValue({ count: 1 });
	database.getDocumentStyle.mockResolvedValue(null);
	database.getRecipientBrand.mockResolvedValue(null);
	extract.extractGlossyVisual.mockImplementation(
		async ({ kind }: { kind: string }) =>
			kind === "comparison"
				? { status: "extracted", spec: COMPARISON }
				: { status: "extracted", spec: TIMELINE },
	);
});

describe("generateProposalVisuals — sections", () => {
	it("detects over the sections that can take a visual, under the proposal-visuals key", async () => {
		detects([]);

		await generateProposalVisuals(INPUT);

		const call = detectionCall();
		expect(call.documentType).toBe("PROPOSAL");
		expect(call.featureKey).toBe("proposal-visuals");
		expect(call.planEligible).toBe(true);
		// The title, a section that already shows a diagram, and a heading
		// whose content lives in its subsection are left out.
		expect(call.sections.map((section) => section.heading)).toEqual([
			"Timeline and Milestones",
			"Options",
			"Payment Schedule",
		]);
		// A section's own body only.
		expect(call.sections[0].markdown).toBe(
			"Discovery runs in March, build in April and launch in May.\n\n- Discovery: March\n- Build: April",
		);
		// Stat is not produced in this release.
		for (const section of call.sections) {
			expect(section.reservedKinds).toEqual(["stat"]);
		}
	});

	it("returns the content unchanged, without a model call, when no section can take a visual", async () => {
		const result = await generateProposalVisuals({
			...INPUT,
			content: "# Title only",
		});

		expect(result).toEqual({ content: "# Title only", insertedCount: 0 });
		expect(detect.detectGlossyOpportunities).not.toHaveBeenCalled();
		expect(database.db.projectDocument.updateMany).not.toHaveBeenCalled();
	});
});

describe("generateProposalVisuals — rendering and placement", () => {
	it("puts a timeline after its section's first paragraph as a mermaid fence, colors filled", async () => {
		detects([["Timeline and Milestones", "timeline"]]);

		const result = await generateProposalVisuals(INPUT);

		expect(result.insertedCount).toBe(1);
		const fence = toMermaidFence(
			fillVisualColors(
				visualSpecToMermaid(TIMELINE),
				deriveGlossyPalette(),
			),
		);
		expect(result.content).toContain(
			`Discovery runs in March, build in April and launch in May.\n\n${fence}\n\n- Discovery: March\n- Build: April\n\n## Options`,
		);
		expect(result.content).not.toMatch(/GLOSSY_COLOR_/);
		// Every color is a #rrggbb value.
		for (const color of result.content.match(/#[0-9a-zA-Z]+/g) ?? []) {
			expect(color).toMatch(/^#[0-9a-f]{6}$/);
		}
	});

	it("renders a comparison as a markdown table", async () => {
		detects([["Options", "comparison"]]);

		const result = await generateProposalVisuals(INPUT);

		expect(result.insertedCount).toBe(1);
		expect(result.content).toContain(
			"Option A is faster; option B is cheaper.\n\n| Option A | Option B |\n| --- | --- |\n| Faster | Cheaper |",
		);
	});

	it("drops a stat the model proposes anyway, without extracting it", async () => {
		detects([["Options", "stat"]]);

		const result = await generateProposalVisuals(INPUT);

		expect(extract.extractGlossyVisual).not.toHaveBeenCalled();
		expect(result).toEqual({ content: MAIN, insertedCount: 0 });
	});

	it("never adds a second diagram to a section that already shows one", async () => {
		detects([
			["Delivery Approach", "flow"],
			["Timeline and Milestones", "timeline"],
		]);

		const result = await generateProposalVisuals(INPUT);

		expect(result.insertedCount).toBe(1);
		expect(result.content.match(/```mermaid/g)).toHaveLength(2);
	});

	it("extracts each opportunity as detected, from its own section, with the style direction", async () => {
		database.getDocumentStyle.mockResolvedValue({
			styleDirection: "  Calm and   executive ",
			primaryColor: null,
			accentColors: [],
		});
		detects([["Timeline and Milestones", "timeline"]]);

		await generateProposalVisuals(INPUT);

		expect(extract.extractGlossyVisual).toHaveBeenCalledWith(
			expect.objectContaining({
				featureKey: "proposal-visuals",
				planEligible: true,
				userId: "user-1",
				organizationId: "org-1",
				projectId: "project-1",
				documentType: "PROPOSAL",
				kind: "timeline",
				source: "detected",
				styleDirection: "Calm and executive",
				section: {
					heading: "Timeline and Milestones",
					markdown: detectionCall().sections[0].markdown,
				},
			}),
		);
		expect(keyOf("Timeline and Milestones")).toBeTruthy();
	});

	it("keeps the visuals that passed when another is dropped", async () => {
		detects([
			["Timeline and Milestones", "timeline"],
			["Options", "comparison"],
		]);
		extract.extractGlossyVisual.mockImplementation(
			async ({ kind }: { kind: string }) =>
				kind === "comparison"
					? {
							status: "dropped",
							reason: "factCheck",
							message: "",
							violations: [],
						}
					: { status: "extracted", spec: TIMELINE },
		);

		const result = await generateProposalVisuals(INPUT);

		expect(result.insertedCount).toBe(1);
		expect(result.content).not.toContain("| Option A |");
	});
});

describe("generateProposalVisuals — palette", () => {
	it("colors from the document's Style first, then the recipient brand", async () => {
		database.getDocumentStyle.mockResolvedValue({
			styleDirection: null,
			primaryColor: "#1d4ed8",
			accentColors: ["#f59e0b"],
		});
		database.getRecipientBrand.mockResolvedValue({
			organizationId: "org-1",
			colors: ["#10b981"],
		});
		detects([["Timeline and Milestones", "timeline"]]);

		const result = await generateProposalVisuals(INPUT);

		const palette = deriveGlossyPalette({
			overrides: { primary: "#1d4ed8", accents: ["#f59e0b"] },
			recipientColors: ["#10b981"],
		});
		expect(result.content).toContain(
			fillVisualColors(visualSpecToMermaid(TIMELINE), palette),
		);
		expect(database.getDocumentStyle).toHaveBeenCalledWith({
			documentId: "doc-1",
			organizationId: "org-1",
		});
	});

	it("takes the recipient's color as primary when the Style sets none", async () => {
		database.getRecipientBrand.mockResolvedValue({
			organizationId: "org-1",
			colors: ["#10b981"],
		});
		detects([["Timeline and Milestones", "timeline"]]);

		const result = await generateProposalVisuals(INPUT);

		const palette = deriveGlossyPalette({ recipientColors: ["#10b981"] });
		expect(palette.primary).toBe("#10b981");
		expect(result.content).toContain(
			fillVisualColors(visualSpecToMermaid(TIMELINE), palette),
		);
	});

	it("ignores a recipient brand from another organization", async () => {
		database.getRecipientBrand.mockResolvedValue({
			organizationId: "org-other",
			colors: ["#10b981"],
		});
		detects([["Timeline and Milestones", "timeline"]]);

		const result = await generateProposalVisuals(INPUT);

		expect(result.content).toContain(
			fillVisualColors(
				visualSpecToMermaid(TIMELINE),
				deriveGlossyPalette(),
			),
		);
	});
});

describe("generateProposalVisuals — progress", () => {
	it("moves the run's progress while it works, guarded on the run token and GENERATING", async () => {
		detects([
			["Timeline and Milestones", "timeline"],
			["Options", "comparison"],
		]);

		await generateProposalVisuals(INPUT);

		const writes = database.db.projectDocument.updateMany.mock.calls.map(
			([args]) =>
				args as {
					where: unknown;
					data: { generationProgress: number };
				},
		);
		// Before detection, after it, and after each visual.
		expect(writes).toHaveLength(4);
		for (const write of writes) {
			expect(write.where).toEqual({
				id: "doc-1",
				liveRunId: "live-run-1",
				status: "GENERATING",
			});
		}
		const progress = writes.map((write) => write.data.generationProgress);
		expect(progress).toEqual([...progress].sort((a, b) => a - b));
		expect(progress.at(-1)).toBe(90);
	});

	it("carries on when a progress write fails", async () => {
		database.db.projectDocument.updateMany.mockRejectedValue(
			new Error("connection reset"),
		);
		detects([["Timeline and Milestones", "timeline"]]);

		const result = await generateProposalVisuals(INPUT);

		expect(result.insertedCount).toBe(1);
	});
});

describe("generateProposalVisuals — fails open", () => {
	it.each([
		[
			"detection throws",
			() =>
				detect.detectGlossyOpportunities.mockRejectedValue(
					new Error("provider outage"),
				),
		],
		[
			"detection is degraded",
			() =>
				detect.detectGlossyOpportunities.mockResolvedValue({
					status: "degraded",
					reason: "truncated",
					opportunities: [],
				}),
		],
		[
			"no AI provider is configured",
			() =>
				detect.detectGlossyOpportunities.mockResolvedValue({
					status: "aiProviderNotConfigured",
					message: "Configure one.",
				}),
		],
		[
			"an extraction throws",
			() => {
				detects([
					["Timeline and Milestones", "timeline"],
					["Options", "comparison"],
				]);
				extract.extractGlossyVisual.mockRejectedValue(
					new Error("provider outage"),
				);
			},
		],
		[
			"the style cannot be read",
			() => {
				detects([["Timeline and Milestones", "timeline"]]);
				database.getDocumentStyle.mockRejectedValue(
					new Error("connection reset"),
				);
			},
		],
	])("returns the content unchanged when %s", async (_case, arrange) => {
		arrange();

		const result = await generateProposalVisuals(INPUT);

		expect(result).toEqual({ content: MAIN, insertedCount: 0 });
	});

	it("keeps every visual that succeeded when another extraction throws, logging only the error's name", async () => {
		detects([
			["Timeline and Milestones", "timeline"],
			["Options", "comparison"],
			["Payment Schedule", "timeline"],
		]);
		extract.extractGlossyVisual.mockImplementation(
			async ({ kind }: { kind: string }) => {
				if (kind === "comparison") {
					throw new Error("Upstream 503 from provider.example.com");
				}
				return { status: "extracted", spec: TIMELINE };
			},
		);

		const result = await generateProposalVisuals(INPUT);

		expect(extract.extractGlossyVisual).toHaveBeenCalledTimes(3);
		expect(result.insertedCount).toBe(2);
		expect(result.content).not.toContain("| Option A |");
		expect(activity.logger.warn).toHaveBeenCalledWith(
			"Proposal visual extraction failed; dropped",
			expect.objectContaining({ errorName: "Error" }),
		);
		const logged = JSON.stringify([
			...activity.logger.info.mock.calls,
			...activity.logger.warn.mock.calls,
			...activity.logger.error.mock.calls,
		]);
		expect(logged).not.toContain("Upstream 503");
		expect(activity.logger.info).toHaveBeenCalledWith(
			"Proposal visuals generated",
			expect.objectContaining({ dropped: 1, inserted: 2 }),
		);
	});

	it.each([
		[
			"the attempt's cancellation signal fired",
			() => {
				activity.cancellation = new AbortController();
				return () => {
					activity.cancellation?.abort();
					const aborted = new Error("This operation was aborted");
					aborted.name = "AbortError";
					return aborted;
				};
			},
		],
		[
			"the extraction reports the cancellation itself",
			() => () => new CancelledFailure("Activity cancelled"),
		],
	])(
		"stops starting extractions once %s, and saves Main without visuals",
		async (_case, arrange) => {
			const cancel = arrange();
			// Four opportunities, three in flight at once: the fourth would
			// only start if a cancellation were swallowed like a failure.
			detects([
				["Timeline and Milestones", "timeline"],
				["Options", "comparison"],
				["Payment Schedule", "timeline"],
				["Timeline and Milestones", "flow"],
			]);
			let calls = 0;
			extract.extractGlossyVisual.mockImplementation(async () => {
				calls += 1;
				if (calls === 1) {
					throw cancel();
				}
				return { status: "extracted", spec: TIMELINE };
			});

			const result = await generateProposalVisuals(INPUT);

			expect(extract.extractGlossyVisual).toHaveBeenCalledTimes(3);
			expect(result).toEqual({ content: MAIN, insertedCount: 0 });
		},
	);

	it("stops extracting when the provider turns out to be missing", async () => {
		detects([
			["Timeline and Milestones", "timeline"],
			["Options", "comparison"],
			["Payment Schedule", "timeline"],
		]);
		extract.extractGlossyVisual.mockResolvedValue({
			status: "aiProviderNotConfigured",
			message: "Configure one.",
		});

		const result = await generateProposalVisuals(INPUT);

		expect(result).toEqual({ content: MAIN, insertedCount: 0 });
	});
});
