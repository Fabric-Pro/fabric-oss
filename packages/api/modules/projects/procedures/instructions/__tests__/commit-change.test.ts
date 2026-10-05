/**
 * `instructions.commitChange` (Fizzy #2878 §10): "Commit to <branch>" on a
 * repository-backed project. The procedure is a thin shell over
 * `submitInstructionChange` in `commit` mode (its own suite), so what is
 * pinned here is the shell: it demands `INSTRUCTION_CREATE` ahead of the
 * handler, it can only ever ask for commit mode, it passes the member and the
 * message through and nothing from the request that names a tenant, and it
 * answers with the snapshot to poll.
 *
 * The stub `.use()` composes each middleware ahead of the real handler, as in
 * `derive-snapshot.test.ts`, so a permission middleware that rejects really
 * short-circuits the call.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handler: null as null | ((...a: unknown[]) => Promise<unknown>),
	input: null as unknown,
	submit: vi.fn(),
	isProjectReadOnly: vi.fn(),
	permissionMiddleware: vi.fn(),
	requestedPermission: undefined as string | undefined,
}));

vi.mock("../../../../../orpc/middleware/project-visibility", () => ({
	projectNotFoundUnlessVisible: async () => undefined,
}));
vi.mock("@repo/database", () => ({
	isProjectReadOnly: (...a: unknown[]) => m.isProjectReadOnly(...a),
}));
vi.mock("../submit-change", () => ({
	submitInstructionChange: (...a: unknown[]) => m.submit(...a),
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
		Permissions: {
			INSTRUCTION_READ: "instruction:read",
			INSTRUCTION_CREATE: "instruction:create",
		},
	};
});

import type { ZodType } from "zod";
import "../commit-change";

const ctx = {
	user: { id: "user_1", email: "dev@example.com", name: "Pat Example" },
	session: { activeOrganizationId: "org_1" },
};

function call(input: Record<string, unknown>) {
	if (!m.handler) {
		throw new Error("the procedure was not built");
	}
	return m.handler({ input, context: ctx });
}

const valid = {
	projectId: "proj_1",
	baseSnapshotId: "snap_base",
	message: "Tighten the rules",
	changes: [{ op: "put", path: "CLAUDE.md", content: "new\n" }],
};

beforeEach(() => {
	m.submit.mockReset();
	m.permissionMiddleware.mockReset();
	m.permissionMiddleware.mockResolvedValue(undefined);
	m.isProjectReadOnly.mockReset();
	m.isProjectReadOnly.mockResolvedValue(false);
	m.submit.mockResolvedValue({
		snapshotId: "snap_new",
		version: 8,
		baseSnapshotId: "snap_base",
		fileCount: 3,
		putCount: 1,
		deleteCount: 0,
		status: "VALIDATING",
		proposalStatus: null,
		published: false,
		mode: "commit",
		pullRequest: null,
	});
});

describe("instructions.commitChange", () => {
	it("declares INSTRUCTION_CREATE as the permission ahead of the handler", () => {
		expect(m.requestedPermission).toBe("instruction:create");
	});

	it("short-circuits on a denied permission, writing nothing", async () => {
		m.permissionMiddleware.mockRejectedValueOnce(
			new ORPCError("FORBIDDEN", { message: "no" }),
		);

		await expect(call(valid)).rejects.toThrow("no");

		expect(m.submit).not.toHaveBeenCalled();
	});

	it("refuses a project in Read-only mode with the typed error, submitting nothing", async () => {
		m.isProjectReadOnly.mockResolvedValue(true);

		await expect(call(valid)).rejects.toMatchObject({
			code: "CONFLICT",
			data: { errorCode: "PROJECT_READ_ONLY" },
		});

		expect(m.isProjectReadOnly).toHaveBeenCalledWith("proj_1");
		expect(m.submit).not.toHaveBeenCalled();
	});

	it("submits in commit mode only, as the signed-in member, with the message and the changes", async () => {
		await call(valid);

		expect(m.submit).toHaveBeenCalledTimes(1);
		expect(m.submit).toHaveBeenCalledWith({
			userId: "user_1",
			projectId: "proj_1",
			baseSnapshotId: "snap_base",
			changes: valid.changes,
			mode: "commit",
			message: "Tighten the rules",
			audit: ctx,
			via: "orpc",
		});
	});

	it("answers with the snapshot to poll and nothing about git", async () => {
		const answer = await call(valid);

		expect(answer).toEqual({
			snapshotId: "snap_new",
			version: 8,
			baseSnapshotId: "snap_base",
			fileCount: 3,
			putCount: 1,
			deleteCount: 0,
			status: "VALIDATING",
		});
	});

	it("passes a refusal from admission through untouched", async () => {
		m.submit.mockRejectedValue(
			new ORPCError("PRECONDITION_FAILED", {
				message: "uploaded, not synced",
				data: { reason: "NOT_REPOSITORY_SOURCED" },
			}),
		);

		await expect(call(valid)).rejects.toMatchObject({
			data: { reason: "NOT_REPOSITORY_SOURCED" },
		});
	});

	describe("input", () => {
		const schema = () => m.input as ZodType;

		it("accepts the documented shape, put and delete alike", () => {
			expect(
				schema().safeParse({
					...valid,
					changes: [
						{
							op: "put",
							path: "a.md",
							content: "x",
							encoding: "utf8",
						},
						{ op: "delete", path: "b.md" },
					],
				}).success,
			).toBe(true);
		});

		it.each([
			["no message", { message: undefined }],
			["an empty message", { message: "" }],
			["an empty change set", { changes: [] }],
			["no base snapshot", { baseSnapshotId: undefined }],
			[
				"an operation it does not know",
				{ changes: [{ op: "rename", path: "a.md" }] },
			],
		])("refuses %s", (_label, over) => {
			expect(schema().safeParse({ ...valid, ...over }).success).toBe(
				false,
			);
		});

		it("has no field through which a caller could pick another mode or tenant", async () => {
			const parsed = schema().safeParse({
				...valid,
				mode: "publish",
				organizationId: "org_other",
			});

			expect(parsed.success).toBe(true);
			expect(parsed.data).not.toHaveProperty("mode");
			await call({
				...valid,
				mode: "publish",
				organizationId: "org_other",
			});
			expect(m.submit.mock.calls.at(-1)?.[0]).toMatchObject({
				mode: "commit",
			});
		});
	});
});
