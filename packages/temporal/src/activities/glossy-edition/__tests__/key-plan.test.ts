/**
 * `planGlossyKeys` parity (Fizzy #2589, KTD7, KTD8, KTD10).
 *
 * Align first runs detection in the request, on the live document, and hands
 * the build `{ sectionKey, kind }` pairs; the build then works from its own
 * snapshot. The two sides only agree when they key the same body the same
 * way. When they do not, nothing fails loudly: `planGlossyVisuals` drops every
 * confirmed opportunity whose section key it does not know, and finalize
 * finds no reasons under a detection key nobody wrote.
 *
 * The detect and build procedures call `planGlossyKeys` (through the package
 * root). These tests run the build's real activities over a snapshot of the
 * same body and prove each key the procedures computed is the one the build
 * uses. The database and the model are mocked; cleanup and keys are real.
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
	detectGlossyOpportunities: vi.fn(),
}));

vi.mock("@repo/database", () => ({ db, ...database }));
vi.mock("../../../lib/glossy/model", () => ({
	resolveGlossyModel: model.resolveGlossyModel,
	GLOSSY_AI_PROVIDER_NOT_CONFIGURED_MESSAGE: "Configure an AI provider.",
}));
vi.mock("../../../lib/glossy/detect-opportunities", () => ({
	detectGlossyOpportunities: model.detectGlossyOpportunities,
}));

import { GLOSSY_PIPELINE_VERSION } from "@repo/agent-prompts/glossy";
import type { EditionContent } from "@repo/utils/glossy/edition-content";
import { computeDetectedVisualKey } from "@repo/utils/glossy/keys";
import { detectGlossyOpportunitiesActivity } from "../detect";
import { finalizeGlossyBuildActivity } from "../finalize-build";
import { prepareGlossyBuildActivity } from "../prepare-build";
import { GLOSSY_BUILD_FAILURE_MESSAGES, planGlossyKeys } from "../shared";
import type { GlossyOpportunityRef } from "../types";
import { DOCUMENT, REF, snapshotOf } from "./glossy-fixtures";

type CacheKind = "REWRITE" | "EXTRACTION" | "DETECTION";
let cache: Record<CacheKind, Map<string, unknown>>;

/** What the detect and build procedures compute from the live document. */
function requestPlan(content: string = DOCUMENT) {
	return planGlossyKeys({
		content,
		projectId: REF.projectId,
		documentType: "PROPOSAL",
	});
}

function useSnapshotOf(content: string) {
	database.getGlossyBuildSnapshot.mockResolvedValue(snapshotOf(content));
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
	useSnapshotOf(DOCUMENT);
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
	database.finalizeGlossyBuild.mockResolvedValue({
		outcome: "applied",
		editionId: "edition-1",
		contentRevision: 1,
	});
	model.resolveGlossyModel.mockResolvedValue({ status: "resolved" });
});

describe("planGlossyKeys — parity with the build", () => {
	it("names the same sections, in the same order, that prepare hands the workflow", async () => {
		const plan = requestPlan();
		const prepared = await prepareGlossyBuildActivity({
			...REF,
			options: { mode: "roll_the_dice", lengthMode: "brief" },
		});

		expect(plan.sectionKeys).toHaveLength(3);
		expect(prepared.sectionKeys).toEqual(plan.sectionKeys);
	});

	it("an Align-first build keeps every opportunity confirmed against the plan and runs no detection", async () => {
		const plan = requestPlan();
		const [exec, approach, team] = plan.detectable;
		// One unreserved kind per section: the slot reserves `timeline` in the
		// first, the existing diagram reserves the diagram kinds in the second.
		expect(exec.reservedKinds).toEqual(["timeline"]);
		expect(approach.reservedKinds).toEqual(
			expect.arrayContaining(["timeline", "flow", "org_chart"]),
		);
		const confirmed: GlossyOpportunityRef[] = [
			{ sectionKey: exec.sectionKey, kind: "stat" },
			{ sectionKey: approach.sectionKey, kind: "comparison" },
			{ sectionKey: team.sectionKey, kind: "org_chart" },
		];

		const prepared = await prepareGlossyBuildActivity({
			...REF,
			options: {
				mode: "align_first",
				lengthMode: "brief",
				confirmedOpportunities: confirmed,
			},
		});

		expect(prepared.opportunities).toEqual(confirmed);
		expect(prepared.detection).toBeNull();
	});

	it("finalize reads Align first's reasons from the row written under the plan's detection key", async () => {
		const plan = requestPlan();
		const team = plan.detectable[2];
		cache.DETECTION.set(plan.detectionKey, {
			opportunities: [
				{
					sectionKey: team.sectionKey,
					kind: "org_chart",
					reason: "Roles and ownership",
				},
			],
		});
		cache.EXTRACTION.set("ex-team", {
			spec: {
				kind: "org_chart",
				nodes: [
					{ id: "a", label: "Alex", parentId: null },
					{ id: "s", label: "Sam", parentId: "a" },
				],
			},
		});
		const visualKey = computeDetectedVisualKey({
			sectionKey: team.sectionKey,
			kind: "org_chart",
			pipelineVersion: GLOSSY_PIPELINE_VERSION,
		});

		await finalizeGlossyBuildActivity({
			...REF,
			documentType: "PROPOSAL",
			options: {
				mode: "align_first",
				lengthMode: "brief",
				confirmedOpportunities: [
					{ sectionKey: team.sectionKey, kind: "org_chart" },
				],
			},
			rewrites: plan.sectionKeys.map((sectionKey) => ({
				sectionKey,
				outcome: "keptOriginal" as const,
				reason: "fact_guard" as const,
			})),
			visuals: [
				{
					sectionKey: team.sectionKey,
					slotId: null,
					visualKey,
					outcome: "extracted",
					kind: "org_chart",
					cacheKey: "ex-team",
					fromCache: false,
				},
			],
			detectionCacheKey: null,
		});

		const detectionQuery = database.getCacheEntries.mock.calls.find(
			([query]) => query.kind === "DETECTION",
		)?.[0];
		expect(detectionQuery.cacheKeys).toEqual([plan.detectionKey]);
		const content: EditionContent =
			database.finalizeGlossyBuild.mock.calls[0][0].content;
		expect(content.visuals[visualKey]?.reason).toBe("Roles and ownership");
	});

	it("a first Roll-the-dice detection over the same sections reuses the row Align first wrote", async () => {
		const plan = requestPlan();
		cache.DETECTION.set(plan.detectionKey, {
			opportunities: [
				{
					sectionKey: plan.detectable[2].sectionKey,
					kind: "org_chart",
					reason: "Roles and ownership",
				},
			],
		});

		const result = await detectGlossyOpportunitiesActivity({
			...REF,
			documentType: "PROPOSAL",
			sectionKeys: plan.sectionKeys,
			limit: 8,
			progress: { sectionsDone: 0, sectionsTotal: 3 },
		});

		expect(result).toEqual({
			opportunities: [
				{
					sectionKey: plan.detectable[2].sectionKey,
					kind: "org_chart",
				},
			],
			cacheKey: plan.detectionKey,
			fromCache: true,
		});
		expect(model.detectGlossyOpportunities).not.toHaveBeenCalled();
	});

	it("keeps a best-fit slot's section in the keys and out of what detection proposes for", async () => {
		const body = DOCUMENT.replace(
			'<visual-slot data-slot-id="slot-1" data-kind="timeline" data-hint="phases"></visual-slot>',
			'<visual-slot data-slot-id="slot-1" data-hint="phases"></visual-slot>',
		);
		expect(body).not.toBe(DOCUMENT);
		const plan = requestPlan(body);
		useSnapshotOf(body);

		const prepared = await prepareGlossyBuildActivity({
			...REF,
			options: { mode: "roll_the_dice", lengthMode: "brief" },
		});

		expect(prepared.sectionKeys).toEqual(plan.sectionKeys);
		// The build's own detection leaves the best-fit section out too.
		expect(prepared.detection?.sectionKeys).toEqual(
			plan.detectable.map((entry) => entry.sectionKey),
		);
		expect(plan.detectable.map((entry) => entry.sectionKey)).toEqual(
			plan.sectionKeys.slice(1),
		);
		// The slot is still part of the key, so the edited body keys apart.
		expect(plan.detectionKey).not.toBe(requestPlan().detectionKey);
	});

	it("an Align-first build drops a confirmed opportunity in a best-fit slot's section", async () => {
		const body = DOCUMENT.replace(
			'<visual-slot data-slot-id="slot-1" data-kind="timeline" data-hint="phases"></visual-slot>',
			'<visual-slot data-slot-id="slot-1" data-hint="phases"></visual-slot>',
		);
		const plan = requestPlan(body);
		useSnapshotOf(body);
		const [bestFit, detectable] = [plan.sectionKeys[0], plan.detectable[0]];
		expect(detectable.sectionKey).not.toBe(bestFit);

		const prepared = await prepareGlossyBuildActivity({
			...REF,
			options: {
				mode: "align_first",
				lengthMode: "brief",
				// The first is not one detection could have proposed: the slot
				// in that section may resolve to any kind.
				confirmedOpportunities: [
					{ sectionKey: bestFit, kind: "stat" },
					{ sectionKey: detectable.sectionKey, kind: "comparison" },
				],
			},
		});

		expect(prepared.opportunities).toEqual([
			{ sectionKey: detectable.sectionKey, kind: "comparison" },
		]);
	});

	it("a body edited after detection keys differently", () => {
		const edited = requestPlan(
			DOCUMENT.replace("Sam owns design.", "Sam owns design and QA."),
		);
		const original = requestPlan();

		expect(edited.detectionKey).not.toBe(original.detectionKey);
		expect(edited.sectionKeys[2]).not.toBe(original.sectionKeys[2]);
		expect(edited.sectionKeys.slice(0, 2)).toEqual(
			original.sectionKeys.slice(0, 2),
		);
	});
});

describe("GLOSSY_BUILD_FAILURE_MESSAGES", () => {
	it("has a fixed message for the start failure the build procedure records", () => {
		expect(GLOSSY_BUILD_FAILURE_MESSAGES.WORKFLOW_START_FAILED).toBe(
			"The build could not be started.",
		);
	});
});
