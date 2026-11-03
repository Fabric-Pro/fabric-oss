/**
 * `generateProposalVisuals` (Fizzy #2801, Fizzy #2946): detection over the
 * Main sections, one extraction per detected opportunity, mermaid fences
 * that assign colour roles and hold no colour (the page and the export paint
 * the roles from the theme), comparisons as tables, stat never produced, the
 * step off when the document's Style says so, and the content returned
 * unchanged on any failure.
 *
 * The Glossy library calls are mocked here; their model attribution is
 * pinned against the real calls in `visuals-attribution.test.ts`. The brand
 * resolver is a mock answering with the real token builder over the sources
 * each test gives, so the precedence under test is the shipped one.
 */

import { GLOSSY_EDIT_SOURCE_MAX_CHARS } from "@repo/agent-prompts/glossy";
import {
	type LayersVisualSpec,
	proposalVisualSpecSchema,
	type TeamVisualSpec,
} from "@repo/utils/glossy/visual-spec";
import {
	proposalFigureKind,
	proposalVisualTemplateOptions,
	visualSpecToMermaid,
} from "@repo/utils/glossy/visual-templates";
import {
	type FigurePalette,
	parseFigureSource,
	readFigureKind,
	renderFigureSvg,
	withFigureKind,
} from "@repo/utils/proposal-artifact/proposal-figures";
import {
	buildProposalThemeTokens,
	type ProposalThemeSources,
} from "@repo/utils/proposal-artifact/theme-tokens";
import {
	DIAGRAM_CAPTION_MAX_CHARS,
	readDiagramCaption,
	visualSourceHash,
} from "@repo/utils/proposal-artifact/visual-identity";
import {
	toMermaidFence,
	toMermaidFenceBody,
} from "@repo/utils/proposal-artifact/visual-insert";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
	db: { projectDocument: { updateMany: vi.fn() } },
	resolveProposalThemeTokens: vi.fn(),
	appendProposalVisualSpec: vi.fn(),
}));
const detect = vi.hoisted(() => ({ detectGlossyOpportunities: vi.fn() }));
const extract = vi.hoisted(() => ({ extractGlossyVisual: vi.fn() }));
const activity = vi.hoisted(() => ({
	/** The attempt's cancellation signal; none outside an activity. */
	cancellation: undefined as AbortController | undefined,
	/** The attempt's deadline; none outside an activity. */
	deadline: undefined as Date | undefined,
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
vi.mock("../../lib/activity-liveness", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/activity-liveness")>()),
	currentActivityAttemptDeadline: () => activity.deadline,
}));
vi.mock("../../lib/activity-logger", () => ({
	activityLogger: activity.logger,
}));

import { CancelledFailure } from "@temporalio/common";
import { coverLetter } from "../../../lib/proposal-export/document-content";
import {
	exportDiagramCaptions,
	prepareExportMarkdown,
} from "../../../lib/proposal-export/markdown";
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

/** The resolver's answer over `sources`, the rest of them empty. */
function brand(
	sources: Partial<ProposalThemeSources> = {},
	styleDirection: string | null = null,
	autoVisuals = true,
) {
	return {
		autoVisuals,
		tokens: buildProposalThemeTokens({
			organization: null,
			style: null,
			brandKit: null,
			recipient: null,
			...sources,
		}),
		styleDirection,
		brandGuidance: null,
	};
}

/** The caption of a diagram in the timeline section, which the mocks give none. */
const TIMELINE_CAPTION = "%% caption: Timeline and Milestones";

/**
 * The timeline's fence body as the step draws it: its section's heading as
 * the caption, the timeline figure line, then roles, no colour.
 */
const TIMELINE_SOURCE = `${TIMELINE_CAPTION}\n%% figure: timeline\n${visualSpecToMermaid(
	TIMELINE,
	proposalVisualTemplateOptions(TIMELINE),
)}`;

type DetectionCall = {
	featureKey?: string;
	planEligible?: boolean;
	documentType: string;
	proposalArtifact?: boolean;
	limit?: number;
	sections: Array<{
		sectionKey: string;
		heading: string | null;
		markdown: string;
		reservedKinds?: readonly string[];
		appendix?: boolean;
	}>;
};

function detectionCall(): DetectionCall {
	const call = detect.detectGlossyOpportunities.mock.calls[0]?.[0];
	if (!call) {
		throw new Error("detection was not called");
	}
	return call as DetectionCall;
}

type StoredSpec = {
	organizationId: string;
	projectId: string;
	documentId: string;
	visualId: string;
	sourceHash: string;
	kind: string;
	origin: string;
	spec: unknown;
	createdById?: string | null;
};

function storedSpecs(): StoredSpec[] {
	return database.appendProposalVisualSpec.mock.calls.map(
		([row]) => row as StoredSpec,
	);
}

/** Every mermaid fence body in `markdown`, without its fence lines. */
function mermaidBodies(markdown: string): string[] {
	return [...markdown.matchAll(/^```mermaid\n([\s\S]*?)\n```$/gm)].map(
		(match) => match[1],
	);
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
	activity.deadline = undefined;
	database.db.projectDocument.updateMany.mockResolvedValue({ count: 1 });
	database.resolveProposalThemeTokens.mockResolvedValue(brand());
	database.appendProposalVisualSpec.mockResolvedValue({ created: true });
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
	it("puts a timeline after its section's first paragraph as a mermaid fence of colour roles", async () => {
		detects([["Timeline and Milestones", "timeline"]]);

		const result = await generateProposalVisuals(INPUT);

		expect(result.insertedCount).toBe(1);
		const [{ visualId }] = storedSpecs();
		const fence = toMermaidFence(TIMELINE_SOURCE, visualId);
		expect(result.content).toContain(
			`Discovery runs in March, build in April and launch in May.\n\n${fence}\n\n- Discovery: March\n- Build: April\n\n## Options`,
		);
		expect(fence).toContain('t0["March<br/>Discovery"]\nclass t0 surface');
		expect(result.content).not.toMatch(/GLOSSY_COLOR_/);
		expect(result.content).not.toMatch(/^style /m);
		expect(result.content).not.toMatch(/#[0-9a-f]{6}/i);
	});

	it("writes a long timeline title as one label line, as its figure template reads it", async () => {
		const title = "Scope the work with both teams together";
		detects([["Timeline and Milestones", "timeline"]]);
		extract.extractGlossyVisual.mockResolvedValueOnce({
			status: "extracted",
			spec: {
				kind: "timeline",
				items: [
					{ date: "March", label: title },
					{ date: "May", label: "Launch" },
				],
			},
		});

		const result = await generateProposalVisuals(INPUT);

		expect(result.insertedCount).toBe(1);
		const [body] = mermaidBodies(result.content);
		expect(readFigureKind(body)).toBe("timeline");
		expect(body).toContain(`t0["March<br/>${title}"]`);
		expect(parseFigureSource(body)?.nodes[0].lines).toEqual([
			"March",
			title,
		]);
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
		database.resolveProposalThemeTokens.mockResolvedValue(
			brand({}, "  Calm and   executive "),
		);
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

describe("generateProposalVisuals — visual identity (Fizzy #2946)", () => {
	it("opens each diagram's fence with a minted marker and stores its spec, origin STEP, under the fence's source hash", async () => {
		detects([["Timeline and Milestones", "timeline"]]);

		const result = await generateProposalVisuals(INPUT);

		expect(result.insertedCount).toBe(1);
		const rows = storedSpecs();
		expect(rows).toHaveLength(1);
		const [row] = rows;
		expect(row).toEqual({
			organizationId: "org-1",
			projectId: "project-1",
			documentId: "doc-1",
			visualId: expect.stringMatching(/^[a-z0-9]{16}$/),
			sourceHash: expect.stringMatching(/^v1:[0-9a-f]{16}$/),
			kind: "timeline",
			origin: "STEP",
			spec: TIMELINE,
			createdById: "user-1",
		});
		const inserted = mermaidBodies(result.content).find((body) =>
			body.startsWith("%% fabric-visual:"),
		);
		expect(inserted?.split("\n")[0]).toBe(
			`%% fabric-visual: ${row.visualId}`,
		);
		expect(visualSourceHash(inserted ?? "")).toBe(row.sourceHash);
	});

	it("mints a new id for every diagram", async () => {
		detects([
			["Timeline and Milestones", "timeline"],
			["Payment Schedule", "timeline"],
		]);

		await generateProposalVisuals(INPUT);

		const ids = storedSpecs().map((row) => row.visualId);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
	});

	it("stores no spec for a comparison table, which has no fence to mark", async () => {
		detects([["Options", "comparison"]]);

		const result = await generateProposalVisuals(INPUT);

		expect(result.insertedCount).toBe(1);
		expect(database.appendProposalVisualSpec).not.toHaveBeenCalled();
		expect(result.content).not.toContain("fabric-visual");
	});

	it("drops only the visual whose spec cannot be stored, and still returns Main with the others", async () => {
		detects([
			["Timeline and Milestones", "timeline"],
			["Options", "comparison"],
		]);
		database.appendProposalVisualSpec.mockRejectedValue(
			new Error("connection reset"),
		);

		const result = await generateProposalVisuals(INPUT);

		expect(result.insertedCount).toBe(1);
		expect(result.content).toContain("| Option A |");
		expect(result.content).not.toContain("fabric-visual");
		expect(activity.logger.warn).toHaveBeenCalledWith(
			"Proposal visual spec write failed; dropped",
			expect.objectContaining({ kind: "timeline", errorName: "Error" }),
		);
		expect(activity.logger.info).toHaveBeenCalledWith(
			"Proposal visuals generated",
			expect.objectContaining({
				dropped: { specWrite: 1 },
				insertedKinds: ["comparison"],
			}),
		);
	});
});

describe("generateProposalVisuals — captions (Fizzy #2946)", () => {
	it("writes the extraction's caption between the marker and the figure line", async () => {
		detects([["Timeline and Milestones", "timeline"]]);
		extract.extractGlossyVisual.mockResolvedValueOnce({
			status: "extracted",
			spec: TIMELINE,
			caption: "Discovery to launch",
		});

		const result = await generateProposalVisuals(INPUT);

		const [{ visualId }] = storedSpecs();
		const [body] = mermaidBodies(result.content);
		expect(body.split("\n").slice(0, 3)).toEqual([
			`%% fabric-visual: ${visualId}`,
			"%% caption: Discovery to launch",
			"%% figure: timeline",
		]);
		expect(readFigureKind(body)).toBe("timeline");
	});

	it("captions a figure with its section's heading, without its number or marks, when the extraction gives none", async () => {
		const content = MAIN.replace(
			"## Timeline and Milestones",
			"## 3. **Timeline** and Milestones",
		);
		detects([["3. **Timeline** and Milestones", "timeline"]]);

		const result = await generateProposalVisuals({ ...INPUT, content });

		expect(result.insertedCount).toBe(1);
		const [body] = mermaidBodies(result.content);
		expect(readDiagramCaption(body)).toBe("Timeline and Milestones");
	});

	it.each([
		["2026 Roadmap", "2026 Roadmap"],
		["90 Day Plan", "90 Day Plan"],
		["3.1 Timeline", "Timeline"],
		["3) Timeline", "Timeline"],
	])(
		"captions a figure under %j as %j: a year or a count is not a section number",
		async (heading, caption) => {
			const content = MAIN.replace(
				"## Timeline and Milestones",
				`## ${heading}`,
			);
			detects([[heading, "timeline"]]);

			const result = await generateProposalVisuals({ ...INPUT, content });

			expect(result.insertedCount).toBe(1);
			const [body] = mermaidBodies(result.content);
			expect(readDiagramCaption(body)).toBe(caption);
		},
	);

	it("writes no storage path into a caption, from the extraction or the heading", async () => {
		const path = "document-media/project-1/doc-1/figure.png";
		const content = MAIN.replace("## Options", `## Options ${path}`);
		detects([
			["Timeline and Milestones", "timeline"],
			[`Options ${path}`, "timeline"],
		]);
		extract.extractGlossyVisual
			.mockResolvedValueOnce({
				status: "extracted",
				spec: TIMELINE,
				caption: `Discovery plan ${path}`,
			})
			.mockResolvedValueOnce({
				status: "extracted",
				spec: TIMELINE,
				caption: path,
			});

		const result = await generateProposalVisuals({ ...INPUT, content });

		const inserted = mermaidBodies(result.content).filter((body) =>
			body.startsWith("%% fabric-visual:"),
		);
		// A caption that was only a path falls back to the heading, itself
		// without its path.
		expect(inserted.map(readDiagramCaption)).toEqual([
			"Discovery plan",
			"Options",
		]);
		for (const body of inserted) {
			expect(body).not.toContain("document-media/");
		}
	});

	it("gives every figure a caption, a layers figure included", async () => {
		const layers: LayersVisualSpec = {
			kind: "layers",
			layers: [
				{ name: "Channels", components: ["Web shop"] },
				{ name: "Data", components: ["Order store"] },
			],
		};
		detects([
			["Timeline and Milestones", "timeline"],
			["Payment Schedule", "layers"],
		]);
		extract.extractGlossyVisual.mockImplementation(
			async ({ kind }: { kind: string }) =>
				kind === "layers"
					? { status: "extracted", spec: layers }
					: { status: "extracted", spec: TIMELINE },
		);

		const result = await generateProposalVisuals(INPUT);

		const inserted = mermaidBodies(result.content).filter((body) =>
			body.startsWith("%% fabric-visual:"),
		);
		expect(inserted.map(readDiagramCaption)).toEqual([
			"Timeline and Milestones",
			"Payment Schedule",
		]);
	});

	it("keeps the source hash, which leaves the caption out", async () => {
		detects([["Timeline and Milestones", "timeline"]]);
		extract.extractGlossyVisual.mockResolvedValueOnce({
			status: "extracted",
			spec: TIMELINE,
			caption: "Discovery to launch",
		});

		const result = await generateProposalVisuals(INPUT);

		const [row] = storedSpecs();
		const [body] = mermaidBodies(result.content);
		const uncaptioned = body
			.split("\n")
			.filter((line) => !line.startsWith("%% caption:"))
			.join("\n");
		// The fence carries the caption, so the two bodies differ.
		expect(body).toContain("\n%% caption: Discovery to launch\n");
		expect(uncaptioned).not.toBe(body);
		expect(visualSourceHash(body)).toBe(row.sourceHash);
		expect(visualSourceHash(uncaptioned)).toBe(row.sourceHash);
	});

	it("shows the live page and print the same caption", async () => {
		detects([["Timeline and Milestones", "timeline"]]);
		extract.extractGlossyVisual.mockResolvedValueOnce({
			status: "extracted",
			spec: TIMELINE,
			caption: "Discovery to launch",
		});

		const result = await generateProposalVisuals(INPUT);

		const generated = mermaidBodies(result.content).findIndex((body) =>
			body.startsWith("%% fabric-visual:"),
		);
		// The page reads the fence's caption line; print reads the same
		// line from the exported Markdown.
		expect(
			readDiagramCaption(mermaidBodies(result.content)[generated]),
		).toBe("Discovery to launch");
		expect(
			exportDiagramCaptions(prepareExportMarkdown(result.content))[
				generated
			],
		).toBe("Discovery to launch");
	});
});

describe("generateProposalVisuals — whole labels (Fizzy #2946)", () => {
	// Past what the extraction asks for a title, within the cap.
	const LONG_TITLE = "Map every intake channel with the depot leads";
	// Past one line.
	const LONG_DETAIL = "Interviews with every shift lead at both depots";

	it.each([
		[
			"timeline",
			{
				kind: "timeline",
				items: [
					{
						date: "March",
						label: LONG_TITLE,
						description: "Short detail",
					},
					{ date: "May", label: "Launch", description: LONG_DETAIL },
				],
			},
		],
		[
			"flow",
			{
				kind: "flow",
				steps: [
					{ label: LONG_TITLE, description: "Short detail" },
					{ label: "Launch", description: LONG_DETAIL },
				],
			},
		],
		[
			"layers",
			{
				kind: "layers",
				layers: [
					{
						name: "Channels",
						description: LONG_DETAIL,
						components: [LONG_TITLE],
					},
					{ name: "Data", components: ["Order store"] },
				],
			},
		],
		[
			"team",
			{
				kind: "team",
				proposer: {
					name: "Example Studio",
					members: [{ role: LONG_TITLE, description: LONG_DETAIL }],
				},
				client: {
					name: "Example Retail",
					members: [{ role: "Owner" }],
				},
			},
		],
	] as const)(
		"writes no %s label cut with an ellipsis into the fence",
		async (kind, spec) => {
			detects([["Timeline and Milestones", kind]]);
			extract.extractGlossyVisual.mockResolvedValueOnce({
				status: "extracted",
				spec,
			});

			const result = await generateProposalVisuals(INPUT);

			const body = mermaidBodies(result.content).find((candidate) =>
				candidate.startsWith("%% fabric-visual:"),
			);
			expect(body).toContain(LONG_TITLE);
			expect(body).not.toContain("…");
			expect(body).not.toContain(LONG_DETAIL.slice(0, 20));
		},
	);
});

describe("generateProposalVisuals — comparison label case (Fizzy #2946)", () => {
	it("starts each all-lower-case header and cell with a capital, leaving other casing as written", async () => {
		detects([["Options", "comparison"]]);
		extract.extractGlossyVisual.mockResolvedValueOnce({
			status: "extracted",
			spec: {
				kind: "comparison",
				items: [
					{
						title: "managed service",
						points: ["faster", "iOS ready"],
					},
					{ title: "eBay listings", points: ["cheaper", "slower"] },
				],
			},
		});

		const result = await generateProposalVisuals(INPUT);

		expect(result.content).toContain(
			"| Managed service | eBay listings |\n| --- | --- |\n| Faster | Cheaper |\n| iOS ready | Slower |",
		);
	});
});

describe("generateProposalVisuals — health check logging (Fizzy #2946)", () => {
	it("logs the inserted kinds, drops by reason and each drop's violation codes, never section or fact text", async () => {
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
							violations: [
								{
									kind: "presence",
									text: "Q2 2027",
									message:
										'"Q2 2027" does not appear in the source.',
									factKind: "date",
								},
							],
						}
					: { status: "extracted", spec: TIMELINE },
		);

		await generateProposalVisuals(INPUT);

		expect(activity.logger.info).toHaveBeenCalledWith(
			"Proposal visuals generated",
			expect.objectContaining({
				insertedKinds: ["timeline"],
				dropped: { factCheck: 1 },
				inserted: 1,
			}),
		);
		expect(activity.logger.info).toHaveBeenCalledWith(
			"Proposal visual dropped",
			{
				projectId: "project-1",
				documentId: "doc-1",
				liveRunId: "live-run-1",
				kind: "comparison",
				reason: "factCheck",
				violations: ["presence:date"],
			},
		);
		const logged = JSON.stringify([
			...activity.logger.info.mock.calls,
			...activity.logger.warn.mock.calls,
		]);
		expect(logged).not.toContain("Q2 2027");
		expect(logged).not.toContain("Option A is faster");
		expect(logged).not.toContain("Discovery runs in March");
	});
});

describe("generateProposalVisuals — fact-check retry (Fizzy #2946)", () => {
	const REFUSED = {
		status: "dropped",
		reason: "factCheck",
		message: "",
		violations: [
			{
				kind: "presence",
				text: "Q2 2027",
				message: '"Q2 2027" does not appear in the source.',
				factKind: "date",
			},
		],
	};
	const RETRY_SPEC = {
		kind: "timeline" as const,
		items: [
			{ date: "March", label: "Discovery" },
			{ date: "April", label: "Build" },
		],
	};

	function nonces(): unknown[] {
		return extract.extractGlossyVisual.mock.calls.map(
			([call]) => (call as { variantNonce?: string }).variantNonce,
		);
	}

	it("inserts the visual when the retry passes, storing the retry's spec once, and counts it", async () => {
		detects([["Timeline and Milestones", "timeline"]]);
		extract.extractGlossyVisual
			.mockResolvedValueOnce(REFUSED)
			.mockResolvedValueOnce({ status: "extracted", spec: RETRY_SPEC });

		const result = await generateProposalVisuals(INPUT);

		expect(extract.extractGlossyVisual).toHaveBeenCalledTimes(2);
		expect(result.insertedCount).toBe(1);
		const rows = storedSpecs();
		expect(rows).toHaveLength(1);
		expect(rows[0].spec).toEqual(RETRY_SPEC);
		expect(result.content).toContain(
			toMermaidFence(
				withFigureKind(
					`${TIMELINE_CAPTION}\n${visualSpecToMermaid(
						RETRY_SPEC,
						proposalVisualTemplateOptions(RETRY_SPEC),
					)}`,
					"timeline",
				),
				rows[0].visualId,
			),
		);
		expect(activity.logger.info).toHaveBeenCalledWith(
			"Proposal visuals generated",
			expect.objectContaining({
				dropped: {},
				retried: 1,
				recoveredByRetry: 1,
				inserted: 1,
			}),
		);
	});

	it("asks the retry for a fresh variant nonce", async () => {
		detects([["Timeline and Milestones", "timeline"]]);
		extract.extractGlossyVisual
			.mockResolvedValueOnce(REFUSED)
			.mockResolvedValueOnce({ status: "extracted", spec: TIMELINE });

		await generateProposalVisuals(INPUT);

		const [first, second] = nonces();
		expect(first).toBeUndefined();
		expect(second).toEqual(expect.any(String));
		expect(second).not.toBe(first);
		// Otherwise the same request.
		const [firstCall, secondCall] =
			extract.extractGlossyVisual.mock.calls.map(
				([call]) => call as Record<string, unknown>,
			);
		const { variantNonce: _nonce, ...rest } = secondCall;
		expect(rest).toEqual(firstCall);
	});

	it("drops the visual as a fact-check drop after two refusals, with two model calls", async () => {
		detects([["Timeline and Milestones", "timeline"]]);
		extract.extractGlossyVisual.mockResolvedValue(REFUSED);

		const result = await generateProposalVisuals(INPUT);

		expect(extract.extractGlossyVisual).toHaveBeenCalledTimes(2);
		expect(result).toEqual({ content: MAIN, insertedCount: 0 });
		expect(database.appendProposalVisualSpec).not.toHaveBeenCalled();
		expect(activity.logger.info).toHaveBeenCalledWith(
			"Proposal visual dropped",
			{
				projectId: "project-1",
				documentId: "doc-1",
				liveRunId: "live-run-1",
				kind: "timeline",
				reason: "factCheck",
				violations: ["presence:date"],
				attempt: 2,
			},
		);
		expect(activity.logger.info).toHaveBeenCalledWith(
			"Proposal visuals generated",
			expect.objectContaining({
				dropped: { factCheck: 1 },
				retried: 1,
				recoveredByRetry: 0,
			}),
		);
		expect(JSON.stringify(activity.logger.info.mock.calls)).not.toContain(
			"Q2 2027",
		);
	});

	it.each([
		[
			"truncated",
			{
				status: "dropped",
				reason: "truncated",
				message: "",
				violations: [],
			},
		],
		[
			"invalidSpec",
			{
				status: "dropped",
				reason: "invalidSpec",
				message: "",
				violations: [],
			},
		],
		[
			"kindMismatch",
			{
				status: "dropped",
				reason: "kindMismatch",
				message: "",
				violations: [],
			},
		],
	])("does not retry a %s drop", async (reason, outcome) => {
		detects([["Timeline and Milestones", "timeline"]]);
		extract.extractGlossyVisual.mockResolvedValue(outcome);

		await generateProposalVisuals(INPUT);

		expect(extract.extractGlossyVisual).toHaveBeenCalledTimes(1);
		expect(activity.logger.info).toHaveBeenCalledWith(
			"Proposal visuals generated",
			expect.objectContaining({
				dropped: { [reason]: 1 },
				retried: 0,
			}),
		);
	});

	it("does not retry an extraction that threw", async () => {
		detects([["Timeline and Milestones", "timeline"]]);
		extract.extractGlossyVisual.mockRejectedValue(
			new Error("provider outage"),
		);

		await generateProposalVisuals(INPUT);

		expect(extract.extractGlossyVisual).toHaveBeenCalledTimes(1);
	});

	it("skips the retry once too little of the attempt is left to start an extraction", async () => {
		activity.deadline = new Date(Date.now() + 10 * 60_000);
		detects([["Timeline and Milestones", "timeline"]]);
		extract.extractGlossyVisual.mockImplementation(async () => {
			// The first extraction uses up the attempt's time.
			activity.deadline?.setTime(Date.now() + 1_000);
			return REFUSED;
		});

		const result = await generateProposalVisuals(INPUT);

		expect(extract.extractGlossyVisual).toHaveBeenCalledTimes(1);
		expect(result.insertedCount).toBe(0);
		expect(activity.logger.info).toHaveBeenCalledWith(
			"Proposal visuals generated",
			expect.objectContaining({
				dropped: { factCheck: 1 },
				retried: 0,
			}),
		);
	});
});

describe("generateProposalVisuals — colour roles", () => {
	const RECIPIENT = {
		name: "Example Client",
		logoKey: null,
		colors: ["#10b981"],
	};

	it("reads the theme in the run's organization, for this project and document", async () => {
		detects([["Timeline and Milestones", "timeline"]]);

		await generateProposalVisuals(INPUT);

		expect(database.resolveProposalThemeTokens).toHaveBeenCalledWith({
			organizationId: "org-1",
			projectId: "project-1",
			documentId: "doc-1",
		});
	});

	it.each([
		["no brand source", {}],
		[
			"a Style, Brand kit and recipient that all set colours",
			{
				style: { primaryColor: "#1d4ed8", accentColors: ["#f59e0b"] },
				brandKit: {
					primaryColor: "#0f766e",
					accentColors: ["#be123c"],
				},
				recipient: RECIPIENT,
			},
		],
		[
			"the organization's website colours",
			{ vendorSite: { primaryColor: "#7c3aed", accentColors: [] } },
		],
	] as Array<[string, Partial<ProposalThemeSources>]>)(
		"writes the same colourless fence whatever the brand: %s",
		async (_, sources) => {
			database.resolveProposalThemeTokens.mockResolvedValue(
				brand(sources),
			);
			detects([["Timeline and Milestones", "timeline"]]);

			const result = await generateProposalVisuals(INPUT);

			const [{ visualId }] = storedSpecs();
			expect(result.content).toContain(
				toMermaidFence(TIMELINE_SOURCE, visualId),
			);
			expect(result.content).not.toMatch(/#[0-9a-f]{6}/i);
		},
	);
});

describe("generateProposalVisuals — figure templates (Fizzy #2946)", () => {
	const FLOW = {
		kind: "flow" as const,
		steps: [
			{ label: "Scope", description: "Agree what done looks like" },
			{ label: "Build" },
			{ label: "Review" },
		],
	};
	const LANED_FLOW = {
		kind: "flow" as const,
		steps: [
			{ label: "Scope", lane: "Client" },
			{ label: "Build", lane: "Delivery team" },
		],
	};
	const ORG_CHART = {
		kind: "org_chart" as const,
		nodes: [
			{ id: "lead", label: "Delivery lead", parentId: null },
			{ id: "dev", label: "Developer", parentId: "lead" },
		],
	};
	const LAYERS = {
		kind: "layers" as const,
		layers: [
			{ name: "Channels", components: ["Web shop", "Mobile app"] },
			{ name: "Services", components: ["Orders"] },
		],
		crosscutting: { name: "Operations", items: ["Monitoring"] },
	};
	const TEAM = {
		kind: "team" as const,
		proposer: {
			name: "Example Studio",
			members: [{ role: "Delivery lead", name: "Alex Example" }],
		},
		client: {
			name: "Example Retail",
			members: [{ role: "Product owner" }],
		},
		shared: "Weekly steering meeting",
	};
	const PALETTE: FigurePalette = {
		ink: "#16171a",
		onInk: "#ffffff",
		primary: "#c2410c",
		label: "#9a3412",
		onPrimary: "#ffffff",
		tint: "#fbefe9",
		border: "#d9dade",
		surface: "#ffffff",
		muted: "#5b5e66",
	};

	/** The one generated fence body after extracting `spec`. */
	async function generatedBody(spec: unknown): Promise<string> {
		extract.extractGlossyVisual.mockResolvedValue({
			status: "extracted",
			spec,
		});
		detects([["Timeline and Milestones", (spec as { kind: string }).kind]]);
		const result = await generateProposalVisuals(INPUT);
		const body = mermaidBodies(result.content).find((candidate) =>
			candidate.startsWith("%% fabric-visual:"),
		);
		if (!body) {
			throw new Error("no generated fence");
		}
		return body;
	}

	it.each([
		["a flow without lanes", FLOW, "process"],
		["a timeline", TIMELINE, "timeline"],
		["architecture layers", LAYERS, "layers"],
		["a team", TEAM, "team"],
	] as const)(
		"asks for the template on %s, after the marker and caption, and the template draws it",
		async (_, spec, kind) => {
			const body = await generatedBody(spec);

			const [{ visualId, kind: storedKind }] = storedSpecs();
			expect(storedKind).toBe(spec.kind);
			expect(body.split("\n").slice(0, 4)).toEqual([
				`%% fabric-visual: ${visualId}`,
				TIMELINE_CAPTION,
				`%% figure: ${kind}`,
				"flowchart TD",
			]);
			expect(readFigureKind(body)).toBe(kind);
			expect(parseFigureSource(body)).not.toBeNull();
			expect(renderFigureSvg(kind, body, PALETTE)).toMatch(/^<svg[\s>]/);
		},
	);

	it.each([
		["a flow with lanes", LANED_FLOW],
		["an org chart", ORG_CHART],
	] as const)(
		"leaves %s as Mermaid, with no figure line",
		async (_, spec) => {
			const body = await generatedBody(spec);

			expect(readFigureKind(body)).toBeNull();
			expect(body).not.toContain("%% figure:");
		},
	);

	it("keeps the largest layers and team the schema allows within what an edit reads", () => {
		const text = (prefix: string, max: number) =>
			`${prefix} ${"abcdefghij ".repeat(30)}`.slice(0, max).trim();
		const layers: LayersVisualSpec = {
			kind: "layers",
			title: text("Title", 60),
			layers: Array.from({ length: 8 }, (_, layer) => ({
				name: text(`Layer ${layer}`, 60),
				description: text("Purpose", 120),
				components: Array.from({ length: 5 }, (_, index) =>
					text(`Part ${index}`, 120),
				),
			})),
			crosscutting: {
				name: text("Across", 60),
				description: text("Detail", 120),
				items: Array.from({ length: 6 }, (_, index) =>
					text(`Item ${index}`, 120),
				),
			},
		};
		const side = (name: string) => ({
			name: text(name, 60),
			description: text("About", 120),
			members: Array.from({ length: 10 }, (_, index) => ({
				role: text(`Role ${index}`, 120),
				name: text("Person", 60),
				description: text("Owns", 240),
			})),
		});
		const team: TeamVisualSpec = {
			kind: "team",
			title: text("Title", 60),
			proposer: side("Ours"),
			client: side("Theirs"),
			shared: text("Forum", 120),
		};
		// The longest caption a fence keeps.
		const caption = text("Caption", DIAGRAM_CAPTION_MAX_CHARS);
		for (const spec of [layers, team]) {
			expect(proposalVisualSpecSchema.safeParse(spec).success).toBe(true);
			const body = toMermaidFenceBody(
				withFigureKind(
					`%% caption: ${caption}\n${visualSpecToMermaid(
						spec,
						proposalVisualTemplateOptions(spec),
					)}`,
					proposalFigureKind(spec),
				),
				"k3v9q2m7x1a8c4d6",
			);
			expect(body.length).toBeLessThan(GLOSSY_EDIT_SOURCE_MAX_CHARS);
			expect(renderFigureSvg(spec.kind, body, PALETTE)).toMatch(
				/^<svg[\s>]/,
			);
		}
	});

	it("stores the source hash the fence has with or without its figure line", async () => {
		const body = await generatedBody(FLOW);

		const [row] = storedSpecs();
		expect(row.sourceHash).toBe(visualSourceHash(body));
		expect(row.sourceHash).toBe(
			visualSourceHash(withFigureKind(body, null)),
		);
	});
});

describe("generateProposalVisuals — audience (Fizzy #2946)", () => {
	const WITH_APPENDIX = [
		MAIN,
		"",
		"## 7. Appendix A: Architecture",
		"",
		"The gateway calls the service, then the queue.",
		"",
		"## Anhang B – Datenfluss",
		"",
		"Der Dienst schreibt in die Warteschlange.",
		"",
		"## Appendices are not this",
		"",
		"Narrative.",
		"",
		"## The appendix",
		"",
		"Narrative.",
	].join("\n");

	it("marks appendix sections, numbering aside, and asks for Proposal guidance", async () => {
		detects([]);

		await generateProposalVisuals({ ...INPUT, content: WITH_APPENDIX });

		const call = detectionCall();
		expect(call.proposalArtifact).toBe(true);
		expect(
			call.sections.map((section) => [
				section.heading,
				section.appendix === true,
			]),
		).toEqual([
			["Timeline and Milestones", false],
			["Options", false],
			["Payment Schedule", false],
			["7. Appendix A: Architecture", true],
			["Anhang B – Datenfluss", true],
			["Appendices are not this", false],
			["The appendix", false],
		]);
	});

	it("leaves the cover letter, and anything under it, without a visual, and a later section of that name with one", async () => {
		detects([]);
		const content = [
			"# Example Proposal",
			"",
			"## Cover letter",
			"",
			"30 October 2026",
			"",
			"Dear Example Retail, here is our plan for March, April and May.",
			"",
			"### Postscript",
			"",
			"First we plan, then we build.",
			"",
			"## 1. Anschreiben",
			"",
			"Sehr geehrte Damen und Herren, zuerst planen wir, dann bauen wir.",
			"",
			"## 2. Timeline",
			"",
			"Discovery runs in March, build in April and launch in May.",
			"",
			"## Cover letters we wrote before",
			"",
			"Two letters, one in March and one in May.",
		].join("\n");

		await generateProposalVisuals({ ...INPUT, content });

		// Only the first H2 opens a letter, so the export prints the second
		// as a section, and it may have a visual like any other.
		expect(
			detectionCall().sections.map((section) => section.heading),
		).toEqual([
			"1. Anschreiben",
			"2. Timeline",
			"Cover letters we wrote before",
		]);
	});

	/** Main with `heading` as its first H2, or `heading` as written later. */
	const firstSection = (heading: string) =>
		[
			"# Example Proposal",
			"",
			`## ${heading}`,
			"",
			"Discovery runs in March, build in April and launch in May.",
			"",
			"## Overview",
			"",
			"The pilot covers three depots over twelve weeks.",
		].join("\n");
	const afterOverview = (headingLine: string) =>
		[
			"# Example Proposal",
			"",
			"## Overview",
			"",
			"The pilot covers three depots over twelve weeks.",
			"",
			headingLine,
			"",
			"Discovery runs in March, build in April and launch in May.",
		].join("\n");

	it.each([
		["Cover letter", true, firstSection("Cover letter")],
		["1. Cover letter:", true, firstSection("1. Cover letter:")],
		["1: Cover letter", true, firstSection("1: Cover letter")],
		["1\\. Cover letter", true, firstSection("1\\. Cover letter")],
		["**Cover letter**", true, firstSection("**Cover letter**")],
		["Cover letter [S1]", true, firstSection("Cover letter [S1]")],
		["Anschreiben", true, firstSection("Anschreiben")],
		["cover letter.", true, firstSection("cover letter.")],
		["A. Cover letter", false, firstSection("A. Cover letter")],
		[
			"Cover letter and terms",
			false,
			firstSection("Cover letter and terms"),
		],
		["Cover letter", false, afterOverview("## Cover letter")],
		["Cover letter", false, afterOverview("### Cover letter")],
	] as const)(
		"treats %j as the export does: a letter %s",
		async (heading, letter, content) => {
			detects([]);

			await generateProposalVisuals({ ...INPUT, content });

			expect(
				coverLetter(prepareExportMarkdown(content).root) !== null,
			).toBe(letter);
			expect(
				detectionCall().sections.some(
					(section) => section.heading === heading,
				),
			).toBe(!letter);
		},
	);

	it("asks extraction for Proposal labels", async () => {
		detects([["Timeline and Milestones", "timeline"]]);

		await generateProposalVisuals(INPUT);

		expect(extract.extractGlossyVisual).toHaveBeenCalledWith(
			expect.objectContaining({
				documentType: "PROPOSAL",
				proposalArtifact: true,
			}),
		);
	});
});

describe("generateProposalVisuals — turned off in Style (Fizzy #2946)", () => {
	it("returns the content unchanged without a model call and logs why", async () => {
		database.resolveProposalThemeTokens.mockResolvedValue(
			brand({}, null, false),
		);
		detects([["Timeline and Milestones", "timeline"]]);

		const result = await generateProposalVisuals(INPUT);

		expect(result).toEqual({ content: MAIN, insertedCount: 0 });
		expect(detect.detectGlossyOpportunities).not.toHaveBeenCalled();
		expect(extract.extractGlossyVisual).not.toHaveBeenCalled();
		expect(database.appendProposalVisualSpec).not.toHaveBeenCalled();
		expect(activity.logger.info).toHaveBeenCalledWith(
			"Proposal visuals skipped",
			{
				projectId: "project-1",
				documentId: "doc-1",
				liveRunId: "live-run-1",
				reason: "disabled",
			},
		);
	});

	it("keeps every diagram already in Main byte for byte", async () => {
		database.resolveProposalThemeTokens.mockResolvedValue(
			brand({}, null, false),
		);
		const withGenerated = MAIN.replace(
			"## Options",
			`${toMermaidFence(TIMELINE_SOURCE, "abcdefgh12345678")}\n\n## Options`,
		);

		const result = await generateProposalVisuals({
			...INPUT,
			content: withGenerated,
		});

		expect(result.content).toBe(withGenerated);
	});

	it("runs as before when the theme reads it as on, as it does without a Style row", async () => {
		detects([["Timeline and Milestones", "timeline"]]);

		const result = await generateProposalVisuals(INPUT);

		expect(result.insertedCount).toBe(1);
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
			"the brand cannot be read",
			() => {
				detects([["Timeline and Milestones", "timeline"]]);
				database.resolveProposalThemeTokens.mockRejectedValue(
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
			expect.objectContaining({ dropped: { error: 1 }, inserted: 2 }),
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
