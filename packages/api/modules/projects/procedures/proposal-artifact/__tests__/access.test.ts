/**
 * Who reaches a Proposal's Internal Analysis and Style (Fizzy #2801,
 * Fizzy #2946): members of the project's owning organization, with the
 * rollout gate on for that organization, and nobody else — a project guest
 * least of all, whatever their project role. Answering a finding, clearing
 * an answer, re-running the analysis and saving the Style also need edit
 * rights: a VIEWER or COMMENTER member reads only.
 *
 * The gate middleware, the permission decision and the access loader are the
 * real ones, run in each procedure's declared order over the world in
 * `proposal-artifact-harness.ts`; the analysis, response and style queries,
 * the Temporal client and the rate limiter are mocks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const outside = vi.hoisted(() => ({
	start: vi.fn(),
	findBoundProposalPrompt: vi.fn(),
	checkRateLimit: vi.fn(),
}));

vi.mock("@repo/database", async () =>
	(await import("./proposal-artifact-harness")).databaseModule(),
);
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./proposal-artifact-harness")).proceduresModule(),
);
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: { start: outside.start } }),
}));
vi.mock("@repo/temporal/proposal-artifact-prompts", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	findBoundProposalPrompt: outside.findBoundProposalPrompt,
}));
vi.mock("../../../../../lib/rate-limit", () => ({
	checkRateLimit: outside.checkRateLimit,
}));

import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import { ORGANIZATION_MEMBERSHIP_REQUIRED_CODE } from "../../../lib/proposal-artifact-access";
import { clearFindingResponseProcedure } from "../clear-finding-response";
import { getProposalAnalysisProcedure } from "../get-analysis";
import { getProposalStyleProcedure } from "../get-style";
import { rerunProposalAnalysisProcedure } from "../rerun-analysis";
import { respondToFindingProcedure } from "../respond-to-finding";
import { updateProposalStyleProcedure } from "../update-style";
import {
	auditRows,
	call,
	DOC_A,
	DOC_A2,
	DOC_B,
	DOC_PRD,
	declaredPermission,
	declaredRoute,
	mocks,
	ORG_A,
	ORG_B,
	ORG_GUEST,
	PROJECT_A,
	PROJECT_B,
	refusal,
	resetMocks,
	resetWorld,
	USERS,
	usePermissionCheck,
	world,
} from "./proposal-artifact-harness";

usePermissionCheck(assertProjectPermission);

const STYLE_INPUT = {
	styleDirection: "Calm and precise.",
	primaryColor: "#123456",
	accentColors: ["#abcdef"],
};

const RESPOND_INPUT = {
	runId: "run-1",
	findingId: "run-1-finding",
	kind: "CONFIRMED",
};

/** A key in the analysis workflow's format: key version, colon, 32 hex. */
const STABLE_KEY = "k1:9a8b7c6d5e4f30211203f4e5d6c7b8a9";

const CLEAR_INPUT = {
	stableKey: STABLE_KEY,
	responseId: "response-1",
	version: 1,
};

const ANALYSIS_WRITES = [
	{
		name: "respondToFinding",
		procedure: respondToFindingProcedure,
		extra: RESPOND_INPUT,
	},
	{
		name: "clearFindingResponse",
		procedure: clearFindingResponseProcedure,
		extra: CLEAR_INPUT,
	},
	{
		name: "rerunAnalysis",
		procedure: rerunProposalAnalysisProcedure,
		extra: {},
	},
] as const;

const PROCEDURES = [
	{ name: "getAnalysis", procedure: getProposalAnalysisProcedure, extra: {} },
	...ANALYSIS_WRITES,
	{ name: "getStyle", procedure: getProposalStyleProcedure, extra: {} },
	{
		name: "updateStyle",
		procedure: updateProposalStyleProcedure,
		extra: STYLE_INPUT,
	},
] as const;

/** Every query and outside call a procedure makes past the access gate. */
const READS_AND_WRITES = [
	mocks.getAnalysisForCurrentContent,
	mocks.listResponsesForDocument,
	mocks.upsertFindingResponse,
	mocks.clearFindingResponse,
	mocks.claimRerun,
	mocks.getDocumentStyle,
	mocks.upsertDocumentStyle,
	outside.findBoundProposalPrompt,
];

function callAs(
	entry: (typeof PROCEDURES)[number],
	userId: string,
	ids: { projectId: string; documentId: string } = {
		projectId: PROJECT_A,
		documentId: DOC_A,
	},
) {
	return call(entry.procedure, { ...ids, ...entry.extra }, userId);
}

function nothingRead() {
	for (const query of READS_AND_WRITES) {
		expect(query).not.toHaveBeenCalled();
	}
	expect(outside.checkRateLimit).not.toHaveBeenCalled();
	expect(outside.start).not.toHaveBeenCalled();
	expect(auditRows()).toEqual([]);
}

beforeEach(() => {
	resetWorld();
	resetMocks();
	for (const mock of Object.values(outside)) {
		mock.mockReset();
	}
	outside.start.mockResolvedValue({ firstExecutionRunId: "temporal-run" });
	outside.findBoundProposalPrompt.mockResolvedValue({
		promptId: "prompt-1",
		versionNumber: 1,
		promptVersionId: "prompt-version-1",
	});
	outside.checkRateLimit.mockResolvedValue({
		allowed: true,
		remaining: 10,
		resetInSeconds: 60,
	});
	world.runs.set("run-1", {
		id: "run-1",
		documentId: DOC_A,
		organizationId: ORG_A,
		proseHash: null,
		sourceRunId: null,
		findings: [
			{
				id: "run-1-finding",
				title: "No owner",
				stableKey: STABLE_KEY,
				sectionKey: null,
				sectionHash: null,
			},
		],
	});
	// Every call finds something to clear, so a caller who gets through is
	// answered rather than refused.
	mocks.clearFindingResponse.mockResolvedValue({
		outcome: "cleared",
		kind: "CONFIRMED",
	});
	mocks.claimRerun.mockResolvedValue({
		outcome: "claimed",
		run: {
			analysisId: "run-2",
			runKey: `proposal-analysis-rerun-${DOC_A}-run-2`,
			sourceRunId: "run-1",
			proseHash: "p1:prose",
			contentHash: "content-hash",
			documentVersion: 1,
			timedOutRunIds: [],
		},
	});
	mocks.upsertDocumentStyle.mockResolvedValue({
		documentId: DOC_A,
		projectId: PROJECT_A,
		organizationId: ORG_A,
		styleDirection: "Calm and precise.",
		primaryColor: "#123456",
		accentColors: ["#abcdef"],
		updatedById: USERS.editor,
		updatedAt: new Date("2026-10-07T10:00:00.000Z"),
	});
});

describe("declared permissions", () => {
	it("reads need DOCUMENT_READ and every write needs DOCUMENT_UPDATE", () => {
		expect(declaredPermission(getProposalAnalysisProcedure)).toBe(
			"document:read",
		);
		expect(declaredPermission(getProposalStyleProcedure)).toBe(
			"document:read",
		);
		expect(declaredPermission(updateProposalStyleProcedure)).toBe(
			"document:update",
		);
		for (const { procedure } of ANALYSIS_WRITES) {
			expect(declaredPermission(procedure)).toBe("document:update");
		}
	});

	it("serves the analysis writes as POSTs under the analysis route", () => {
		const base =
			"/projects/{projectId}/documents/{documentId}/proposal-artifact/analysis";
		expect(declaredRoute(getProposalAnalysisProcedure)).toMatchObject({
			method: "GET",
			path: base,
		});
		expect(declaredRoute(respondToFindingProcedure)).toMatchObject({
			method: "POST",
			path: `${base}/responses`,
		});
		expect(declaredRoute(clearFindingResponseProcedure)).toMatchObject({
			method: "POST",
			path: `${base}/responses/clear`,
		});
		expect(declaredRoute(rerunProposalAnalysisProcedure)).toMatchObject({
			method: "POST",
			path: `${base}/rerun`,
		});
	});
});

describe.each(PROCEDURES)("$name", (entry) => {
	it("refuses a project guest with an EDITOR role, naming the membership it lacks", async () => {
		const result = await refusal(callAs(entry, USERS.guestEditor));

		expect(result.code).toBe("FORBIDDEN");
		expect(result.data).toEqual({
			code: ORGANIZATION_MEMBERSHIP_REQUIRED_CODE,
		});
		expect(mocks.isOrganizationMember).toHaveBeenCalledWith(
			USERS.guestEditor,
			ORG_A,
		);
		nothingRead();
	});

	it("refuses a project guest with a VIEWER role", async () => {
		expect((await refusal(callAs(entry, USERS.guestViewer))).code).toBe(
			"FORBIDDEN",
		);
		nothingRead();
	});

	it("scopes every read to the owning organization, never the guest's session organization, even with the membership check stubbed to pass", async () => {
		// The guest's session names their own workspace (ORG_GUEST). With the
		// membership check forced open, the only thing left deciding which
		// rows are read is the organization this procedure resolved — and it
		// must be the project's, so a guest's own workspace never selects
		// anything and the membership asked about is the owning one.
		mocks.isOrganizationMember.mockResolvedValue(true);

		await callAs(entry, USERS.guestEditor).catch(() => undefined);

		expect(mocks.isOrganizationMember).toHaveBeenCalledWith(
			USERS.guestEditor,
			ORG_A,
		);
		expect(mocks.isOrganizationMember).not.toHaveBeenCalledWith(
			USERS.guestEditor,
			ORG_GUEST,
		);
		const reads = READS_AND_WRITES.flatMap((query) =>
			query.mock.calls.map(([args]) => args),
		);
		expect(reads.length).toBeGreaterThan(0);
		for (const args of reads) {
			expect(args).toMatchObject({ organizationId: ORG_A });
		}
	});

	it("refuses a member of another organization naming this project's document", async () => {
		const result = await refusal(callAs(entry, USERS.outsider));

		expect(result).toMatchObject({
			code: "NOT_FOUND",
			message: "Project not found",
		});
		nothingRead();
	});

	it("refuses another organization's document named under this project", async () => {
		const result = await refusal(
			callAs(entry, USERS.editor, {
				projectId: PROJECT_A,
				documentId: DOC_B,
			}),
		);

		expect(result).toMatchObject({
			code: "NOT_FOUND",
			message: "Document not found",
		});
		nothingRead();
	});

	it("refuses a document of another project in the same organization", async () => {
		const result = await refusal(
			callAs(entry, USERS.owner, {
				projectId: PROJECT_A,
				documentId: DOC_A2,
			}),
		);

		expect(result).toMatchObject({
			code: "NOT_FOUND",
			message: "Document not found",
		});
		nothingRead();
	});

	it("refuses an outsider pairing their own project with this document", async () => {
		const result = await refusal(
			callAs(entry, USERS.outsider, {
				projectId: PROJECT_B,
				documentId: DOC_A,
			}),
		);

		expect(result.code).toBe("NOT_FOUND");
		nothingRead();
	});

	it("answers NOT_FOUND to every caller with the gate off, before the permission check", async () => {
		world.flags.set(ORG_A, false);

		for (const userId of [
			USERS.owner,
			USERS.editor,
			USERS.memberViewer,
			USERS.guestEditor,
			USERS.outsider,
		]) {
			expect(await refusal(callAs(entry, userId))).toEqual({
				code: "NOT_FOUND",
				message: "Project not found",
				data: undefined,
			});
		}
		expect(mocks.isOrganizationMember).not.toHaveBeenCalled();
		nothingRead();
	});

	it("resolves the gate for the owning organization, not another one", async () => {
		// Org B's gate off changes nothing for org A's project.
		world.flags.set(ORG_B, false);
		await expect(callAs(entry, USERS.editor)).resolves.not.toThrow();

		// And org B's gate on does not open org A's project.
		world.flags.set(ORG_A, false);
		world.flags.set(ORG_B, true);
		expect((await refusal(callAs(entry, USERS.editor))).code).toBe(
			"NOT_FOUND",
		);
	});

	it("treats a trashed project as missing", async () => {
		const project = world.projects.get(PROJECT_A);
		world.projects.set(PROJECT_A, {
			...(project as NonNullable<typeof project>),
			deletedAt: new Date("2026-10-01T00:00:00.000Z"),
		});

		expect((await refusal(callAs(entry, USERS.editor))).code).toBe(
			"NOT_FOUND",
		);
		nothingRead();
	});

	it("refuses a document that is not a Proposal", async () => {
		const result = await refusal(
			callAs(entry, USERS.editor, {
				projectId: PROJECT_A,
				documentId: DOC_PRD,
			}),
		);

		expect(result.code).toBe("BAD_REQUEST");
		nothingRead();
	});

	it("lets the shared internal predicate decide, refusing a member it turns away", async () => {
		mocks.isProposalInternalReader.mockResolvedValueOnce(false);

		const result = await refusal(callAs(entry, USERS.editor));

		expect(result.code).toBe("NOT_FOUND");
		expect(mocks.isProposalInternalReader).toHaveBeenCalledWith({
			organizationId: ORG_A,
			documentType: "PROPOSAL",
			userId: USERS.editor,
		});
		nothingRead();
	});

	it("serves the project owner and an org member who edits the project", async () => {
		await expect(callAs(entry, USERS.owner)).resolves.not.toThrow();
		await expect(callAs(entry, USERS.editor)).resolves.not.toThrow();
	});
});

describe("an organization member with a VIEWER project role", () => {
	it("reads the Internal Analysis and the Style", async () => {
		await expect(
			call(
				getProposalAnalysisProcedure,
				{ projectId: PROJECT_A, documentId: DOC_A },
				USERS.memberViewer,
			),
		).resolves.toMatchObject({ run: null, findings: [] });
		await expect(
			call(
				getProposalStyleProcedure,
				{ projectId: PROJECT_A, documentId: DOC_A },
				USERS.memberViewer,
			),
		).resolves.toBeNull();

		expect(mocks.getAnalysisForCurrentContent).toHaveBeenCalledWith(
			expect.objectContaining({
				documentId: DOC_A,
				organizationId: ORG_A,
			}),
		);
		expect(mocks.getDocumentStyle).toHaveBeenCalledWith({
			documentId: DOC_A,
			organizationId: ORG_A,
		});
	});

	it("cannot update the Style", async () => {
		const result = await refusal(
			call(
				updateProposalStyleProcedure,
				{ projectId: PROJECT_A, documentId: DOC_A, ...STYLE_INPUT },
				USERS.memberViewer,
			),
		);

		expect(result.code).toBe("FORBIDDEN");
		expect(mocks.upsertDocumentStyle).not.toHaveBeenCalled();
	});
});

describe.each([
	["VIEWER", USERS.memberViewer],
	["COMMENTER", USERS.memberCommenter],
])("an organization member with a %s project role", (_role, userId) => {
	it("reads the Internal Analysis", async () => {
		await expect(
			call(
				getProposalAnalysisProcedure,
				{ projectId: PROJECT_A, documentId: DOC_A },
				userId,
			),
		).resolves.toMatchObject({ findings: [] });
	});

	it.each(ANALYSIS_WRITES)("cannot $name", async (entry) => {
		const result = await refusal(
			call(
				entry.procedure,
				{ projectId: PROJECT_A, documentId: DOC_A, ...entry.extra },
				userId,
			),
		);

		expect(result.code).toBe("FORBIDDEN");
		nothingRead();
	});
});

describe("an organization member with an EDITOR project role", () => {
	it("answers a finding, clears an answer and re-runs the analysis", async () => {
		for (const entry of ANALYSIS_WRITES) {
			await expect(
				call(
					entry.procedure,
					{ projectId: PROJECT_A, documentId: DOC_A, ...entry.extra },
					USERS.editor,
				),
			).resolves.toBeDefined();
		}
		expect(mocks.clearFindingResponse).toHaveBeenCalled();
		expect(mocks.claimRerun).toHaveBeenCalled();
		expect(outside.start).toHaveBeenCalledTimes(1);
	});
});
