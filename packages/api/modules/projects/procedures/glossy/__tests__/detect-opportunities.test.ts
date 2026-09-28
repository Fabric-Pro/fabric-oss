/**
 * `projects.glossy.detect` (Fizzy #2589, R24, R33, KTD8, KTD10, KTD21, F2,
 * AE10).
 *
 * The permission decision, the Glossy gate, and `planGlossyKeys` are real;
 * the model call, the cache, and the audit writer are mocks over the world in
 * `glossy-harness.ts`. Key parity with the build itself — that the keys
 * `planGlossyKeys` gives here are the ones the build's activities use — is
 * proven against the real activities in
 * `packages/temporal/src/activities/glossy-edition/__tests__/key-plan.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () =>
	(await import("./glossy-harness")).databaseModule(),
);
vi.mock("@repo/temporal", async () =>
	(await import("./glossy-harness")).temporalModule(),
);
vi.mock("@repo/ai", async () => (await import("./glossy-harness")).aiModule());
vi.mock("@repo/storage", async () =>
	(await import("./glossy-harness")).storageModule(),
);
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./glossy-harness")).proceduresModule(),
);
vi.mock("../../../../../lib/audit", async () => ({
	recordAuditFromRequest: (await import("./glossy-harness")).mocks
		.recordAudit,
}));

import { computeDocumentContentHash } from "@repo/database";
import { planGlossyKeys } from "@repo/temporal";
import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import { detectGlossyOpportunitiesProcedure } from "../detect-opportunities";
import {
	call,
	DOC_A,
	DOC_PRD,
	errorCode,
	mocks,
	ORG_A,
	PROJECT_A,
	PROJECT_B,
	PROPOSAL_BODY,
	resetMocks,
	resetWorld,
	USERS,
	usePermissionCheck,
	world,
} from "./glossy-harness";

usePermissionCheck(assertProjectPermission);

const detect = (userId: string = USERS.editor, documentId: string = DOC_A) =>
	call(
		detectGlossyOpportunitiesProcedure,
		{ projectId: PROJECT_A, documentId },
		userId,
	);

const plan = () =>
	planGlossyKeys({
		content: PROPOSAL_BODY,
		projectId: PROJECT_A,
		documentType: "PROPOSAL",
	});

beforeEach(() => {
	resetWorld();
	resetMocks();
	const [exec, , team] = plan().sectionKeys;
	mocks.detect.mockResolvedValue({
		status: "detected",
		// The model's order; the form gets document order.
		opportunities: [
			{
				sectionKey: team,
				kind: "org_chart",
				reason: "Roles and ownership",
			},
			{
				sectionKey: exec,
				kind: "stat",
				reason: "A headline budget figure",
			},
		],
		discarded: 0,
	});
});

describe("projects.glossy.detect — detection in the request (KTD10)", () => {
	it("detects over the planned sections as the editor and caches under the build's detection key", async () => {
		const expected = plan();
		const [exec, , team] = expected.sectionKeys;

		const result = await detect();

		expect(mocks.detect).toHaveBeenCalledTimes(1);
		expect(mocks.detect.mock.calls[0][0]).toMatchObject({
			userId: USERS.editor,
			organizationId: ORG_A,
			projectId: PROJECT_A,
			documentType: "PROPOSAL",
			sections: expected.detectable,
			limit: 8,
		});
		expect(mocks.enforceAiRateLimit).toHaveBeenCalledWith(
			USERS.editor,
			expect.anything(),
		);
		// No attempt guard: this row is written outside any build.
		expect(mocks.putCacheEntry).toHaveBeenCalledWith({
			documentId: DOC_A,
			projectId: PROJECT_A,
			kind: "DETECTION",
			cacheKey: expected.detectionKey,
			sectionKey: null,
			output: {
				opportunities: [
					{
						sectionKey: team,
						kind: "org_chart",
						reason: "Roles and ownership",
					},
					{
						sectionKey: exec,
						kind: "stat",
						reason: "A headline budget figure",
					},
				],
			},
		});

		expect(result).toEqual({
			outcome: "detected",
			contentHash: computeDocumentContentHash(PROPOSAL_BODY),
			opportunities: [
				{
					sectionKey: exec,
					heading: "Executive Summary",
					kind: "stat",
					reason: "A headline budget figure",
				},
				{
					sectionKey: team,
					heading: "Team",
					kind: "org_chart",
					reason: "Roles and ownership",
				},
			],
			fromCache: false,
			degraded: false,
			recipientWebsiteSuggestions: [],
		});
		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		expect(mocks.recordAudit.mock.calls[0][1]).toMatchObject({
			action: "project.glossy_edition.opportunities_detected",
			organizationId: ORG_A,
			projectId: PROJECT_A,
			resource: { type: "project_document", id: DOC_A },
			metadata: { count: 2, fromCache: false, degraded: false },
		});
	});

	it("answers a second detection of the same body from the cache, filtered again", async () => {
		const expected = plan();
		const [exec, approach, team] = expected.sectionKeys;
		mocks.getCacheEntries.mockResolvedValue(
			new Map([
				[
					expected.detectionKey,
					{
						opportunities: [
							{
								sectionKey: team,
								kind: "org_chart",
								reason: "Roles",
							},
							{
								sectionKey: "unknown-section",
								kind: "stat",
								reason: "x",
							},
							{
								sectionKey: approach,
								kind: "pie",
								reason: "not a kind",
							},
							{
								sectionKey: team,
								kind: "timeline",
								reason: "second in a section",
							},
							{ sectionKey: exec, kind: "stat" },
						],
					},
				],
			]),
		);

		const result = await detect();

		expect(mocks.getCacheEntries).toHaveBeenCalledWith({
			documentId: DOC_A,
			kind: "DETECTION",
			cacheKeys: [expected.detectionKey],
		});
		expect(mocks.detect).not.toHaveBeenCalled();
		expect(mocks.enforceAiRateLimit).not.toHaveBeenCalled();
		// The hit re-stores the row under the same key, so its lastUsedAt
		// moves and a concurrent build's finalize does not prune it.
		expect(mocks.putCacheEntry).toHaveBeenCalledTimes(1);
		expect(mocks.putCacheEntry.mock.calls[0][0]).toMatchObject({
			documentId: DOC_A,
			kind: "DETECTION",
			cacheKey: expected.detectionKey,
			sectionKey: null,
		});
		expect(result).toMatchObject({
			outcome: "detected",
			fromCache: true,
			opportunities: [
				{ sectionKey: exec, kind: "stat", reason: "" },
				{ sectionKey: team, kind: "org_chart", reason: "Roles" },
			],
		});
	});

	it("covers AE6: no provider for the editor → aiProviderNotConfigured, nothing cached", async () => {
		mocks.detect.mockResolvedValue({
			status: "aiProviderNotConfigured",
			message: "Configure an AI provider.",
		});

		expect(await detect()).toEqual({
			outcome: "aiProviderNotConfigured",
			message: "Configure an AI provider.",
		});
		expect(mocks.putCacheEntry).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("a degraded detection returns no opportunities and caches nothing", async () => {
		mocks.detect.mockResolvedValue({
			status: "degraded",
			reason: "truncated",
			opportunities: [],
		});

		expect(await detect()).toMatchObject({
			outcome: "detected",
			opportunities: [],
			degraded: true,
		});
		expect(mocks.putCacheEntry).not.toHaveBeenCalled();
	});

	it("leaves a section holding a best-fit slot out of the model call but keys the whole body", async () => {
		const body = PROPOSAL_BODY.replace(
			"Alex leads delivery. Sam owns design.",
			'Alex leads delivery. Sam owns design.\n\n<visual-slot data-slot-id="slot-1"></visual-slot>',
		);
		const document = world.documents.get(DOC_A);
		world.documents.set(DOC_A, {
			...(document as NonNullable<typeof document>),
			content: body,
		});
		const expected = planGlossyKeys({
			content: body,
			projectId: PROJECT_A,
			documentType: "PROPOSAL",
		});

		await detect();

		const sections = mocks.detect.mock.calls[0][0].sections as Array<{
			sectionKey: string;
		}>;
		expect(sections.map((section) => section.sectionKey)).toEqual(
			expected.sectionKeys.slice(0, 2),
		);
		expect(mocks.putCacheEntry.mock.calls[0][0].cacheKey).toBe(
			expected.detectionKey,
		);
	});
});

describe("projects.glossy.detect — recipient websites (R33)", () => {
	it("proposes marketing websites first, as https://host, while the project has no recipient brand", async () => {
		world.linkSources = [
			{
				projectId: PROJECT_A,
				sourceUrl: "https://docs.example.com/guide/start",
				knowledgeBaseSourceCategory: "PRODUCT_DOCUMENTATION",
			},
			{
				projectId: PROJECT_A,
				sourceUrl: "https://www.example.com/about?ref=x",
				knowledgeBaseSourceCategory: "MARKETING_WEBSITE",
			},
			{
				projectId: PROJECT_A,
				sourceUrl: "https://docs.example.com/other",
				knowledgeBaseSourceCategory: null,
			},
			{
				projectId: PROJECT_A,
				sourceUrl: "not a website at all",
				knowledgeBaseSourceCategory: null,
			},
			{
				projectId: PROJECT_B,
				sourceUrl: "https://other.example.org",
				knowledgeBaseSourceCategory: "MARKETING_WEBSITE",
			},
		];

		expect((await detect()).recipientWebsiteSuggestions).toEqual([
			"https://www.example.com",
			"https://docs.example.com",
		]);

		world.recipientBrands.set(PROJECT_A, {
			version: 1,
			name: "Example Client",
			website: null,
			colors: [],
			logoKey: null,
			updatedAt: new Date("2026-09-20T09:00:00.000Z"),
		});
		expect((await detect()).recipientWebsiteSuggestions).toEqual([]);
	});
});

describe("projects.glossy.detect — refusals", () => {
	it("covers AE10: the rollout gate off → NOT_FOUND", async () => {
		world.flags.set(ORG_A, false);
		expect(await errorCode(detect())).toBe("NOT_FOUND");
		expect(mocks.detect).not.toHaveBeenCalled();
	});

	it("a guest viewer is FORBIDDEN; a guest editor may detect", async () => {
		expect(await errorCode(detect(USERS.guestViewer))).toBe("FORBIDDEN");
		expect(mocks.detect).not.toHaveBeenCalled();
		expect((await detect(USERS.guestEditor)).outcome).toBe("detected");
		expect(mocks.detect.mock.calls[0][0]).toMatchObject({
			userId: USERS.guestEditor,
			organizationId: ORG_A,
		});
	});

	it("another tenant → NOT_FOUND", async () => {
		expect(await errorCode(detect(USERS.outsider))).toBe("NOT_FOUND");
	});

	it("a PRD is not eligible, and nothing is detected", async () => {
		expect(await detect(USERS.editor, DOC_PRD)).toEqual({
			outcome: "notEligible",
			reason: "documentType",
		});
		expect(mocks.detect).not.toHaveBeenCalled();
	});
});
