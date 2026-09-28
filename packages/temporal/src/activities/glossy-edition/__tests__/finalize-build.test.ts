/**
 * `finalizeGlossyBuildActivity` (Fizzy #2589, R8, R16, R19, R21, R22, R30,
 * R43, KTD5, KTD8, KTD15, AE8): the edition assembled in document order from
 * the snapshot and the cache rows, validated, handed to the U2 finalize
 * transaction, and audited only when that write applied.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ glossyEdition: { findUnique: vi.fn() } }));
const database = vi.hoisted(() => ({
	getGlossyBuildSnapshot: vi.fn(),
	heartbeatGlossyBuild: vi.fn(),
	markGlossyBuildSuperseded: vi.fn(),
	getCacheEntries: vi.fn(),
	finalizeGlossyBuild: vi.fn(),
	recordAudit: vi.fn(),
}));

vi.mock("@repo/database", () => ({ db, ...database }));
vi.mock("../../../lib/glossy/model", () => ({
	GLOSSY_AI_PROVIDER_NOT_CONFIGURED_MESSAGE: "Configure an AI provider.",
}));

import { GLOSSY_PIPELINE_VERSION } from "@repo/agent-prompts/glossy";
import {
	type EditionContent,
	editionContentSchema,
	GLOSSY_APPENDIX_SECTION_KEY,
} from "@repo/utils/glossy/edition-content";
import {
	computeDetectedVisualKey,
	computeMermaidVisualKey,
	computeSlotVisualKey,
} from "@repo/utils/glossy/keys";
import { finalizeGlossyBuildActivity } from "../finalize-build";
import { planGlossyVisuals } from "../prepare-build";
import {
	glossyDetectionKey,
	normalizeBuildOptions,
	priorDetectedVisuals,
} from "../shared";
import type {
	ExtractGlossyVisualActivityResult,
	FinalizeGlossyBuildActivityInput,
} from "../types";
import {
	DOCUMENT,
	REF,
	sectionsOf,
	snapshotOf,
	verdict,
} from "./glossy-fixtures";

const [EXEC, APPROACH, TEAM] = sectionsOf();
const version = GLOSSY_PIPELINE_VERSION;

/** A first Roll-the-dice build's detection: over every section of the snapshot. */
const DETECTION_KEY = glossyDetectionKey([EXEC, APPROACH, TEAM], "PROPOSAL");

const SLOT_KEY = computeSlotVisualKey({
	slotId: "slot-1",
	sectionKey: EXEC.key,
	pipelineVersion: version,
});
const TEAM_KEY = computeDetectedVisualKey({
	sectionKey: TEAM.key,
	kind: "org_chart",
	pipelineVersion: version,
});
const MERMAID_KEY = computeMermaidVisualKey({
	source: "graph TD; A-->B",
	pipelineVersion: version,
});

const TIMELINE = {
	kind: "timeline",
	items: [
		{ date: "Q3 2026", label: "Pilot starts" },
		{ date: "Q4 2026", label: "Rollout" },
	],
} as const;
const ORG_CHART = {
	kind: "org_chart",
	nodes: [
		{ id: "a", label: "Alex", parentId: null },
		{ id: "s", label: "Sam", parentId: "a" },
	],
} as const;

type CacheKind = "REWRITE" | "EXTRACTION" | "DETECTION";
let cache: Record<CacheKind, Map<string, unknown>>;

const SLOT_RESULT: ExtractGlossyVisualActivityResult = {
	sectionKey: EXEC.key,
	slotId: "slot-1",
	visualKey: SLOT_KEY,
	outcome: "extracted",
	kind: "timeline",
	cacheKey: "ex-slot",
	fromCache: false,
};
const TEAM_RESULT: ExtractGlossyVisualActivityResult = {
	sectionKey: TEAM.key,
	slotId: null,
	visualKey: TEAM_KEY,
	outcome: "extracted",
	kind: "org_chart",
	cacheKey: "ex-team",
	fromCache: true,
};

function input(
	overrides: Partial<FinalizeGlossyBuildActivityInput> = {},
): FinalizeGlossyBuildActivityInput {
	return {
		...REF,
		documentType: "PROPOSAL",
		options: { mode: "roll_the_dice", lengthMode: "brief" },
		rewrites: [
			{
				sectionKey: EXEC.key,
				outcome: "rewritten",
				cacheKey: "rw-exec",
				fromCache: false,
			},
			{
				sectionKey: APPROACH.key,
				outcome: "keptOriginal",
				reason: "fact_guard",
			},
			{
				sectionKey: TEAM.key,
				outcome: "rewritten",
				cacheKey: "rw-team",
				fromCache: true,
			},
		],
		visuals: [SLOT_RESULT, TEAM_RESULT],
		detectionCacheKey: DETECTION_KEY,
		...overrides,
	};
}

/** The content handed to the finalize transaction. */
function written(): EditionContent {
	return database.finalizeGlossyBuild.mock.calls[0][0].content;
}

beforeEach(() => {
	vi.clearAllMocks();
	cache = {
		REWRITE: new Map<string, unknown>([
			[
				"rw-exec",
				{ markdown: "Example Org pilots for $240k from Q3 2026." },
			],
			["rw-team", { markdown: "Alex leads delivery; Sam owns design." }],
		]),
		EXTRACTION: new Map<string, unknown>([
			["ex-slot", { spec: TIMELINE }],
			["ex-team", { spec: ORG_CHART }],
		]),
		DETECTION: new Map<string, unknown>([
			[
				DETECTION_KEY,
				{
					opportunities: [
						{
							sectionKey: TEAM.key,
							kind: "org_chart",
							reason: "Roles and ownership",
						},
					],
				},
			],
		]),
	};
	database.getCacheEntries.mockImplementation(
		async (query: { kind: CacheKind; cacheKeys: string[] }) =>
			new Map(
				query.cacheKeys.flatMap((key) =>
					cache[query.kind].has(key)
						? [[key, cache[query.kind].get(key)] as const]
						: [],
				),
			),
	);
	db.glossyEdition.findUnique.mockImplementation(
		async (query: { select: Record<string, boolean> }) =>
			query.select.content
				? { content: null }
				: {
						id: "edition-1",
						publishedBuildId: null,
						currentBuildId: "build-1",
						contentRevision: 0,
					},
	);
	database.getGlossyBuildSnapshot.mockResolvedValue(snapshotOf());
	database.heartbeatGlossyBuild.mockResolvedValue("applied");
	database.markGlossyBuildSuperseded.mockResolvedValue("marked");
	database.finalizeGlossyBuild.mockResolvedValue({
		outcome: "applied",
		editionId: "edition-1",
		contentRevision: 1,
	});
});

describe("finalizeGlossyBuildActivity — assembly", () => {
	it("assembles the sections in document order with their anchors and visuals", async () => {
		await expect(finalizeGlossyBuildActivity(input())).resolves.toEqual({
			outcome: "applied",
			editionId: "edition-1",
			contentRevision: 1,
		});

		const content = written();
		expect(editionContentSchema.safeParse(content).success).toBe(true);
		expect(content.sections.map((section) => section.sectionKey)).toEqual([
			EXEC.key,
			APPROACH.key,
			TEAM.key,
		]);

		const [exec, approach, team] = content.sections;
		expect(exec).toMatchObject({
			heading: "Executive Summary",
			markdown: "Example Org pilots for $240k from Q3 2026.",
			wording: "rewritten",
			anchors: [
				{ blockIndex: 1, ref: { type: "visual", visualKey: SLOT_KEY } },
			],
		});
		expect(exec.keptOriginalReason).toBeUndefined();
		expect(approach).toMatchObject({
			markdown: "First we discover. Then we build.\n\nClosing paragraph.",
			wording: "original",
			keptOriginalReason: "fact_guard",
			anchors: [
				{
					blockIndex: 1,
					ref: { type: "visual", visualKey: MERMAID_KEY },
				},
				{
					blockIndex: 2,
					ref: {
						type: "image",
						s3Key: "document-media/proj-1/abc.png",
					},
				},
			],
		});
		// A detected visual follows the section's last block (R19).
		expect(team.anchors).toEqual([
			{ blockIndex: 1, ref: { type: "visual", visualKey: TEAM_KEY } },
		]);

		expect(content.visuals).toEqual({
			[SLOT_KEY]: expect.objectContaining({
				kind: "timeline",
				spec: TIMELINE,
				source: "slot",
			}),
			[MERMAID_KEY]: expect.objectContaining({
				kind: "existing_mermaid",
				spec: { kind: "existing_mermaid", source: "graph TD; A-->B" },
				source: "existing_mermaid",
			}),
			[TEAM_KEY]: expect.objectContaining({
				kind: "org_chart",
				source: "detected",
				reason: "Roles and ownership",
			}),
		});
		// Raw diagram source never reaches section text (R13).
		expect(approach.markdown).not.toContain("graph TD");
	});

	it("writes the report and the provenance line (R16, R43)", async () => {
		await finalizeGlossyBuildActivity(input());

		const content = written();
		expect(content.report).toEqual({
			keptOriginal: [{ heading: "Approach", reason: "fact_guard" }],
			droppedVisuals: [],
			unfilledSlots: [],
			scaffoldingUnrecognized: true,
			detectedSectionKeys: [EXEC.key, APPROACH.key, TEAM.key],
		});
		expect(content.provenance).toEqual({
			sourceTitle: "Example Proposal",
			sourceVersion: 7,
			builtAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
		});
		expect(content).toMatchObject({
			title: "Example Proposal",
			pipelineVersion: version,
			lengthMode: "brief",
			mode: "roll_the_dice",
		});
		expect(database.finalizeGlossyBuild.mock.calls[0][0].report).toEqual(
			content.report,
		);
	});

	it("hands U2 every section key, the appendix's included, and the cache rows it used", async () => {
		await finalizeGlossyBuildActivity(input());

		const call = database.finalizeGlossyBuild.mock.calls[0][0];
		expect(call.buildId).toBe("build-1");
		// The appendix key keeps a decision on an appendix-only diagram through
		// the rebuild's decision prune (R29).
		expect(call.sectionKeys).toEqual([
			EXEC.key,
			APPROACH.key,
			TEAM.key,
			GLOSSY_APPENDIX_SECTION_KEY,
		]);
		expect(call.usedCacheKeys).toEqual(
			expect.arrayContaining([
				{ kind: "REWRITE", cacheKey: "rw-exec" },
				{ kind: "REWRITE", cacheKey: "rw-team" },
				{ kind: "EXTRACTION", cacheKey: "ex-slot" },
				{ kind: "EXTRACTION", cacheKey: "ex-team" },
				{ kind: "DETECTION", cacheKey: DETECTION_KEY },
			]),
		);
		expect(call.usedCacheKeys).toHaveLength(5);
	});

	it("clamps anchors to a shorter rewrite's blocks", async () => {
		cache.REWRITE.set("rw-approach", {
			markdown: "We discover, then build.",
		});
		await finalizeGlossyBuildActivity(
			input({
				rewrites: [
					{
						sectionKey: APPROACH.key,
						outcome: "rewritten",
						cacheKey: "rw-approach",
						fromCache: false,
					},
				],
			}),
		);

		const approach = written().sections[1];
		expect(approach.wording).toBe("rewritten");
		expect(approach.anchors.map((anchor) => anchor.blockIndex)).toEqual([
			1, 1,
		]);
	});

	it("keeps the original wording when a rewrite's cache row is gone", async () => {
		cache.REWRITE.delete("rw-exec");
		await finalizeGlossyBuildActivity(input());

		const content = written();
		expect(content.sections[0]).toMatchObject({
			wording: "original",
			keptOriginalReason: "rewrite_unavailable",
		});
		expect(content.report.keptOriginal).toContainEqual({
			heading: "Executive Summary",
			reason: "rewrite_unavailable",
		});
	});

	it("builds an edition with an empty visual map when nothing was found (AE8)", async () => {
		const plain = DOCUMENT.replace(
			/<visual-slot[^\n]*\n|```mermaid\ngraph TD; A-->B\n```\n|<img[^\n]*/g,
			"",
		);
		database.getGlossyBuildSnapshot.mockResolvedValue(snapshotOf(plain));
		const keys = sectionsOf(plain).map((entry) => entry.key);

		await finalizeGlossyBuildActivity(
			input({
				rewrites: keys.map((sectionKey) => ({
					sectionKey,
					outcome: "keptOriginal" as const,
					reason: "fact_guard" as const,
				})),
				visuals: [],
				detectionCacheKey: null,
			}),
		);

		const content = written();
		expect(content.sections).toHaveLength(3);
		expect(content.visuals).toEqual({});
		expect(content.report.droppedVisuals).toEqual([]);
		expect(content.report.unfilledSlots).toEqual([]);
		expect(editionContentSchema.safeParse(content).success).toBe(true);
	});

	it("reports dropped visuals and unfilled slots with their reasons, with no anchor left behind (R18, R22)", async () => {
		await finalizeGlossyBuildActivity(
			input({
				visuals: [
					{
						...SLOT_RESULT,
						outcome: "dropped",
						kind: "timeline",
						reason: "fact_check",
					},
					{
						...TEAM_RESULT,
						outcome: "dropped",
						kind: "org_chart",
						reason: "invalid_spec",
					},
				],
			}),
		);

		const content = written();
		expect(content.report.unfilledSlots).toEqual([
			{ slotId: "slot-1", reason: "fact_check" },
		]);
		expect(content.report.droppedVisuals).toEqual([
			{ kind: "org_chart", heading: "Team", reason: "invalid_spec" },
		]);
		expect(content.sections[0].anchors).toEqual([]);
		expect(content.sections[2].anchors).toEqual([]);
		expect(Object.keys(content.visuals)).toEqual([MERMAID_KEY]);
	});

	it("lets a slot override a detected visual of the same kind in its section", async () => {
		const detectedTimeline = computeDetectedVisualKey({
			sectionKey: EXEC.key,
			kind: "timeline",
			pipelineVersion: version,
		});
		cache.EXTRACTION.set("ex-exec-detected", { spec: TIMELINE });
		await finalizeGlossyBuildActivity(
			input({
				visuals: [
					SLOT_RESULT,
					{
						sectionKey: EXEC.key,
						slotId: null,
						visualKey: detectedTimeline,
						outcome: "extracted",
						kind: "timeline",
						cacheKey: "ex-exec-detected",
						fromCache: false,
					},
				],
			}),
		);

		const content = written();
		expect(content.visuals[detectedTimeline]).toBeUndefined();
		expect(content.sections[0].anchors).toHaveLength(1);
	});
});

describe("finalizeGlossyBuildActivity — detection coverage (KTD9)", () => {
	const rollTheDice = normalizeBuildOptions({
		mode: "roll_the_dice",
		lengthMode: "brief",
	});

	/** What the next Roll-the-dice build of the same body plans from `content`. */
	function nextPlan(content: EditionContent) {
		return planGlossyVisuals({
			sections: [EXEC, APPROACH, TEAM],
			options: rollTheDice,
			prior: priorDetectedVisuals(content),
		});
	}

	/** Serve `content` as the published edition a rebuild reads. */
	function usePublished(content: EditionContent) {
		db.glossyEdition.findUnique.mockImplementation(
			async (query: { select: Record<string, boolean> }) =>
				query.select.content
					? { content }
					: {
							id: "edition-1",
							publishedBuildId: "build-0",
							currentBuildId: "build-1",
							contentRevision: 1,
						},
		);
	}

	it("records the sections a completed detection covered; the next rebuild pins instead of detecting", async () => {
		await finalizeGlossyBuildActivity(input());

		const content = written();
		expect(content.report.detectedSectionKeys).toEqual([
			EXEC.key,
			APPROACH.key,
			TEAM.key,
		]);
		expect(nextPlan(content)).toMatchObject({
			opportunities: [{ sectionKey: TEAM.key, kind: "org_chart" }],
			detection: null,
		});
	});

	it("records none for a degraded detection, so the next rebuild detects over those sections again", async () => {
		// The workflow planned detection, and the call degraded: no cache key
		// and no detected visual.
		await finalizeGlossyBuildActivity(
			input({ visuals: [SLOT_RESULT], detectionCacheKey: null }),
		);

		const content = written();
		expect(content.report.detectedSectionKeys).toEqual([]);
		expect(nextPlan(content)).toMatchObject({
			opportunities: [],
			detection: {
				sectionKeys: [EXEC.key, APPROACH.key, TEAM.key],
				limit: 8,
			},
		});
	});

	it("keeps the published edition's coverage and adds only what this rebuild's detection completed", async () => {
		// The published edition: Executive Summary and Team covered, while
		// Approach's detection degraded.
		await finalizeGlossyBuildActivity(
			input({ visuals: [SLOT_RESULT], detectionCacheKey: null }),
		);
		const first = written();
		const prior: EditionContent = {
			...first,
			report: {
				...first.report,
				detectedSectionKeys: [EXEC.key, TEAM.key],
			},
		};
		expect(nextPlan(prior).detection).toEqual({
			sectionKeys: [APPROACH.key],
			limit: 8,
		});
		usePublished(prior);

		// The rebuild's detection over Approach degrades again: still uncovered.
		await finalizeGlossyBuildActivity(
			input({ visuals: [SLOT_RESULT], detectionCacheKey: null }),
		);
		expect(
			database.finalizeGlossyBuild.mock.calls[1][0].content.report
				.detectedSectionKeys,
		).toEqual([EXEC.key, TEAM.key]);

		// The next one completes: Approach is covered from now on.
		await finalizeGlossyBuildActivity(
			input({
				visuals: [SLOT_RESULT],
				detectionCacheKey: glossyDetectionKey([APPROACH], "PROPOSAL"),
			}),
		);
		const rebuilt: EditionContent =
			database.finalizeGlossyBuild.mock.calls[2][0].content;
		expect(rebuilt.report.detectedSectionKeys).toEqual([
			EXEC.key,
			APPROACH.key,
			TEAM.key,
		]);
		expect(nextPlan(rebuilt).detection).toBeNull();
	});

	it("records no coverage for a detection key it cannot tie to the sections the build planned", async () => {
		await finalizeGlossyBuildActivity(
			input({ visuals: [SLOT_RESULT], detectionCacheKey: "det-other" }),
		);

		expect(written().report.detectedSectionKeys).toEqual([]);
	});

	it("an Align-first build covers every section: the editor aligned them all", async () => {
		await finalizeGlossyBuildActivity(
			input({
				options: { mode: "align_first", lengthMode: "brief" },
				visuals: [SLOT_RESULT],
				detectionCacheKey: null,
			}),
		);

		expect(written().report.detectedSectionKeys).toEqual([
			EXEC.key,
			APPROACH.key,
			TEAM.key,
		]);
	});
});

describe("finalizeGlossyBuildActivity — the guarded write", () => {
	it("records `built` once the write applied, with counts and no content", async () => {
		await finalizeGlossyBuildActivity(input());

		expect(database.recordAudit).toHaveBeenCalledTimes(1);
		const audit = database.recordAudit.mock.calls[0][0];
		expect(audit).toMatchObject({
			action: "project.glossy_edition.built",
			actor: { type: "user", userId: "user-1" },
			organizationId: "org-1",
			projectId: "proj-1",
			resource: { type: "project_document", id: "doc-1" },
			metadata: expect.objectContaining({
				buildId: "build-1",
				editionId: "edition-1",
				visuals: 3,
				keptOriginal: 1,
			}),
		});
		expect(JSON.stringify(audit)).not.toContain("Example Org");
	});

	it("marks its own attempt superseded and records nothing when the write lost the claim", async () => {
		database.finalizeGlossyBuild.mockResolvedValue({
			outcome: "superseded",
		});

		await expect(finalizeGlossyBuildActivity(input())).resolves.toEqual({
			outcome: "superseded",
		});
		expect(database.markGlossyBuildSuperseded).toHaveBeenCalledWith(
			"build-1",
		);
		expect(database.recordAudit).not.toHaveBeenCalled();
	});

	it("stops before assembling when the guard fails", async () => {
		database.heartbeatGlossyBuild.mockResolvedValue("superseded");

		await expect(finalizeGlossyBuildActivity(input())).rejects.toEqual(
			verdict("SUPERSEDED"),
		);
		expect(database.finalizeGlossyBuild).not.toHaveBeenCalled();
		expect(database.recordAudit).not.toHaveBeenCalled();
	});

	it("reports progress as finalizing with every section done", async () => {
		await finalizeGlossyBuildActivity(input());

		expect(database.heartbeatGlossyBuild).toHaveBeenCalledWith("build-1", {
			step: "finalizing",
			sectionsDone: 3,
			sectionsTotal: 3,
		});
	});

	it("answers a retry after an applied finalize without writing again", async () => {
		db.glossyEdition.findUnique.mockResolvedValue({
			id: "edition-1",
			publishedBuildId: "build-1",
			currentBuildId: null,
			contentRevision: 4,
		});

		await expect(finalizeGlossyBuildActivity(input())).resolves.toEqual({
			outcome: "applied",
			editionId: "edition-1",
			contentRevision: 4,
		});
		expect(database.finalizeGlossyBuild).not.toHaveBeenCalled();
		expect(database.recordAudit).not.toHaveBeenCalled();
	});

	it("reads Align first's reasons from the whole-document detection row", async () => {
		await finalizeGlossyBuildActivity(
			input({
				options: { mode: "align_first", lengthMode: "brief" },
				detectionCacheKey: null,
			}),
		);

		const detectionQuery = database.getCacheEntries.mock.calls.find(
			([query]) => query.kind === "DETECTION",
		)?.[0];
		// The whole-document key: the request's detection wrote it, and a
		// first Roll-the-dice detection over the same sections shares it.
		expect(detectionQuery.cacheKeys).toEqual([DETECTION_KEY]);
		// No published edition is read for pinned reasons in Align first.
		expect(
			db.glossyEdition.findUnique.mock.calls.some(
				([query]) => query.select.content,
			),
		).toBe(false);
	});
});
