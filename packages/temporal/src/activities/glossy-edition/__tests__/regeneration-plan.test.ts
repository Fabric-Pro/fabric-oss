/**
 * `planGlossyRegeneration` parity (Fizzy #2589, KTD8, KTD10, R8, R27).
 *
 * Single-visual regenerate runs in the request: it re-plans the visual from
 * the published attempt's own snapshot and writes the replacement spec to
 * the segment cache through `applyVisualRegeneration`. That write only
 * sticks when it lands under exactly the key the build's extract activity
 * reads. Under any other key nothing fails loudly: the next rebuild of the
 * unchanged section finds the ORIGINAL spec under the build's key, reuses
 * it, and silently reverts the regenerated visual — and with it the review
 * of the spec the editor saw.
 *
 * These tests run the build's real prepare and extract activities (the
 * workflow's task list, reproduced) over a snapshot, and prove the plan the
 * regenerate procedure computes names the same visual and the same cache
 * key, for a detected visual, a slot with a kind, and a best-fit slot. Then
 * a rebuild of the same body, with the regenerated spec cached under that
 * key, publishes the regenerated spec without a model call.
 *
 * The database and the model are mocked; cleanup and keys are real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	projectDocument: { findUnique: vi.fn() },
	glossyEdition: { findUnique: vi.fn() },
}));
const database = vi.hoisted(() => ({
	getGlossyBuildSnapshot: vi.fn(),
	heartbeatGlossyBuild: vi.fn(),
	markGlossyBuildSuperseded: vi.fn(),
	isFeatureEnabled: vi.fn(),
	canEditProject: vi.fn(),
	getCacheEntries: vi.fn(),
	putCacheEntry: vi.fn(),
	finalizeGlossyBuild: vi.fn(),
	recordAudit: vi.fn(),
}));
const model = vi.hoisted(() => ({
	resolveGlossyModel: vi.fn(),
	extractGlossyVisual: vi.fn(),
}));

vi.mock("@repo/database", () => ({ db, ...database }));
vi.mock("../../../lib/glossy/model", () => ({
	resolveGlossyModel: model.resolveGlossyModel,
	GLOSSY_AI_PROVIDER_NOT_CONFIGURED_MESSAGE: "Configure an AI provider.",
}));
vi.mock("../../../lib/glossy/extract-visual", () => ({
	extractGlossyVisual: model.extractGlossyVisual,
}));

import type { EditionContent } from "@repo/utils/glossy/edition-content";
import {
	type OrgChartVisualSpec,
	specHash,
	type TimelineVisualSpec,
} from "@repo/utils/glossy/visual-spec";
import { extractGlossyVisualActivity } from "../extract-visual";
import { finalizeGlossyBuildActivity } from "../finalize-build";
import { prepareGlossyBuildActivity } from "../prepare-build";
import {
	glossyExtractedVisualKey,
	planGlossyKeys,
	planGlossyRegeneration,
} from "../shared";
import type {
	ExtractGlossyVisualActivityResult,
	GlossyBuildOptions,
} from "../types";
import { DOCUMENT, REF, snapshotOf } from "./glossy-fixtures";

type CacheKind = "REWRITE" | "EXTRACTION" | "DETECTION";
let cache: Record<CacheKind, Map<string, unknown>>;

const TIMELINE: TimelineVisualSpec = {
	kind: "timeline",
	items: [
		{ date: "Q3 2026", label: "Pilot" },
		{ date: "Q4 2026", label: "Rollout" },
	],
};
const REGENERATED_TIMELINE: TimelineVisualSpec = {
	kind: "timeline",
	title: "Pilot plan",
	items: [
		{ date: "Q3 2026", label: "Pilot starts" },
		{ date: "Q4 2026", label: "Rollout" },
	],
};
const ORG_CHART: OrgChartVisualSpec = {
	kind: "org_chart",
	nodes: [
		{ id: "a", label: "Alex", parentId: null },
		{ id: "s", label: "Sam", parentId: "a" },
	],
};

/**
 * Align first with a style direction the editor typed loosely: the build
 * bounds it once, so the regenerate side must bound the same raw value once.
 */
function alignFirst(teamKey: string): GlossyBuildOptions {
	return {
		mode: "align_first",
		lengthMode: "brief",
		styleDirection: "  Calm   and\nprecise ",
		confirmedOpportunities: [{ sectionKey: teamKey, kind: "org_chart" }],
	};
}

/** The build's own snapshot of `content`, recording `options` as the claim does. */
function useSnapshot(content: string, options: GlossyBuildOptions) {
	// Stored as JSON on the attempt, as the claim records it.
	const snapshot = snapshotOf(content, {
		options: JSON.parse(JSON.stringify(options)),
	});
	database.getGlossyBuildSnapshot.mockResolvedValue(snapshot);
	return snapshot;
}

/**
 * What the workflow does between prepare and finalize: one extract activity
 * per slot, then per opportunity, each with `options.styleDirection ?? null`.
 */
async function runExtractions(
	options: GlossyBuildOptions,
): Promise<ExtractGlossyVisualActivityResult[]> {
	const plan = await prepareGlossyBuildActivity({ ...REF, options });
	const tasks = [
		...plan.slots.map((slot) => ({
			sectionKey: slot.sectionKey,
			kind: slot.kind,
			slotId: slot.slotId,
		})),
		...plan.opportunities.map((opportunity) => ({
			sectionKey: opportunity.sectionKey,
			kind: opportunity.kind,
			slotId: null,
		})),
	];
	const results: ExtractGlossyVisualActivityResult[] = [];
	for (const task of tasks) {
		results.push(
			await extractGlossyVisualActivity({
				...REF,
				documentType: plan.documentType,
				sectionKey: task.sectionKey,
				kind: task.kind,
				slotId: task.slotId,
				styleDirection: options.styleDirection ?? null,
				progress: { sectionsDone: 0, sectionsTotal: 3 },
			}),
		);
	}
	return results;
}

/** What the regenerate procedure computes from the published attempt. */
function regenerationPlan(
	content: string,
	result: Extract<
		ExtractGlossyVisualActivityResult,
		{ outcome: "extracted" }
	>,
	visual: { source: "detected" | "slot"; kind: string },
	options: GlossyBuildOptions,
) {
	const keyed = planGlossyKeys({
		content,
		projectId: REF.projectId,
		documentType: "PROPOSAL",
	}).sections.find((entry) => entry.key === result.sectionKey);
	if (!keyed) {
		throw new Error("the snapshot has no such section");
	}
	return planGlossyRegeneration({
		sectionKey: keyed.key,
		section: keyed.section,
		visualKey: result.visualKey,
		visual,
		// The attempt's recorded options, as `getGlossyBuildSnapshot` returns them.
		buildOptions: JSON.parse(JSON.stringify(options)),
	});
}

function extracted(
	results: ExtractGlossyVisualActivityResult[],
	predicate: (result: ExtractGlossyVisualActivityResult) => boolean,
) {
	const result = results.find(predicate);
	if (result?.outcome !== "extracted") {
		throw new Error("expected an extracted visual");
	}
	return result;
}

beforeEach(() => {
	vi.clearAllMocks();
	cache = { REWRITE: new Map(), EXTRACTION: new Map(), DETECTION: new Map() };
	db.projectDocument.findUnique.mockResolvedValue({
		projectId: REF.projectId,
		organizationId: REF.organizationId,
		type: "PROPOSAL",
		status: "COMPLETE",
		project: { organizationId: REF.organizationId, deletedAt: null },
	});
	db.glossyEdition.findUnique.mockImplementation(
		async (query: { select: Record<string, boolean> }) =>
			query.select.content
				? { content: null }
				: {
						id: "edition-1",
						publishedBuildId: null,
						currentBuildId: REF.buildId,
						contentRevision: 0,
					},
	);
	database.heartbeatGlossyBuild.mockResolvedValue("applied");
	database.markGlossyBuildSuperseded.mockResolvedValue("marked");
	database.isFeatureEnabled.mockResolvedValue(true);
	database.canEditProject.mockResolvedValue(true);
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
	database.putCacheEntry.mockImplementation(
		async (entry: {
			kind: CacheKind;
			cacheKey: string;
			output: unknown;
		}) => {
			cache[entry.kind].set(entry.cacheKey, entry.output);
			return "applied";
		},
	);
	database.finalizeGlossyBuild.mockResolvedValue({
		outcome: "applied",
		editionId: "edition-1",
		contentRevision: 2,
	});
	model.resolveGlossyModel.mockResolvedValue({ status: "resolved" });
	model.extractGlossyVisual.mockImplementation(
		async (input: { kind: string }) => ({
			status: "extracted",
			spec: input.kind === "org_chart" ? ORG_CHART : TIMELINE,
		}),
	);
});

describe("planGlossyRegeneration — the build's own extraction key", () => {
	it("a detected visual: same visual key, same cache key, the style direction bounded once", async () => {
		const [, , team] = planGlossyKeys({
			content: DOCUMENT,
			projectId: REF.projectId,
			documentType: "PROPOSAL",
		}).sections;
		const options = alignFirst(team.key);
		useSnapshot(DOCUMENT, options);

		const results = await runExtractions(options);
		const built = extracted(results, (result) => result.slotId === null);
		const plan = regenerationPlan(
			DOCUMENT,
			built,
			{ source: "detected", kind: "org_chart" },
			options,
		);

		expect(plan).toEqual({
			sectionKey: team.key,
			visualKey: built.visualKey,
			slotId: null,
			kind: "org_chart",
			requestKind: "org_chart",
			slotHint: null,
			styleDirection: "Calm and precise",
			cacheKey: built.cacheKey,
		});
		// The build asked the model with the same bounded style direction.
		expect(model.extractGlossyVisual).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "org_chart",
				styleDirection: "Calm and precise",
			}),
		);
	});

	it("a slot that asks for a kind: same keys, with the slot's hint from the snapshot", async () => {
		const [, , team] = planGlossyKeys({
			content: DOCUMENT,
			projectId: REF.projectId,
			documentType: "PROPOSAL",
		}).sections;
		const options = alignFirst(team.key);
		useSnapshot(DOCUMENT, options);

		const results = await runExtractions(options);
		const built = extracted(
			results,
			(result) => result.slotId === "slot-1",
		);
		const plan = regenerationPlan(
			DOCUMENT,
			built,
			{ source: "slot", kind: "timeline" },
			options,
		);

		expect(plan).toMatchObject({
			visualKey: built.visualKey,
			slotId: "slot-1",
			kind: "timeline",
			requestKind: "timeline",
			slotHint: "phases",
			cacheKey: built.cacheKey,
		});
	});

	it("a best-fit slot keys as auto, as the build does, and asks for the kind it resolved to (R27)", async () => {
		const body = DOCUMENT.replace(
			'data-kind="timeline" data-hint="phases"',
			'data-hint="phases"',
		);
		expect(body).not.toBe(DOCUMENT);
		const options: GlossyBuildOptions = {
			mode: "roll_the_dice",
			lengthMode: "brief",
		};
		useSnapshot(body, options);

		const results = await runExtractions(options);
		const built = extracted(
			results,
			(result) => result.slotId === "slot-1",
		);
		expect(built.kind).toBe("timeline");
		const plan = regenerationPlan(
			body,
			built,
			{ source: "slot", kind: built.kind },
			options,
		);

		expect(plan).toMatchObject({
			visualKey: built.visualKey,
			kind: "auto",
			requestKind: "timeline",
			styleDirection: null,
			cacheKey: built.cacheKey,
		});
	});

	it("a rebuild of the unchanged section publishes the regenerated spec from that key, without a model call", async () => {
		const options: GlossyBuildOptions = {
			mode: "roll_the_dice",
			lengthMode: "brief",
		};
		useSnapshot(DOCUMENT, options);
		const first = extracted(
			await runExtractions(options),
			(result) => result.slotId === "slot-1",
		);
		const plan = regenerationPlan(
			DOCUMENT,
			first,
			{ source: "slot", kind: "timeline" },
			options,
		);
		if (!plan) {
			throw new Error("expected a plan");
		}

		// The regenerate's guarded write (`applyVisualRegeneration`).
		cache.EXTRACTION.set(plan.cacheKey, { spec: REGENERATED_TIMELINE });
		model.extractGlossyVisual.mockClear();

		// The rebuild: a new attempt over the same body.
		const rebuilt = extracted(
			await runExtractions(options),
			(result) => result.slotId === "slot-1",
		);
		expect(rebuilt).toMatchObject({
			fromCache: true,
			cacheKey: plan.cacheKey,
		});
		expect(model.extractGlossyVisual).not.toHaveBeenCalled();

		const sectionKeys = planGlossyKeys({
			content: DOCUMENT,
			projectId: REF.projectId,
			documentType: "PROPOSAL",
		}).sectionKeys;
		await finalizeGlossyBuildActivity({
			...REF,
			documentType: "PROPOSAL",
			options,
			rewrites: sectionKeys.map((sectionKey) => ({
				sectionKey,
				outcome: "keptOriginal" as const,
				reason: "fact_guard" as const,
			})),
			visuals: [rebuilt],
			detectionCacheKey: null,
		});
		const content: EditionContent =
			database.finalizeGlossyBuild.mock.calls[0][0].content;
		expect(content.visuals[plan.visualKey]).toMatchObject({
			spec: REGENERATED_TIMELINE,
			specHash: specHash(REGENERATED_TIMELINE),
		});
	});
});

describe("two slots of one kind and hint in a section", () => {
	const DELIVERY: TimelineVisualSpec = { ...TIMELINE, title: "Delivery" };
	const DESIGN: TimelineVisualSpec = { ...TIMELINE, title: "Design" };
	const options: GlossyBuildOptions = {
		mode: "roll_the_dice",
		lengthMode: "brief",
	};

	/** Team holding two hintless slots, of `kind` (`""` is best fit). */
	function twoSlots(kind: "" | "timeline") {
		return DOCUMENT.replace(
			"Alex leads delivery. Sam owns design.",
			[
				"Alex leads delivery. Sam owns design.",
				"",
				`<visual-slot data-slot-id="slot-a" data-kind="${kind}" data-hint=""></visual-slot>`,
				"",
				`<visual-slot data-slot-id="slot-b" data-kind="${kind}" data-hint=""></visual-slot>`,
			].join("\n"),
		);
	}

	/** Each Team extraction the model makes answers with the next of `specs`. */
	function teamAnswers(...specs: TimelineVisualSpec[]) {
		model.extractGlossyVisual.mockImplementation(
			async (input: { section: { heading: string | null } }) => ({
				status: "extracted",
				spec:
					input.section.heading === "Team"
						? (specs.shift() ?? TIMELINE)
						: TIMELINE,
			}),
		);
	}

	/** Finalize a build of `body` from `visuals`, and return what it published. */
	async function publish(
		body: string,
		visuals: ExtractGlossyVisualActivityResult[],
	): Promise<EditionContent> {
		const calls = database.finalizeGlossyBuild.mock.calls.length;
		await finalizeGlossyBuildActivity({
			...REF,
			documentType: "PROPOSAL",
			options,
			rewrites: planGlossyKeys({
				content: body,
				projectId: REF.projectId,
				documentType: "PROPOSAL",
			}).sectionKeys.map((sectionKey) => ({
				sectionKey,
				outcome: "keptOriginal" as const,
				reason: "fact_guard" as const,
			})),
			visuals,
			detectionCacheKey: null,
		});
		return database.finalizeGlossyBuild.mock.calls[calls][0].content;
	}

	it.each([
		["best-fit", ""],
		["same-kind", "timeline"],
	] as const)(
		"%s slots each get their own extraction and publish their own visual",
		async (_label, kind) => {
			const body = twoSlots(kind);
			useSnapshot(body, options);
			teamAnswers(DELIVERY, DESIGN);

			const results = await runExtractions(options);
			const a = extracted(
				results,
				(result) => result.slotId === "slot-a",
			);
			const b = extracted(
				results,
				(result) => result.slotId === "slot-b",
			);

			expect(a.cacheKey).not.toBe(b.cacheKey);
			expect(a.fromCache).toBe(false);
			expect(b.fromCache).toBe(false);
			const content = await publish(body, results);
			expect(content.visuals[a.visualKey]?.spec).toEqual(DELIVERY);
			expect(content.visuals[b.visualKey]?.spec).toEqual(DESIGN);
			expect(content.report.unfilledSlots).toEqual([]);
		},
	);

	it("regenerating one leaves the other's spec — and so its review — as it was", async () => {
		const body = twoSlots("");
		useSnapshot(body, options);
		teamAnswers(DELIVERY, DESIGN);
		const first = await runExtractions(options);
		const a = extracted(first, (result) => result.slotId === "slot-a");
		const b = extracted(first, (result) => result.slotId === "slot-b");
		const before = await publish(body, first);

		const plan = regenerationPlan(
			body,
			a,
			{ source: "slot", kind: a.kind },
			options,
		);
		expect(plan).toMatchObject({ slotId: "slot-a", cacheKey: a.cacheKey });
		expect(plan?.cacheKey).not.toBe(b.cacheKey);
		if (!plan) {
			throw new Error("expected a plan");
		}
		// The regenerate's guarded write (`applyVisualRegeneration`).
		cache.EXTRACTION.set(plan.cacheKey, { spec: REGENERATED_TIMELINE });
		model.extractGlossyVisual.mockClear();

		// A rebuild of the unchanged body.
		const after = await publish(body, await runExtractions(options));

		expect(model.extractGlossyVisual).not.toHaveBeenCalled();
		expect(after.visuals[a.visualKey]).toMatchObject({
			spec: REGENERATED_TIMELINE,
			specHash: specHash(REGENERATED_TIMELINE),
		});
		// An acceptance holds while the spec hash matches (U20).
		expect(after.visuals[b.visualKey]).toEqual(before.visuals[b.visualKey]);
		expect(after.visuals[b.visualKey]?.specHash).toBe(specHash(DESIGN));
	});
});

describe("planGlossyRegeneration — refusals", () => {
	const keyed = () =>
		planGlossyKeys({
			content: DOCUMENT,
			projectId: REF.projectId,
			documentType: "PROPOSAL",
		}).sections;

	it("a visual key its section does not produce, or a kind the key was not made with", () => {
		const [exec, , team] = keyed();
		const base = {
			sectionKey: team.key,
			section: team.section,
			buildOptions: { mode: "roll_the_dice", lengthMode: "brief" },
		};
		const orgChartKey = glossyExtractedVisualKey({
			sectionKey: team.key,
			slotId: null,
			kind: "org_chart",
		});

		expect(
			planGlossyRegeneration({
				...base,
				visualKey: orgChartKey,
				visual: { source: "detected", kind: "org_chart" },
			}),
		).toMatchObject({ visualKey: orgChartKey });
		expect(
			planGlossyRegeneration({
				...base,
				visualKey: "not-a-key",
				visual: { source: "detected", kind: "org_chart" },
			}),
		).toBeNull();
		expect(
			planGlossyRegeneration({
				...base,
				visualKey: orgChartKey,
				visual: { source: "detected", kind: "stat" },
			}),
		).toBeNull();
		// A slot's key in a section that holds no such slot.
		expect(
			planGlossyRegeneration({
				...base,
				visualKey: glossyExtractedVisualKey({
					sectionKey: team.key,
					slotId: "slot-1",
					kind: "timeline",
				}),
				visual: { source: "slot", kind: "timeline" },
			}),
		).toBeNull();
		expect(exec.section.anchors.some((a) => a.kind === "slot")).toBe(true);
	});

	it("a slot that asks for one kind never regenerates as another", async () => {
		const [exec, , team] = keyed();
		const options = alignFirst(team.key);
		useSnapshot(DOCUMENT, options);
		const built = extracted(
			await runExtractions(options),
			(result) => result.slotId === "slot-1",
		);

		expect(
			planGlossyRegeneration({
				sectionKey: exec.key,
				section: exec.section,
				visualKey: built.visualKey,
				visual: { source: "slot", kind: "stat" },
				buildOptions: options,
			}),
		).toBeNull();
	});

	it("an existing diagram is restyled, not extracted", () => {
		const [, approach] = keyed();
		expect(
			planGlossyRegeneration({
				sectionKey: approach.key,
				section: approach.section,
				visualKey: "any",
				visual: {
					source: "existing_mermaid",
					kind: "existing_mermaid",
				},
				buildOptions: null,
			}),
		).toBeNull();
	});
});
