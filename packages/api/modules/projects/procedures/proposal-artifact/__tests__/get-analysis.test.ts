/**
 * `projects.proposalArtifact.getAnalysis` (Fizzy #2801): the newest
 * Internal Analysis run of a Proposal with its findings, labelled at read
 * time as stale (the document changed since) or timed out (in flight with no
 * update for twenty minutes), and never carrying the analyzed body or the
 * source context stored with the run.
 *
 * Access is covered in `access.test.ts`; this file is about what comes back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () =>
	(await import("./proposal-artifact-harness")).databaseModule(),
);
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./proposal-artifact-harness")).proceduresModule(),
);

import { computeDocumentContentHash } from "@repo/database";
import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import {
	analysisReadLabels,
	getProposalAnalysisProcedure,
	PROPOSAL_ANALYSIS_TIMEOUT_MS,
} from "../get-analysis";
import {
	call,
	DOC_A,
	mocks,
	ORG_A,
	PROJECT_A,
	PROPOSAL_BODY,
	resetMocks,
	resetWorld,
	USERS,
	usePermissionCheck,
	world,
} from "./proposal-artifact-harness";

usePermissionCheck(assertProjectPermission);

const MINUTE = 60_000;

function minutesAgo(minutes: number): Date {
	return new Date(Date.now() - minutes * MINUTE);
}

function finding(position: number, overrides: Record<string, unknown> = {}) {
	return {
		id: `finding-${position}`,
		severity: "IMPORTANT",
		type: "SCOPE",
		title: `Finding ${position}`,
		detail: "The scope leaves the data migration unowned.",
		recommendation: "Name an owner for the migration.",
		sectionHeading: "Executive Summary",
		position,
		...overrides,
	};
}

/** A stored run as the query returns it, for the current document body. */
function storedRun(overrides: Record<string, unknown> = {}) {
	return {
		id: "analysis-1",
		documentId: DOC_A,
		projectId: PROJECT_A,
		organizationId: ORG_A,
		runKey: `proposal-analysis-${DOC_A}-run-1`,
		status: "COMPLETE",
		contentHash: computeDocumentContentHash(PROPOSAL_BODY),
		documentVersion: 4,
		contextCount: 3,
		promptVersionId: "prompt-version-1",
		model: "example-model",
		errorCode: null,
		errorMessage: null,
		startedAt: minutesAgo(5),
		completedAt: minutesAgo(4),
		createdAt: minutesAgo(6),
		updatedAt: minutesAgo(4),
		findings: [finding(0), finding(1, { severity: "BLOCKING" })],
		...overrides,
	};
}

function getAnalysis(userId: string = USERS.editor) {
	return call(
		getProposalAnalysisProcedure,
		{ projectId: PROJECT_A, documentId: DOC_A },
		userId,
	) as Promise<Record<string, unknown> | null>;
}

beforeEach(() => {
	resetWorld();
	resetMocks();
});

describe("getAnalysis", () => {
	it("is null before the first run", async () => {
		expect(await getAnalysis()).toBeNull();
		expect(mocks.getLatestAnalysisForDocument).toHaveBeenCalledWith({
			documentId: DOC_A,
			organizationId: ORG_A,
		});
	});

	it("returns the newest run with its findings in order", async () => {
		mocks.getLatestAnalysisForDocument.mockResolvedValue(storedRun());

		const analysis = await getAnalysis();

		expect(analysis).toMatchObject({
			id: "analysis-1",
			status: "COMPLETE",
			isStale: false,
			timedOut: false,
			documentVersion: 4,
			contextCount: 3,
			model: "example-model",
			errorCode: null,
			errorMessage: null,
		});
		expect(analysis?.findings).toEqual([
			{
				id: "finding-0",
				severity: "IMPORTANT",
				type: "SCOPE",
				title: "Finding 0",
				detail: "The scope leaves the data migration unowned.",
				recommendation: "Name an owner for the migration.",
				sectionHeading: "Executive Summary",
				position: 0,
			},
			expect.objectContaining({ id: "finding-1", severity: "BLOCKING" }),
		]);
	});

	it("completes with no findings as an empty list", async () => {
		mocks.getLatestAnalysisForDocument.mockResolvedValue(
			storedRun({ findings: [] }),
		);

		expect((await getAnalysis())?.findings).toEqual([]);
	});

	it("reports a failed run with its fixed code and message", async () => {
		mocks.getLatestAnalysisForDocument.mockResolvedValue(
			storedRun({
				status: "FAILED",
				errorCode: "MODEL_ERROR",
				errorMessage:
					"The internal analysis could not be completed by the AI model.",
				findings: [],
			}),
		);

		expect(await getAnalysis()).toMatchObject({
			status: "FAILED",
			errorCode: "MODEL_ERROR",
			errorMessage:
				"The internal analysis could not be completed by the AI model.",
			timedOut: false,
		});
	});

	it("never returns the analyzed body, the source context, the workflow key or the tenant columns", async () => {
		// Even when the query hands them over, the response is built field by
		// field and the output schema has no place for them.
		mocks.getLatestAnalysisForDocument.mockResolvedValue(
			storedRun({
				analyzedContent: "INTERNAL MAIN BODY",
				sourceContext: "INTERNAL SOURCE CONTEXT",
			}),
		);

		const analysis = await getAnalysis();
		const serialized = JSON.stringify(analysis);

		for (const key of [
			"analyzedContent",
			"sourceContext",
			"runKey",
			"organizationId",
			"projectId",
			"documentId",
			"contentHash",
			"promptVersionId",
		]) {
			expect(analysis).not.toHaveProperty(key);
		}
		expect(serialized).not.toContain("INTERNAL MAIN BODY");
		expect(serialized).not.toContain("INTERNAL SOURCE CONTEXT");
	});

	describe("isStale", () => {
		it("is true once the document's content differs from what the run analyzed", async () => {
			mocks.getLatestAnalysisForDocument.mockResolvedValue(storedRun());
			const document = world.documents.get(DOC_A);
			world.documents.set(DOC_A, {
				...(document as NonNullable<typeof document>),
				content: `${PROPOSAL_BODY}\n\nAn edit after the analysis.`,
			});

			expect(await getAnalysis()).toMatchObject({ isStale: true });
		});

		it("is false while the content is the analyzed content", async () => {
			mocks.getLatestAnalysisForDocument.mockResolvedValue(storedRun());

			expect(await getAnalysis()).toMatchObject({ isStale: false });
		});
	});

	describe("timedOut", () => {
		it.each(["PENDING", "RUNNING"])(
			"is true for a %s run with no update for over twenty minutes",
			async (status) => {
				mocks.getLatestAnalysisForDocument.mockResolvedValue(
					storedRun({
						status,
						completedAt: null,
						findings: [],
						updatedAt: minutesAgo(21),
					}),
				);

				expect(await getAnalysis()).toMatchObject({
					status,
					timedOut: true,
				});
			},
		);

		it.each(["PENDING", "RUNNING"])(
			"is false for a %s run updated within twenty minutes",
			async (status) => {
				mocks.getLatestAnalysisForDocument.mockResolvedValue(
					storedRun({
						status,
						completedAt: null,
						findings: [],
						updatedAt: minutesAgo(19),
					}),
				);

				expect(await getAnalysis()).toMatchObject({ timedOut: false });
			},
		);

		it.each(["COMPLETE", "FAILED"])(
			"is never true for a finished (%s) run, however old",
			async (status) => {
				mocks.getLatestAnalysisForDocument.mockResolvedValue(
					storedRun({ status, updatedAt: minutesAgo(600) }),
				);

				expect(await getAnalysis()).toMatchObject({ timedOut: false });
			},
		);
	});
});

describe("analysisReadLabels", () => {
	const now = new Date("2026-10-07T12:00:00.000Z");
	const run = {
		status: "RUNNING" as const,
		contentHash: computeDocumentContentHash(PROPOSAL_BODY),
		updatedAt: new Date(now.getTime() - PROPOSAL_ANALYSIS_TIMEOUT_MS),
	};

	it("does not time out exactly at the limit, only past it", () => {
		expect(analysisReadLabels(run, PROPOSAL_BODY, now).timedOut).toBe(
			false,
		);
		expect(
			analysisReadLabels(
				{ ...run, updatedAt: new Date(run.updatedAt.getTime() - 1) },
				PROPOSAL_BODY,
				now,
			).timedOut,
		).toBe(true);
	});

	it("hashes the current content the way the run row stored it", () => {
		expect(analysisReadLabels(run, PROPOSAL_BODY, now).isStale).toBe(false);
		expect(analysisReadLabels(run, `${PROPOSAL_BODY} `, now).isStale).toBe(
			true,
		);
	});
});
