/**
 * `instructions.revertCommit` (Fizzy #2878 §10): "Revert" on a commit of a
 * repository-backed project's History. The workflow does the git work (its own
 * suite); what is pinned here is the shell around it: the permission ahead of
 * the handler, that the commit must be on the synced branch before anything
 * starts, the attribution frozen into the request, and how each way the
 * workflow can end reaches the caller: a typed refusal with a stable
 * `data.code`, or the reverted commit.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handler: null as null | ((...a: unknown[]) => Promise<unknown>),
	input: null as unknown,
	permissionMiddleware: vi.fn(),
	requestedPermission: undefined as string | undefined,
	loadCommitSource: vi.fn(),
	assertCommitOnBranch: vi.fn(),
	runRevertCommitWorkflow: vi.fn(),
	isProjectReadOnly: vi.fn(),
	hasPendingDirectCommit: vi.fn(),
	getProjectInstructionSettings: vi.fn(),
	requireHostingOrganizationId: vi.fn(),
	mailFrom: "",
}));

vi.mock("@repo/database", () => ({
	isProjectReadOnly: (...a: unknown[]) => m.isProjectReadOnly(...a),
	hasPendingDirectCommit: (...a: unknown[]) => m.hasPendingDirectCommit(...a),
	getProjectInstructionSettings: (...a: unknown[]) =>
		m.getProjectInstructionSettings(...a),
}));
vi.mock("../hosting-organization", () => ({
	requireHostingOrganizationId: (...a: unknown[]) =>
		m.requireHostingOrganizationId(...a),
}));

vi.mock("../../../../../orpc/middleware/project-visibility", () => ({
	projectNotFoundUnlessVisible: async () => undefined,
}));
vi.mock("@repo/config", () => ({
	config: {
		mails: {
			get from() {
				return m.mailFrom;
			},
		},
	},
}));
vi.mock("../repository-sync/commit-source", () => ({
	loadCommitSource: (...a: unknown[]) => m.loadCommitSource(...a),
	assertCommitOnBranch: (...a: unknown[]) => m.assertCommitOnBranch(...a),
}));
vi.mock("../revert-commit-workflow", () => ({
	runRevertCommitWorkflow: (...a: unknown[]) =>
		m.runRevertCommitWorkflow(...a),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const middlewares: Array<(args: unknown) => unknown> = [];
	const b = {
		use: (mw: (args: unknown) => unknown) => {
			middlewares.push(mw);
			return b;
		},
		route: () => b,
		input: (schema: unknown) => {
			m.input = schema;
			return b;
		},
		handler: (fn: (...a: unknown[]) => unknown) => {
			const composed = async (args: unknown) => {
				for (const mw of middlewares) {
					await mw(args);
				}
				return fn(args as never);
			};
			m.handler = composed;
			return composed;
		},
	};
	return {
		tenantProtectedProcedure: b,
		requireProjectPermission: (permission: string) => {
			m.requestedPermission = permission;
			return (args: unknown) => m.permissionMiddleware(args);
		},
		Permissions: { INSTRUCTION_CREATE: "instruction:create" },
	};
});

import type { ZodType } from "zod";
import "../revert-commit";

// Assembled at run time: no address-shaped literal in the tree.
const NOREPLY = ["noreply", "example.com"].join("@");
const SHA = "a".repeat(40);
const NEW_SHA = "b".repeat(40);

const ctx = {
	user: { id: "user_1", email: "dev@example.com", name: "Pat Example" },
	session: { activeOrganizationId: "org_other" },
};

function call(input: Record<string, unknown> = {}) {
	if (!m.handler) {
		throw new Error("the procedure was not built");
	}
	return m.handler({
		input: { projectId: "proj_1", sha: SHA, ...input },
		context: ctx,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	m.mailFrom = `Fabric <${NOREPLY}>`;
	m.permissionMiddleware.mockResolvedValue(undefined);
	m.isProjectReadOnly.mockResolvedValue(false);
	m.hasPendingDirectCommit.mockResolvedValue(false);
	m.requireHostingOrganizationId.mockResolvedValue("org_host");
	m.getProjectInstructionSettings.mockResolvedValue({
		ignoreGlobs: null,
		sourceOfTruth: "REPOSITORY",
		migration: null,
	});
	m.loadCommitSource.mockResolvedValue({
		organizationId: "org_host",
		ref: "main",
		rootPath: "rules",
	});
	m.assertCommitOnBranch.mockResolvedValue(undefined);
	m.runRevertCommitWorkflow.mockResolvedValue({
		kind: "reverted",
		sha: NEW_SHA,
		ref: "main",
		fileCount: 3,
	});
});

describe("instructions.revertCommit", () => {
	it.each([
		["proposing", "PROPOSING"],
		["switching", "SWITCHING"],
	])(
		"starts nothing while a move into the repository is %s (Fizzy #2878 §9): the branch tip is about to be read from",
		async (_label, state) => {
			m.getProjectInstructionSettings.mockResolvedValue({
				ignoreGlobs: null,
				sourceOfTruth: "REPOSITORY",
				migration: {
					v: 1,
					state,
					branchId: null,
					snapshotId: null,
					syncId: "sync_1",
					pullRequestUrl: null,
					startedAt: "2026-10-03T10:00:00.000Z",
					userId: "user_2",
				},
			});

			await expect(call()).rejects.toMatchObject({
				code: "CONFLICT",
				data: { reason: "MIGRATION_OPEN", state, pullRequest: null },
			});

			expect(m.getProjectInstructionSettings).toHaveBeenCalledWith(
				"proj_1",
				"org_host",
			);
			expect(m.loadCommitSource).not.toHaveBeenCalled();
			expect(m.runRevertCommitWorkflow).not.toHaveBeenCalled();
		},
	);

	it("declares INSTRUCTION_CREATE and short-circuits on a denied permission", async () => {
		expect(m.requestedPermission).toBe("instruction:create");
		m.permissionMiddleware.mockRejectedValueOnce(
			new ORPCError("FORBIDDEN", { message: "no" }),
		);

		await expect(call()).rejects.toThrow("no");

		expect(m.loadCommitSource).not.toHaveBeenCalled();
		expect(m.runRevertCommitWorkflow).not.toHaveBeenCalled();
	});

	it("refuses a project in Read-only mode before anything is read, with the typed error", async () => {
		m.isProjectReadOnly.mockResolvedValue(true);

		await expect(call()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { errorCode: "PROJECT_READ_ONLY" },
		});

		expect(m.isProjectReadOnly).toHaveBeenCalledWith("proj_1");
		expect(m.loadCommitSource).not.toHaveBeenCalled();
		expect(m.runRevertCommitWorkflow).not.toHaveBeenCalled();
	});

	it("words a revert the activity stopped for Read-only mode as the same typed error", async () => {
		m.runRevertCommitWorkflow.mockResolvedValue({
			kind: "failed",
			code: "READ_ONLY_MODE",
		});

		await expect(call()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { errorCode: "PROJECT_READ_ONLY" },
		});
	});

	it("is REVERT_BUSY, starting nothing, while a direct commit of this project is still on its way to the branch", async () => {
		m.hasPendingDirectCommit.mockResolvedValue(true);

		await expect(call()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "REVERT_BUSY" },
		});

		expect(m.hasPendingDirectCommit).toHaveBeenCalledWith({
			projectId: "proj_1",
			organizationId: "org_host",
		});
		expect(m.assertCommitOnBranch).not.toHaveBeenCalled();
		expect(m.runRevertCommitWorkflow).not.toHaveBeenCalled();
	});

	it("is REVERT_BUSY when another revert of this project is still open", async () => {
		m.runRevertCommitWorkflow.mockResolvedValue({ kind: "in_progress" });

		await expect(call()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "REVERT_BUSY" },
		});
	});

	it("starts nothing for a commit that is not on the synced branch", async () => {
		m.assertCommitOnBranch.mockRejectedValue(
			new ORPCError("NOT_FOUND", { message: "not on the branch" }),
		);

		await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(m.runRevertCommitWorkflow).not.toHaveBeenCalled();
	});

	it("starts nothing for a project that is not repository-backed", async () => {
		m.loadCommitSource.mockRejectedValue(
			new ORPCError("PRECONDITION_FAILED", {
				message: "uploaded",
				data: { reason: "NOT_REPOSITORY_SOURCED" },
			}),
		);

		await expect(call()).rejects.toMatchObject({
			data: { reason: "NOT_REPOSITORY_SOURCED" },
		});

		expect(m.runRevertCommitWorkflow).not.toHaveBeenCalled();
	});

	it("freezes the member's attribution and the project's host tenant into the request", async () => {
		await call({ organizationId: "org_attacker" });

		expect(m.loadCommitSource).toHaveBeenCalledWith({
			projectId: "proj_1",
			userId: "user_1",
		});
		expect(m.assertCommitOnBranch).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org_host" }),
			SHA,
		);
		const started = m.runRevertCommitWorkflow.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(started).toMatchObject({
			projectId: "proj_1",
			organizationId: "org_host",
			userId: "user_1",
			sha: SHA,
			author: { name: "Pat Example", email: NOREPLY },
			committer: { name: "Fabric", email: NOREPLY },
		});
		expect(started.requestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
		expect(started.committedAt).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
		);
	});

	it("gives every request its own id, which is the commit's trailer", async () => {
		await call();
		await call();

		const ids = m.runRevertCommitWorkflow.mock.calls.map(
			(c) => (c[0] as { requestId: string }).requestId,
		);
		expect(new Set(ids).size).toBe(2);
	});

	it("answers the reverted commit", async () => {
		expect(await call()).toEqual({
			outcome: "reverted",
			sha: NEW_SHA,
			ref: "main",
			fileCount: 3,
		});
	});

	it("answers unchanged when the branch already holds the restored files", async () => {
		m.runRevertCommitWorkflow.mockResolvedValue({
			kind: "unchanged",
			sha: NEW_SHA,
		});

		expect(await call()).toEqual({ outcome: "unchanged", sha: NEW_SHA });
	});

	it("answers pending, with the request id, when the revert outlived the wait", async () => {
		m.runRevertCommitWorkflow.mockResolvedValue({ kind: "pending" });

		const answer = (await call()) as { outcome: string; requestId: string };

		expect(answer.outcome).toBe("pending");
		expect(answer.requestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
	});

	it.each([
		["REVERT_CONFLICT", "CONFLICT"],
		["REVERT_REJECTED", "UNPROCESSABLE_CONTENT"],
		["REVERT_TOO_LARGE", "UNPROCESSABLE_CONTENT"],
		["REVERT_EMPTY", "UNPROCESSABLE_CONTENT"],
		["REVERT_UNSUPPORTED", "UNPROCESSABLE_CONTENT"],
		["COMMIT_NOT_ON_BRANCH", "NOT_FOUND"],
	])(
		"answers a refusal of %s as %s with a stable code",
		async (code, status) => {
			m.runRevertCommitWorkflow.mockResolvedValue({
				kind: "refused",
				code,
			});

			await expect(call()).rejects.toMatchObject({
				code: status,
				data: {
					code:
						code === "COMMIT_NOT_ON_BRANCH"
							? "COMMIT_NOT_FOUND"
							: code,
				},
			});
		},
	);

	it("answers a protected branch and a busy one as conflicts a person can act on", async () => {
		m.runRevertCommitWorkflow.mockResolvedValue({ kind: "protected" });
		await expect(call()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "BRANCH_PROTECTED" },
		});

		m.runRevertCommitWorkflow.mockResolvedValue({ kind: "busy" });
		await expect(call()).rejects.toMatchObject({
			code: "CONFLICT",
			data: { code: "BRANCH_BUSY" },
		});
	});

	it("answers an infrastructure failure with its code and no detail", async () => {
		m.runRevertCommitWorkflow.mockResolvedValue({
			kind: "failed",
			code: "AUTHENTICATION_FAILED",
		});

		await expect(call()).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			data: { code: "AUTHENTICATION_FAILED" },
		});
	});

	it("refuses an attribution the renderer cannot make safe, before starting anything", async () => {
		m.mailFrom = "Fabric";

		await expect(call()).rejects.toMatchObject({
			code: "UNPROCESSABLE_CONTENT",
			data: { reason: "ATTRIBUTION_REJECTED" },
		});

		expect(m.runRevertCommitWorkflow).not.toHaveBeenCalled();
	});

	describe("input", () => {
		const schema = () => m.input as ZodType;

		it.each([["main"], ["abc123"], [`${SHA}; rm`], ["A".repeat(40)], [""]])(
			"refuses %j: a full object id only",
			(sha) => {
				expect(
					schema().safeParse({ projectId: "proj_1", sha }).success,
				).toBe(false);
			},
		);

		it("accepts a full object id", () => {
			expect(
				schema().safeParse({ projectId: "proj_1", sha: SHA }).success,
			).toBe(true);
		});
	});
});
