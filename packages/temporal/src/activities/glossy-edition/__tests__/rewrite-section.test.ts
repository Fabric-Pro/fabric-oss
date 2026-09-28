/**
 * `rewriteGlossySectionActivity` (Fizzy #2589, R8, R16, KTD4, KTD8, KTD24,
 * AE3): the attempt guard before any model call, the cache before the model,
 * guarded successes written back, and results that carry no text.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
	getGlossyBuildSnapshot: vi.fn(),
	heartbeatGlossyBuild: vi.fn(),
	markGlossyBuildSuperseded: vi.fn(),
	getCacheEntries: vi.fn(),
	putCacheEntry: vi.fn(),
}));
const rewrite = vi.hoisted(() => ({ rewriteGlossySection: vi.fn() }));

vi.mock("@repo/database", () => ({ db: {}, ...database }));
vi.mock("../../../lib/glossy/model", () => ({
	GLOSSY_AI_PROVIDER_NOT_CONFIGURED_MESSAGE: "Configure an AI provider.",
}));
vi.mock("../../../lib/glossy/rewrite-section", () => rewrite);

import { GLOSSY_PIPELINE_VERSION } from "@repo/agent-prompts/glossy";
import { computeRewriteKey } from "@repo/utils/glossy/keys";
import { rewriteGlossySectionActivity } from "../rewrite-section";
import type { RewriteGlossySectionActivityInput } from "../types";
import { REF, sectionsOf, snapshotOf, verdict } from "./glossy-fixtures";

const [EXEC, APPROACH] = sectionsOf();

const INPUT: RewriteGlossySectionActivityInput = {
	...REF,
	documentType: "PROPOSAL",
	lengthMode: "brief",
	sectionKey: APPROACH.key,
	progress: { sectionsDone: 2, sectionsTotal: 3 },
};

const APPROACH_KEY = computeRewriteKey({
	sectionKey: APPROACH.key,
	lengthMode: "brief",
	keySectionClass: "standard",
	documentType: "PROPOSAL",
	pipelineVersion: GLOSSY_PIPELINE_VERSION,
});

beforeEach(() => {
	vi.clearAllMocks();
	database.getGlossyBuildSnapshot.mockResolvedValue(snapshotOf());
	database.heartbeatGlossyBuild.mockResolvedValue("applied");
	database.markGlossyBuildSuperseded.mockResolvedValue("marked");
	database.getCacheEntries.mockResolvedValue(new Map());
	database.putCacheEntry.mockResolvedValue("applied");
	rewrite.rewriteGlossySection.mockResolvedValue({
		status: "rewritten",
		markdown: "We discover first, then build.",
		attempts: 1,
	});
});

describe("rewriteGlossySectionActivity", () => {
	it("reuses a cached rewrite of an unchanged section without a model call (AE3)", async () => {
		database.getCacheEntries.mockResolvedValue(
			new Map([[APPROACH_KEY, { markdown: "Cached rewrite." }]]),
		);

		const result = await rewriteGlossySectionActivity(INPUT);

		expect(result).toEqual({
			sectionKey: APPROACH.key,
			outcome: "rewritten",
			cacheKey: APPROACH_KEY,
			fromCache: true,
		});
		expect(database.getCacheEntries).toHaveBeenCalledWith({
			documentId: "doc-1",
			kind: "REWRITE",
			cacheKeys: [APPROACH_KEY],
		});
		expect(rewrite.rewriteGlossySection).not.toHaveBeenCalled();
		expect(database.putCacheEntry).not.toHaveBeenCalled();
	});

	it("rewrites as the editor and caches the guarded success under this attempt", async () => {
		const result = await rewriteGlossySectionActivity(INPUT);

		expect(rewrite.rewriteGlossySection).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				projectId: "proj-1",
				documentType: "PROPOSAL",
				lengthMode: "brief",
				section: APPROACH.section,
			}),
		);
		expect(database.putCacheEntry).toHaveBeenCalledWith({
			documentId: "doc-1",
			projectId: "proj-1",
			kind: "REWRITE",
			cacheKey: APPROACH_KEY,
			sectionKey: APPROACH.key,
			output: { markdown: "We discover first, then build." },
			buildId: "build-1",
		});
		// The text went to the cache row; the result carries its key only.
		expect(result).toEqual({
			sectionKey: APPROACH.key,
			outcome: "rewritten",
			cacheKey: APPROACH_KEY,
			fromCache: false,
		});
	});

	it("records progress through the attempt guard before the model call", async () => {
		await rewriteGlossySectionActivity(INPUT);

		expect(database.heartbeatGlossyBuild).toHaveBeenCalledWith("build-1", {
			step: "rewriting",
			sectionsDone: 2,
			sectionsTotal: 3,
		});
		expect(
			database.heartbeatGlossyBuild.mock.invocationCallOrder[0],
		).toBeLessThan(
			rewrite.rewriteGlossySection.mock.invocationCallOrder[0],
		);
	});

	it("keys a key section apart from the same text in an ordinary one (R42)", async () => {
		await rewriteGlossySectionActivity({ ...INPUT, sectionKey: EXEC.key });

		expect(database.getCacheEntries).toHaveBeenCalledWith(
			expect.objectContaining({
				cacheKeys: [
					computeRewriteKey({
						sectionKey: EXEC.key,
						lengthMode: "brief",
						keySectionClass: "key",
						documentType: "PROPOSAL",
						pipelineVersion: GLOSSY_PIPELINE_VERSION,
					}),
				],
			}),
		);
	});

	it("keeps the original wording uncached and drops the guard's findings", async () => {
		rewrite.rewriteGlossySection.mockResolvedValue({
			status: "keptOriginal",
			markdown: APPROACH.section.markdown,
			reason: "guardFailed",
			violations: [
				{
					kind: "presence",
					text: "$250k",
					message: '"$250k" does not appear in the source section.',
				},
			],
			attempts: 2,
		});

		const result = await rewriteGlossySectionActivity(INPUT);

		expect(result).toEqual({
			sectionKey: APPROACH.key,
			outcome: "keptOriginal",
			reason: "fact_guard",
		});
		expect(JSON.stringify(result)).not.toContain("250k");
		expect(database.putCacheEntry).not.toHaveBeenCalled();
	});

	it("reports a truncated rewrite as kept original", async () => {
		rewrite.rewriteGlossySection.mockResolvedValue({
			status: "keptOriginal",
			markdown: APPROACH.section.markdown,
			reason: "truncated",
			violations: [],
			attempts: 1,
		});
		await expect(
			rewriteGlossySectionActivity(INPUT),
		).resolves.toMatchObject({
			outcome: "keptOriginal",
			reason: "truncated",
		});
	});

	it("makes no model call once the guard fails, and changes only its own attempt", async () => {
		database.heartbeatGlossyBuild.mockResolvedValue("superseded");

		await expect(rewriteGlossySectionActivity(INPUT)).rejects.toEqual(
			verdict("SUPERSEDED"),
		);
		expect(rewrite.rewriteGlossySection).not.toHaveBeenCalled();
		expect(database.putCacheEntry).not.toHaveBeenCalled();
		expect(database.markGlossyBuildSuperseded).toHaveBeenCalledTimes(1);
		expect(database.markGlossyBuildSuperseded).toHaveBeenCalledWith(
			"build-1",
		);
	});

	it("stops before the guard when its attempt is no longer building", async () => {
		database.getGlossyBuildSnapshot.mockResolvedValue(
			snapshotOf(undefined, { status: "FAILED" }),
		);
		await expect(rewriteGlossySectionActivity(INPUT)).rejects.toEqual(
			verdict("SUPERSEDED"),
		);
		expect(database.heartbeatGlossyBuild).not.toHaveBeenCalled();
		expect(rewrite.rewriteGlossySection).not.toHaveBeenCalled();
	});

	it("stops when the cache write finds the claim gone", async () => {
		database.putCacheEntry.mockResolvedValue("superseded");
		await expect(rewriteGlossySectionActivity(INPUT)).rejects.toEqual(
			verdict("SUPERSEDED"),
		);
		expect(database.markGlossyBuildSuperseded).toHaveBeenCalledWith(
			"build-1",
		);
	});

	it("fails without retrying when no AI provider is configured (AE6)", async () => {
		rewrite.rewriteGlossySection.mockResolvedValue({
			status: "aiProviderNotConfigured",
			message: "Configure an AI provider.",
		});
		await expect(rewriteGlossySectionActivity(INPUT)).rejects.toEqual(
			verdict("AI_PROVIDER_NOT_CONFIGURED"),
		);
	});

	it("maps a foreign-key violation from a deleted document to SOURCE_DOCUMENT_DELETED", async () => {
		database.putCacheEntry.mockRejectedValue(
			Object.assign(new Error("Foreign key constraint violated"), {
				code: "P2003",
			}),
		);
		await expect(rewriteGlossySectionActivity(INPUT)).rejects.toEqual(
			verdict("SOURCE_DOCUMENT_DELETED"),
		);
	});

	it("lets a transient model error propagate for Temporal to retry", async () => {
		rewrite.rewriteGlossySection.mockRejectedValue(
			new Error("provider timeout"),
		);
		const failure = await rewriteGlossySectionActivity(INPUT).catch(
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as { nonRetryable?: boolean }).nonRetryable).not.toBe(
			true,
		);
	});

	it("refuses a section key its snapshot does not have", async () => {
		await expect(
			rewriteGlossySectionActivity({ ...INPUT, sectionKey: "unknown" }),
		).rejects.toEqual(verdict("GLOSSY_BUILD_INCONSISTENT"));
		expect(rewrite.rewriteGlossySection).not.toHaveBeenCalled();
	});
});
