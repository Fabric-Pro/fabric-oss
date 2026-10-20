/**
 * `projects.proposalArtifact.exportStatus` (Fizzy #2946): the user who
 * started an export reads whether it is running, ready with a freshly signed
 * download link, or failed with a code. Anyone else — another reader of the
 * same project included — and the starter once they lost access, get the
 * same NOT_FOUND as for an export that does not exist.
 *
 * The permission decision and the access loader are the real ones over the
 * harness world; Temporal's handle and storage signing are mocks.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const temporal = vi.hoisted(() => ({
	getHandle: vi.fn(),
	describe: vi.fn(),
	result: vi.fn(),
	getTemporalClient: vi.fn(),
	getSignedUrl: vi.fn(),
}));

vi.mock("@repo/database", async () =>
	(await import("./proposal-artifact-harness")).databaseModule(),
);
vi.mock("../../../../../orpc/procedures", async () =>
	(await import("./proposal-artifact-harness")).proceduresModule(),
);
vi.mock("@repo/temporal", () => ({
	getTemporalClient: temporal.getTemporalClient,
}));
vi.mock("@repo/storage", async () => ({
	...(await vi.importActual<typeof import("@repo/storage")>("@repo/storage")),
	getSignedUrl: temporal.getSignedUrl,
}));

import { config } from "@repo/config";
import {
	PROPOSAL_EXPORT_MEMO_KEY,
	PROPOSAL_EXPORT_WORKFLOW_TYPE,
} from "@repo/temporal/proposal-export-types";
import { assertProjectPermission } from "../../../../../orpc/middleware/require-permission";
import {
	getProposalExportStatusProcedure,
	PROPOSAL_EXPORT_URL_TTL_SECONDS,
} from "../export-status";
import {
	call,
	DOC_A,
	declaredPermission,
	ORG_A,
	PROJECT_A,
	PROJECT_A2,
	refusal,
	resetMocks,
	resetWorld,
	USERS,
	usePermissionCheck,
	world,
} from "./proposal-artifact-harness";

usePermissionCheck(assertProjectPermission);

const EXPORT_ID = `proposal-export-${"a1".repeat(16)}`;
const KEY = `proposal-exports/${PROJECT_A}/${EXPORT_ID}.pdf`;

function memo(overrides: Record<string, unknown> = {}) {
	return {
		userId: USERS.guestViewer,
		organizationId: ORG_A,
		projectId: PROJECT_A,
		documentId: DOC_A,
		format: "pdf",
		...overrides,
	};
}

function described(
	status: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		type: PROPOSAL_EXPORT_WORKFLOW_TYPE,
		status: { name: status },
		memo: { [PROPOSAL_EXPORT_MEMO_KEY]: memo(), correlationId: "c-1" },
		closeTime: status === "RUNNING" ? undefined : new Date(),
		...overrides,
	};
}

function completed(overrides: Record<string, unknown> = {}) {
	return {
		key: KEY,
		fileName: "example-proposal.pdf",
		contentType: "application/pdf",
		byteSize: 1234,
		warnings: [{ code: "DIAGRAM_PLACEHOLDER", count: 1 }],
		...overrides,
	};
}

function status(
	userId: string = USERS.guestViewer,
	input: Record<string, unknown> = {
		projectId: PROJECT_A,
		exportId: EXPORT_ID,
	},
) {
	return call(getProposalExportStatusProcedure, input, userId) as Promise<
		Record<string, unknown>
	>;
}

beforeEach(() => {
	resetWorld();
	resetMocks();
	for (const mock of Object.values(temporal)) {
		mock.mockReset();
	}
	temporal.getHandle.mockReturnValue({
		describe: temporal.describe,
		result: temporal.result,
	});
	temporal.getTemporalClient.mockResolvedValue({
		workflow: { getHandle: temporal.getHandle },
	});
	temporal.describe.mockResolvedValue(described("RUNNING"));
	temporal.result.mockResolvedValue(completed());
	temporal.getSignedUrl.mockImplementation(
		async (key: string) => `https://storage.example.com/${key}?signed`,
	);
});

describe("declared chain", () => {
	it("checks DOCUMENT_READ and carries no gate middleware", () => {
		const chain = (
			getProposalExportStatusProcedure as { __chain: unknown[] }
		).__chain;
		expect(chain).toHaveLength(1);
		expect(declaredPermission(getProposalExportStatusProcedure)).toBe(
			"document:read",
		);
	});
});

describe("exportStatus", () => {
	it("reports a running export", async () => {
		expect(await status()).toEqual({ status: "RUNNING" });
		expect(temporal.getHandle).toHaveBeenCalledWith(EXPORT_ID);
		expect(temporal.getSignedUrl).not.toHaveBeenCalled();
	});

	it("signs a minutes-long attachment download for a finished export", async () => {
		temporal.describe.mockResolvedValue(described("COMPLETED"));
		const before = Date.now();
		const result = await status();

		expect(result).toMatchObject({
			status: "READY",
			url: `https://storage.example.com/${KEY}?signed`,
			fileName: "example-proposal.pdf",
			warnings: [{ code: "DIAGRAM_PLACEHOLDER", count: 1 }],
		});
		const expiresAt = Date.parse(result.expiresAt as string);
		expect(expiresAt - before).toBeGreaterThanOrEqual(
			PROPOSAL_EXPORT_URL_TTL_SECONDS * 1000 - 1000,
		);
		expect(expiresAt - before).toBeLessThanOrEqual(
			PROPOSAL_EXPORT_URL_TTL_SECONDS * 1000 + 1000,
		);
		expect(PROPOSAL_EXPORT_URL_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
		expect(temporal.getSignedUrl).toHaveBeenCalledWith(KEY, {
			bucket: config.storage.bucketNames.projectContexts,
			expiresIn: PROPOSAL_EXPORT_URL_TTL_SECONDS,
			responseContentDisposition: expect.stringMatching(
				/^attachment; filename="example-proposal\.pdf"/,
			),
			responseContentType: "application/pdf",
		});
	});

	it("mints a new link on every read and never takes one from the workflow", async () => {
		temporal.describe.mockResolvedValue(described("COMPLETED"));
		temporal.result.mockResolvedValue({
			...completed(),
			url: "https://attacker.example.com/stale",
		});
		const first = await status();
		const second = await status();
		expect(first.url).not.toContain("attacker");
		expect(temporal.getSignedUrl).toHaveBeenCalledTimes(2);
		expect(second.url).toBe(first.url);
	});

	it("reports an export past its retention as expired, signing nothing", async () => {
		temporal.describe.mockResolvedValue(
			described("COMPLETED", {
				closeTime: new Date(Date.now() - 25 * 3_600_000),
			}),
		);
		expect(await status()).toEqual({
			status: "FAILED",
			code: "EXPORT_EXPIRED",
		});
		expect(temporal.getSignedUrl).not.toHaveBeenCalled();
	});

	it("refuses to sign a key outside the project's export prefix", async () => {
		temporal.describe.mockResolvedValue(described("COMPLETED"));
		temporal.result.mockResolvedValue(
			completed({
				key: `proposal-exports/${PROJECT_A2}/${EXPORT_ID}.pdf`,
			}),
		);
		expect(await status()).toEqual({
			status: "FAILED",
			code: "EXPORT_FAILED",
		});
		expect(temporal.getSignedUrl).not.toHaveBeenCalled();
	});

	it("reports the code a failed export carries down its cause chain", async () => {
		temporal.describe.mockResolvedValue(described("FAILED"));
		temporal.result.mockRejectedValue(
			Object.assign(new Error("Workflow execution failed"), {
				cause: Object.assign(new Error("Activity task failed"), {
					cause: Object.assign(new Error("too many pages"), {
						type: "TOO_MANY_PAGES",
					}),
				}),
			}),
		);
		expect(await status()).toEqual({
			status: "FAILED",
			code: "TOO_MANY_PAGES",
		});
	});

	it("reports an unknown failure as EXPORT_FAILED and a timeout as EXPORT_TIMED_OUT", async () => {
		temporal.describe.mockResolvedValue(described("FAILED"));
		temporal.result.mockRejectedValue(new Error("boom"));
		expect(await status()).toEqual({
			status: "FAILED",
			code: "EXPORT_FAILED",
		});

		temporal.describe.mockResolvedValue(described("TIMED_OUT"));
		expect(await status()).toEqual({
			status: "FAILED",
			code: "EXPORT_TIMED_OUT",
		});
	});

	it("asks Temporal nothing about an id that is not an export id", async () => {
		for (const exportId of [
			"proposal-analysis-rerun-doc-a-run-1",
			`proposal-export-${"A1".repeat(16)}`,
			`${EXPORT_ID}x`,
			"glossy-build-1",
		]) {
			const result = await refusal(
				status(USERS.guestViewer, { projectId: PROJECT_A, exportId }),
			);
			expect(result.code).toBe("NOT_FOUND");
		}
		expect(temporal.getHandle).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND to an export id with no workflow", async () => {
		temporal.describe.mockRejectedValue(
			Object.assign(new Error("not found"), {
				name: "WorkflowNotFoundError",
			}),
		);
		expect((await refusal(status())).code).toBe("NOT_FOUND");
	});

	it("answers NOT_FOUND to a workflow of another type under an export-shaped id", async () => {
		temporal.describe.mockResolvedValue(
			described("COMPLETED", { type: "glossyEditionBuildWorkflow" }),
		);
		expect((await refusal(status())).code).toBe("NOT_FOUND");
		expect(temporal.getSignedUrl).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND to another reader of the same project", async () => {
		temporal.describe.mockResolvedValue(described("COMPLETED"));
		for (const userId of [USERS.editor, USERS.owner, USERS.guestEditor]) {
			expect((await refusal(status(userId))).code).toBe("NOT_FOUND");
		}
		expect(temporal.getSignedUrl).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND when the export was started for another project", async () => {
		temporal.describe.mockResolvedValue(
			described("COMPLETED", {
				memo: {
					[PROPOSAL_EXPORT_MEMO_KEY]: memo({ projectId: PROJECT_A2 }),
				},
			}),
		);
		expect((await refusal(status())).code).toBe("NOT_FOUND");
	});

	it("answers NOT_FOUND when the export was bound to another organization", async () => {
		temporal.describe.mockResolvedValue(
			described("COMPLETED", {
				memo: {
					[PROPOSAL_EXPORT_MEMO_KEY]: memo({
						organizationId: "org-b",
					}),
				},
			}),
		);
		expect((await refusal(status())).code).toBe("NOT_FOUND");
		expect(temporal.getSignedUrl).not.toHaveBeenCalled();
	});

	it.each(["CANCELLED", "TERMINATED"])(
		"reports a %s export as EXPORT_FAILED",
		async (state) => {
			temporal.describe.mockResolvedValue(described(state));
			expect(await status()).toEqual({
				status: "FAILED",
				code: "EXPORT_FAILED",
			});
			expect(temporal.getSignedUrl).not.toHaveBeenCalled();
		},
	);

	it("answers NOT_FOUND once the starter has lost access to the project", async () => {
		temporal.describe.mockResolvedValue(described("COMPLETED"));
		world.projectMembers.delete(`${PROJECT_A}:${USERS.guestViewer}`);
		expect((await refusal(status())).code).toBe("NOT_FOUND");
		expect(temporal.getSignedUrl).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND once the gate is off", async () => {
		temporal.describe.mockResolvedValue(described("COMPLETED"));
		world.flags.set(ORG_A, false);
		expect((await refusal(status())).code).toBe("NOT_FOUND");
		expect(temporal.getSignedUrl).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND to a memo that does not hold an export binding", async () => {
		temporal.describe.mockResolvedValue(
			described("COMPLETED", { memo: { correlationId: "c-1" } }),
		);
		expect((await refusal(status())).code).toBe("NOT_FOUND");
	});
});
