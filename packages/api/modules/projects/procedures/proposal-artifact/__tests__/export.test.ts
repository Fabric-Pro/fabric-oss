/**
 * `projects.proposalArtifact.export` (Fizzy #2946): any reader of a
 * client-document Proposal — an organization member or a project guest —
 * starts a server-side PDF or Word export. The procedure starts the export
 * workflow on its own queue with ids only, binds the export to the caller in
 * the workflow's memo, and records who started it. A document the export
 * does not cover (a Business Case, a Proposal whose gate is off) answers a
 * code that sends the download menu to the export it has always used.
 *
 * The permission decision and the access loader are the real ones, run over
 * the world in `proposal-artifact-harness.ts`; Temporal and the rate limiter
 * are mocks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const temporal = vi.hoisted(() => ({
	start: vi.fn(),
	getTemporalClient: vi.fn(),
	checkRateLimit: vi.fn(),
}));

vi.mock("@repo/database", async () =>
	(await import("./proposal-artifact-harness")).databaseModule(),
);
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./proposal-artifact-harness")).proceduresModule(),
);
vi.mock("@repo/temporal", () => ({
	getTemporalClient: temporal.getTemporalClient,
	PROPOSAL_EXPORT_TASK_QUEUE: "proposal-export",
}));
vi.mock("../../../../../lib/rate-limit", () => ({
	checkRateLimit: temporal.checkRateLimit,
}));

import {
	PROPOSAL_EXPORT_ID_PATTERN,
	PROPOSAL_EXPORT_MEMO_KEY,
	PROPOSAL_EXPORT_UNSUPPORTED_CODE,
	PROPOSAL_EXPORT_WORKFLOW_TYPE,
} from "@repo/temporal/proposal-export-types";
import { runWithCorrelationId } from "@repo/utils/correlation-id";
import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import { exportProposalProcedure, PROPOSAL_EXPORT_RATE_LIMIT } from "../export";
import {
	auditRows,
	call,
	DOC_A,
	DOC_A2,
	declaredPermission,
	inputRefusal,
	ORG_A,
	PROJECT_A,
	PROPOSAL_BODY,
	refusal,
	resetMocks,
	resetWorld,
	USERS,
	usePermissionCheck,
	world,
} from "./proposal-artifact-harness";

usePermissionCheck(assertProjectPermission);

const DOC_BUSINESS_CASE = "doc-business-case";

function exportDocument(
	userId: string = USERS.editor,
	input: Record<string, unknown> = {
		projectId: PROJECT_A,
		documentId: DOC_A,
		format: "pdf",
	},
) {
	return call(exportProposalProcedure, input, userId) as Promise<{
		exportId: string;
	}>;
}

function startOptions(): Record<string, unknown> {
	expect(temporal.start).toHaveBeenCalledTimes(1);
	return temporal.start.mock.calls[0][1] as Record<string, unknown>;
}

beforeEach(() => {
	resetWorld();
	resetMocks();
	temporal.start.mockReset();
	temporal.getTemporalClient.mockReset();
	temporal.checkRateLimit.mockReset();

	world.documents.set(DOC_BUSINESS_CASE, {
		id: DOC_BUSINESS_CASE,
		projectId: PROJECT_A,
		type: "BUSINESS_CASE",
		content: PROPOSAL_BODY,
	});
	temporal.start.mockResolvedValue({});
	temporal.getTemporalClient.mockResolvedValue({
		workflow: { start: temporal.start },
	});
	temporal.checkRateLimit.mockResolvedValue({
		allowed: true,
		remaining: 9,
		resetInSeconds: 600,
	});
});

describe("declared chain", () => {
	it("checks DOCUMENT_READ and carries no gate middleware", () => {
		const chain = (exportProposalProcedure as { __chain: unknown[] })
			.__chain;
		expect(chain).toHaveLength(1);
		expect(declaredPermission(exportProposalProcedure)).toBe(
			"document:read",
		);
	});
});

describe("export", () => {
	it("starts the export workflow on its own queue with ids only", async () => {
		const { exportId } = await exportDocument(USERS.editor, {
			projectId: PROJECT_A,
			documentId: DOC_A,
			format: "docx",
		});

		expect(exportId).toMatch(PROPOSAL_EXPORT_ID_PATTERN);
		expect(temporal.start.mock.calls[0][0]).toBe(
			PROPOSAL_EXPORT_WORKFLOW_TYPE,
		);
		const options = startOptions();
		expect(options).toMatchObject({
			taskQueue: "proposal-export",
			workflowId: exportId,
			workflowIdConflictPolicy: "FAIL",
			workflowIdReusePolicy: "REJECT_DUPLICATE",
		});
		expect(options.args).toEqual([
			{
				exportId,
				userId: USERS.editor,
				organizationId: ORG_A,
				projectId: PROJECT_A,
				documentId: DOC_A,
				format: "docx",
			},
		]);
		// No content, no brand and no prompt travel to the worker.
		expect(JSON.stringify(options.args)).not.toContain("Example Proposal");
	});

	it("binds the export to its starter, project and document in the memo", async () => {
		const { exportId } = await exportDocument(USERS.guestViewer);
		const memo = (startOptions().memo as Record<string, unknown>)[
			PROPOSAL_EXPORT_MEMO_KEY
		];
		expect(memo).toEqual({
			userId: USERS.guestViewer,
			organizationId: ORG_A,
			projectId: PROJECT_A,
			documentId: DOC_A,
			format: "pdf",
		});
		expect(exportId).toMatch(PROPOSAL_EXPORT_ID_PATTERN);
	});

	it("keeps the request's correlation id beside the binding", async () => {
		await runWithCorrelationId("corr-export-1", () => exportDocument());
		const memo = startOptions().memo as Record<string, unknown>;
		expect(memo.correlationId).toBe("corr-export-1");
		expect(memo[PROPOSAL_EXPORT_MEMO_KEY]).toBeDefined();
	});

	it("mints a different id for every export", async () => {
		const first = await exportDocument();
		const second = await exportDocument();
		expect(first.exportId).not.toBe(second.exportId);
	});

	it.each([
		["a project guest with a VIEWER role", USERS.guestViewer, true],
		["a project guest with an EDITOR role", USERS.guestEditor, true],
		["an organization member", USERS.editor, false],
		["a VIEWER member", USERS.memberViewer, false],
	])(
		"lets %s export and records whether they are a guest",
		async (_label, userId, guest) => {
			const { exportId } = await exportDocument(userId);

			expect(auditRows()).toEqual([
				expect.objectContaining({
					action: "project.proposal_artifact.export_started",
					category: "project",
					outcome: "success",
					organizationId: ORG_A,
					projectId: PROJECT_A,
					resource: {
						type: "project_document",
						id: DOC_A,
						name: null,
					},
					metadata: { format: "pdf", exportId, guest },
				}),
			]);
		},
	);

	it("refuses a Business Case with the fallback code, starting nothing", async () => {
		const result = await refusal(
			exportDocument(USERS.editor, {
				projectId: PROJECT_A,
				documentId: DOC_BUSINESS_CASE,
				format: "pdf",
			}),
		);
		expect(result).toMatchObject({
			code: "BAD_REQUEST",
			data: { code: PROPOSAL_EXPORT_UNSUPPORTED_CODE },
		});
		expect(temporal.start).not.toHaveBeenCalled();
		expect(auditRows()).toEqual([]);
	});

	it("refuses a Proposal whose gate is off with the fallback code, not NOT_FOUND", async () => {
		world.flags.set(ORG_A, false);
		for (const userId of [USERS.editor, USERS.guestViewer]) {
			const result = await refusal(exportDocument(userId));
			expect(result).toMatchObject({
				code: "BAD_REQUEST",
				data: { code: PROPOSAL_EXPORT_UNSUPPORTED_CODE },
			});
		}
		expect(temporal.start).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND to a document id from another project", async () => {
		const result = await refusal(
			exportDocument(USERS.editor, {
				projectId: PROJECT_A,
				documentId: DOC_A2,
				format: "pdf",
			}),
		);
		expect(result.code).toBe("NOT_FOUND");
		expect(temporal.start).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND to a caller without project access, gate on or off", async () => {
		expect((await refusal(exportDocument(USERS.outsider))).code).toBe(
			"NOT_FOUND",
		);
		world.flags.set(ORG_A, false);
		expect((await refusal(exportDocument(USERS.outsider))).code).toBe(
			"NOT_FOUND",
		);
		expect(temporal.start).not.toHaveBeenCalled();
	});

	it("rate limits per user", async () => {
		temporal.checkRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 42,
		});
		const result = await refusal(exportDocument(USERS.guestViewer));
		expect(result).toMatchObject({
			code: "TOO_MANY_REQUESTS",
			data: { retryAfter: 42 },
		});
		expect(temporal.checkRateLimit).toHaveBeenCalledWith(
			`proposal-export:user:${USERS.guestViewer}`,
			PROPOSAL_EXPORT_RATE_LIMIT.limit,
			PROPOSAL_EXPORT_RATE_LIMIT.windowMs,
		);
		expect(temporal.start).not.toHaveBeenCalled();
	});

	it("answers SERVICE_UNAVAILABLE when the rate limiter is down", async () => {
		temporal.checkRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 0,
			statusCode: 503,
		});
		expect((await refusal(exportDocument())).code).toBe(
			"SERVICE_UNAVAILABLE",
		);
	});

	it("records nothing when the workflow cannot be started", async () => {
		temporal.start.mockRejectedValue(new Error("temporal down"));
		const result = await refusal(exportDocument());
		expect(result.code).toBe("INTERNAL_SERVER_ERROR");
		expect(auditRows()).toEqual([]);
	});

	it("refuses a format it does not produce", async () => {
		const result = await inputRefusal(
			exportDocument(USERS.editor, {
				projectId: PROJECT_A,
				documentId: DOC_A,
				format: "pptx",
			}),
		);
		expect(result.code).toBe("BAD_REQUEST");
		expect(temporal.start).not.toHaveBeenCalled();
	});
});
