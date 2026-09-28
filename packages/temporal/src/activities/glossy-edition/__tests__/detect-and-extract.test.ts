/**
 * `detectGlossyOpportunitiesActivity` and `extractGlossyVisualActivity`
 * (Fizzy #2589, R17, R18, R22, KTD8, KTD9, AE3): the guard before any model
 * call, the cache before the model, guarded successes written back, and
 * results that carry keys and kinds only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
	getGlossyBuildSnapshot: vi.fn(),
	heartbeatGlossyBuild: vi.fn(),
	markGlossyBuildSuperseded: vi.fn(),
	getCacheEntries: vi.fn(),
	putCacheEntry: vi.fn(),
}));
const detect = vi.hoisted(() => ({ detectGlossyOpportunities: vi.fn() }));
const extract = vi.hoisted(() => ({ extractGlossyVisual: vi.fn() }));

vi.mock("@repo/database", () => ({ db: {}, ...database }));
vi.mock("../../../lib/glossy/model", () => ({
	GLOSSY_AI_PROVIDER_NOT_CONFIGURED_MESSAGE: "Configure an AI provider.",
}));
vi.mock("../../../lib/glossy/detect-opportunities", () => detect);
vi.mock("../../../lib/glossy/extract-visual", () => extract);

import { GLOSSY_PIPELINE_VERSION } from "@repo/agent-prompts/glossy";
import {
	computeExtractionKey,
	computeSlotVisualKey,
} from "@repo/utils/glossy/keys";
import { detectGlossyOpportunitiesActivity } from "../detect";
import { extractGlossyVisualActivity } from "../extract-visual";
import { glossyDetectionKey } from "../shared";
import type {
	DetectGlossyOpportunitiesActivityInput,
	ExtractGlossyVisualActivityInput,
} from "../types";
import { REF, sectionsOf, snapshotOf, verdict } from "./glossy-fixtures";

const SECTIONS = sectionsOf();
const [EXEC, APPROACH, TEAM] = SECTIONS;
const PROGRESS = { sectionsDone: 1, sectionsTotal: 3 };

beforeEach(() => {
	vi.clearAllMocks();
	database.getGlossyBuildSnapshot.mockResolvedValue(snapshotOf());
	database.heartbeatGlossyBuild.mockResolvedValue("applied");
	database.markGlossyBuildSuperseded.mockResolvedValue("marked");
	database.getCacheEntries.mockResolvedValue(new Map());
	database.putCacheEntry.mockResolvedValue("applied");
});

describe("detectGlossyOpportunitiesActivity", () => {
	const input: DetectGlossyOpportunitiesActivityInput = {
		...REF,
		documentType: "PROPOSAL",
		sectionKeys: [APPROACH.key, TEAM.key],
		limit: 7,
		progress: PROGRESS,
	};
	const cacheKey = glossyDetectionKey([APPROACH, TEAM], "PROPOSAL");

	it("detects over the named sections only, with the kinds each already shows reserved", async () => {
		detect.detectGlossyOpportunities.mockResolvedValue({
			status: "detected",
			opportunities: [
				{ sectionKey: TEAM.key, kind: "org_chart", reason: "Roles" },
			],
			discarded: 0,
		});

		const result = await detectGlossyOpportunitiesActivity(input);

		const call = detect.detectGlossyOpportunities.mock.calls[0][0];
		expect(call.limit).toBe(7);
		expect(call.userId).toBe("user-1");
		expect(
			call.sections.map(
				(section: { sectionKey: string }) => section.sectionKey,
			),
		).toEqual([APPROACH.key, TEAM.key]);
		// The existing Mermaid diagram reserves the diagram kinds.
		expect(call.sections[0].reservedKinds).toEqual([
			"timeline",
			"flow",
			"org_chart",
		]);
		expect(database.putCacheEntry).toHaveBeenCalledWith({
			documentId: "doc-1",
			projectId: "proj-1",
			kind: "DETECTION",
			cacheKey,
			sectionKey: null,
			output: {
				opportunities: [
					{
						sectionKey: TEAM.key,
						kind: "org_chart",
						reason: "Roles",
					},
				],
			},
			buildId: "build-1",
		});
		expect(result).toEqual({
			opportunities: [{ sectionKey: TEAM.key, kind: "org_chart" }],
			cacheKey,
			fromCache: false,
		});
	});

	it("reuses a cached detection without a model call, within the current budget", async () => {
		database.getCacheEntries.mockResolvedValue(
			new Map([
				[
					cacheKey,
					{
						opportunities: [
							{
								sectionKey: APPROACH.key,
								kind: "comparison",
								reason: "a",
							},
							{
								sectionKey: TEAM.key,
								kind: "org_chart",
								reason: "b",
							},
							// Not a section this detection considered.
							{ sectionKey: EXEC.key, kind: "stat", reason: "c" },
						],
					},
				],
			]),
		);

		const result = await detectGlossyOpportunitiesActivity({
			...input,
			limit: 1,
		});

		expect(detect.detectGlossyOpportunities).not.toHaveBeenCalled();
		expect(result).toEqual({
			opportunities: [{ sectionKey: APPROACH.key, kind: "comparison" }],
			cacheKey,
			fromCache: true,
		});
	});

	it("caches nothing when detection degrades", async () => {
		detect.detectGlossyOpportunities.mockResolvedValue({
			status: "degraded",
			reason: "truncated",
			opportunities: [],
		});

		await expect(detectGlossyOpportunitiesActivity(input)).resolves.toEqual(
			{
				opportunities: [],
				cacheKey: null,
				fromCache: false,
			},
		);
		expect(database.putCacheEntry).not.toHaveBeenCalled();
	});

	it("makes no model call once the guard fails", async () => {
		database.heartbeatGlossyBuild.mockResolvedValue("superseded");

		await expect(detectGlossyOpportunitiesActivity(input)).rejects.toEqual(
			verdict("SUPERSEDED"),
		);
		expect(detect.detectGlossyOpportunities).not.toHaveBeenCalled();
		expect(database.heartbeatGlossyBuild).toHaveBeenCalledWith("build-1", {
			step: "detecting",
			...PROGRESS,
		});
	});
});

describe("extractGlossyVisualActivity", () => {
	const slotInput: ExtractGlossyVisualActivityInput = {
		...REF,
		documentType: "PROPOSAL",
		sectionKey: EXEC.key,
		kind: "timeline",
		slotId: "slot-1",
		styleDirection: "Calm",
		progress: PROGRESS,
	};
	const slotCacheKey = computeExtractionKey({
		sectionKey: EXEC.key,
		kind: "timeline",
		slotHint: "phases",
		styleDirection: "Calm",
		slotId: "slot-1",
		pipelineVersion: GLOSSY_PIPELINE_VERSION,
	});
	const slotVisualKey = computeSlotVisualKey({
		slotId: "slot-1",
		sectionKey: EXEC.key,
		pipelineVersion: GLOSSY_PIPELINE_VERSION,
	});
	const TIMELINE = {
		kind: "timeline",
		items: [
			{ date: "Q3 2026", label: "Pilot" },
			{ date: "Q4 2026", label: "Rollout" },
		],
	};

	it("fills a slot with its hint from the snapshot and caches the spec under this attempt", async () => {
		extract.extractGlossyVisual.mockResolvedValue({
			status: "extracted",
			spec: TIMELINE,
		});

		const result = await extractGlossyVisualActivity(slotInput);

		expect(extract.extractGlossyVisual).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "timeline",
				slotHint: "phases",
				styleDirection: "Calm",
				section: EXEC.section,
				organizationId: "org-1",
			}),
		);
		expect(database.putCacheEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "EXTRACTION",
				cacheKey: slotCacheKey,
				sectionKey: EXEC.key,
				output: { spec: TIMELINE },
				buildId: "build-1",
			}),
		);
		expect(result).toEqual({
			sectionKey: EXEC.key,
			slotId: "slot-1",
			visualKey: slotVisualKey,
			outcome: "extracted",
			kind: "timeline",
			cacheKey: slotCacheKey,
			fromCache: false,
		});
	});

	it("keys an opportunity's extraction without a slot id, as before slots were keyed apart", async () => {
		extract.extractGlossyVisual.mockResolvedValue({
			status: "extracted",
			spec: {
				kind: "org_chart",
				nodes: [
					{ id: "a", label: "Alex", parentId: null },
					{ id: "s", label: "Sam", parentId: "a" },
				],
			},
		});

		const result = await extractGlossyVisualActivity({
			...slotInput,
			sectionKey: TEAM.key,
			kind: "org_chart",
			slotId: null,
		});

		expect(result).toMatchObject({
			outcome: "extracted",
			cacheKey: computeExtractionKey({
				sectionKey: TEAM.key,
				kind: "org_chart",
				slotHint: null,
				styleDirection: "Calm",
				pipelineVersion: GLOSSY_PIPELINE_VERSION,
			}),
		});
	});

	it("reuses a cached visual of an unchanged section without a model call (AE3)", async () => {
		database.getCacheEntries.mockResolvedValue(
			new Map([[slotCacheKey, { spec: TIMELINE }]]),
		);

		await expect(
			extractGlossyVisualActivity(slotInput),
		).resolves.toMatchObject({
			outcome: "extracted",
			fromCache: true,
			cacheKey: slotCacheKey,
		});
		expect(extract.extractGlossyVisual).not.toHaveBeenCalled();
		expect(database.putCacheEntry).not.toHaveBeenCalled();
	});

	it("reports a dropped visual by reason code, uncached and without the guard's findings (R18)", async () => {
		extract.extractGlossyVisual.mockResolvedValue({
			status: "dropped",
			reason: "factCheck",
			message: "fixed",
			violations: [{ kind: "presence", text: "Q1 2027", message: "m" }],
		});

		const result = await extractGlossyVisualActivity(slotInput);

		expect(result).toMatchObject({
			outcome: "dropped",
			reason: "fact_check",
		});
		expect(JSON.stringify(result)).not.toContain("Q1 2027");
		expect(database.putCacheEntry).not.toHaveBeenCalled();
	});

	it("reports a slot the snapshot no longer holds without a model call", async () => {
		await expect(
			extractGlossyVisualActivity({ ...slotInput, slotId: "slot-gone" }),
		).resolves.toMatchObject({
			outcome: "dropped",
			reason: "slot_unavailable",
		});
		expect(extract.extractGlossyVisual).not.toHaveBeenCalled();
	});

	it("makes no model call once the guard fails", async () => {
		database.heartbeatGlossyBuild.mockResolvedValue("superseded");

		await expect(extractGlossyVisualActivity(slotInput)).rejects.toEqual(
			verdict("SUPERSEDED"),
		);
		expect(extract.extractGlossyVisual).not.toHaveBeenCalled();
		expect(database.markGlossyBuildSuperseded).toHaveBeenCalledWith(
			"build-1",
		);
	});

	it("fails without retrying when no AI provider is configured", async () => {
		extract.extractGlossyVisual.mockResolvedValue({
			status: "aiProviderNotConfigured",
			message: "Configure an AI provider.",
		});
		await expect(extractGlossyVisualActivity(slotInput)).rejects.toEqual(
			verdict("AI_PROVIDER_NOT_CONFIGURED"),
		);
	});
});
