/**
 * Governed stage-transition requests (plan Slice 5) — authorization
 * boundaries, fail-closed first.
 *
 *  1. `requireProjectPermission(STORY_STAGE_APPROVE)` denies an EDITOR
 *     project member (FORBIDDEN) before any handler runs.
 *  2. The approve/reject handlers map domain refusals (self-approval,
 *     non-approver) to FORBIDDEN and pass the caller as the reviewer.
 *
 * Run with: pnpm --filter @repo/api test modules/projects
 */

import { ORPCError } from "@orpc/client";
import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	class StageApprovalError extends Error {
		code: string;
		constructor(code: string, message: string) {
			super(message);
			this.name = "StageApprovalError";
			this.code = code;
		}
	}
	class StageTransitionBlockedError extends Error {}
	class GovernedActorRequiredError extends Error {}
	class StageTransitionConflictError extends Error {}
	return {
		handlers,
		/** Permission each procedure declared via requireProjectPermission, in import order. */
		declaredPermissions: [] as string[],
		StageApprovalError,
		StageTransitionBlockedError,
		GovernedActorRequiredError,
		StageTransitionConflictError,
		db: {
			project: { findUnique: vi.fn() },
			projectMember: { findUnique: vi.fn() },
			member: { findFirst: vi.fn() },
		},
		grantProjectAccess: vi.fn(),
		approveStageTransitionRequest: vi.fn(),
		rejectStageTransitionRequest: vi.fn(),
		listStageTransitionRequests: vi.fn(),
	};
});

vi.mock("@repo/database", () => ({
	db: mocks.db,
	grantProjectAccess: mocks.grantProjectAccess,
	approveStageTransitionRequest: mocks.approveStageTransitionRequest,
	rejectStageTransitionRequest: mocks.rejectStageTransitionRequest,
	listStageTransitionRequests: mocks.listStageTransitionRequests,
	StageApprovalError: mocks.StageApprovalError,
	StageTransitionBlockedError: mocks.StageTransitionBlockedError,
	GovernedActorRequiredError: mocks.GovernedActorRequiredError,
	StageTransitionConflictError: mocks.StageTransitionConflictError,
}));

// Capture procedure handlers; record which permission each procedure declares.
vi.mock("../../../../orpc/procedures", () => {
	let idx = 0;
	const names = ["list", "approve", "reject"];
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			mocks.handlers[names[idx] ?? `handler_${idx}`] = fn;
			idx++;
			return { _handler: fn };
		},
	};
	return {
		resolveOrganizationIdForCaller: vi.fn(
			async (organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: (permission: string) => {
			mocks.declaredPermissions.push(permission);
			return (c: unknown) => c;
		},
		resolveOrganizationId: vi.fn(
			(organizationId: string | null) => organizationId,
		),
	};
});

import "../stories/stage-requests/list";
import "../stories/stage-requests/approve";
import "../stories/stage-requests/reject";

const PROJECT_ID = "proj-1";
const ORG_ID = "org-A";

async function expectORPCError(
	promise: Promise<unknown>,
	code: string,
): Promise<ORPCError<string, unknown>> {
	const error = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ORPCError);
	expect((error as ORPCError<string, unknown>).code).toBe(code);
	return error as ORPCError<string, unknown>;
}

beforeEach(() => {
	mocks.db.project.findUnique.mockReset();
	mocks.db.projectMember.findUnique.mockReset();
	mocks.db.member.findFirst.mockReset();
	mocks.grantProjectAccess.mockReset();
	mocks.approveStageTransitionRequest.mockReset();
	mocks.rejectStageTransitionRequest.mockReset();
	mocks.listStageTransitionRequests.mockReset();
});

describe("stage-request procedures declare STORY_STAGE_APPROVE / STORY_READ", () => {
	it("list requires STORY_READ; approve and reject require STORY_STAGE_APPROVE", () => {
		expect(mocks.declaredPermissions).toEqual([
			"STORY_READ",
			"STORY_STAGE_APPROVE",
			"STORY_STAGE_APPROVE",
		]);
	});
});

describe("requireProjectPermission(STORY_STAGE_APPROVE) — permission middleware", () => {
	async function invoke(role: "EDITOR" | "PROJECT_ADMIN" | "OWNER") {
		const { requireProjectPermission } = await import(
			"../../../../orpc/middleware/require-permission"
		);
		mocks.db.project.findUnique.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: ORG_ID,
			userId: "user-owner",
		});
		mocks.db.member.findFirst.mockResolvedValue(null);
		mocks.db.projectMember.findUnique.mockResolvedValue({
			role,
			acceptedAt: new Date(),
			expiresAt: null,
		});
		const mw = requireProjectPermission(Permissions.STORY_STAGE_APPROVE);
		const next = vi.fn().mockResolvedValue({ output: "ok" });
		const ctx = {
			user: { id: "user-member" },
			tenantContext: {
				userId: "user-member",
				type: "organization" as const,
				organizationId: ORG_ID,
			},
			activeOrganizationRole: null,
			allowedProjectIds: [] as string[],
		};
		const run = (
			mw as unknown as (
				arg: { context: typeof ctx; next: typeof next },
				input: unknown,
			) => Promise<unknown>
		)({ context: ctx, next }, { projectId: PROJECT_ID, requestId: "r" });
		return { run, next };
	}

	it("denies an EDITOR project member with FORBIDDEN and never grants access", async () => {
		const { run, next } = await invoke("EDITOR");
		await expect(run).rejects.toThrow(
			/FORBIDDEN|Missing required permission/,
		);
		expect(next).not.toHaveBeenCalled();
		expect(mocks.grantProjectAccess).not.toHaveBeenCalled();
	});

	it("allows a PROJECT_ADMIN member through", async () => {
		const { run, next } = await invoke("PROJECT_ADMIN");
		await run;
		expect(next).toHaveBeenCalledTimes(1);
	});
});

describe("approveStageRequest handler", () => {
	const context = {
		user: { id: "user-reviewer" },
		session: { activeOrganizationId: ORG_ID },
	};
	const input = {
		projectId: PROJECT_ID,
		requestId: "req-1",
		organizationId: ORG_ID,
		note: "ok",
	};

	it("maps SELF_APPROVAL to FORBIDDEN", async () => {
		mocks.approveStageTransitionRequest.mockRejectedValue(
			new mocks.StageApprovalError(
				"SELF_APPROVAL",
				"The requester cannot approve their own transition",
			),
		);
		const error = await expectORPCError(
			mocks.handlers.approve({ input, context }) as Promise<unknown>,
			"FORBIDDEN",
		);
		expect(error.data).toEqual({ code: "SELF_APPROVAL" });
	});

	it("maps NOT_AN_APPROVER to FORBIDDEN", async () => {
		mocks.approveStageTransitionRequest.mockRejectedValue(
			new mocks.StageApprovalError("NOT_AN_APPROVER", "Only approvers"),
		);
		await expectORPCError(
			mocks.handlers.approve({ input, context }) as Promise<unknown>,
			"FORBIDDEN",
		);
	});

	it("maps REQUEST_NOT_FOUND to NOT_FOUND and REQUEST_NOT_PENDING to CONFLICT", async () => {
		mocks.approveStageTransitionRequest.mockRejectedValueOnce(
			new mocks.StageApprovalError(
				"REQUEST_NOT_FOUND",
				"Request not found",
			),
		);
		await expectORPCError(
			mocks.handlers.approve({ input, context }) as Promise<unknown>,
			"NOT_FOUND",
		);
		mocks.approveStageTransitionRequest.mockRejectedValueOnce(
			new mocks.StageApprovalError(
				"REQUEST_NOT_PENDING",
				"Already reviewed",
			),
		);
		await expectORPCError(
			mocks.handlers.approve({ input, context }) as Promise<unknown>,
			"CONFLICT",
		);
	});

	it("passes the caller as reviewer scoped to the project and forwards the note", async () => {
		mocks.approveStageTransitionRequest.mockResolvedValue({
			storyId: "story-1",
			toStage: "PUBLISHED",
		});
		const result = await mocks.handlers.approve({ input, context });
		expect(mocks.approveStageTransitionRequest).toHaveBeenCalledWith({
			requestId: "req-1",
			projectId: PROJECT_ID,
			reviewer: { userId: "user-reviewer", organizationId: ORG_ID },
			note: "ok",
		});
		expect(result).toEqual({
			success: true,
			storyId: "story-1",
			toStage: "PUBLISHED",
		});
	});
});

describe("rejectStageRequest handler", () => {
	const context = {
		user: { id: "user-reviewer" },
		session: { activeOrganizationId: null },
	};
	const input = {
		projectId: PROJECT_ID,
		requestId: "req-1",
		organizationId: null,
	};

	it("maps SELF_APPROVAL to FORBIDDEN", async () => {
		mocks.rejectStageTransitionRequest.mockRejectedValue(
			new mocks.StageApprovalError("SELF_APPROVAL", "self"),
		);
		await expectORPCError(
			mocks.handlers.reject({ input, context }) as Promise<unknown>,
			"FORBIDDEN",
		);
	});

	it("uses a null organizationId for personal context (XOR, never undefined)", async () => {
		mocks.rejectStageTransitionRequest.mockResolvedValue({
			storyId: "story-1",
		});
		await mocks.handlers.reject({ input, context });
		expect(mocks.rejectStageTransitionRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				reviewer: { userId: "user-reviewer", organizationId: null },
			}),
		);
	});
});

describe("listStageRequests handler", () => {
	it("scopes the query to the project and forwards status/story filters", async () => {
		mocks.listStageTransitionRequests.mockResolvedValue([{ id: "req-1" }]);
		const result = await mocks.handlers.list({
			input: {
				projectId: PROJECT_ID,
				organizationId: null,
				status: "PENDING",
				storyId: "story-1",
			},
			context: {
				user: { id: "u" },
				session: { activeOrganizationId: null },
			},
		});
		expect(mocks.listStageTransitionRequests).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			status: "PENDING",
			storyId: "story-1",
			limit: undefined,
		});
		expect(result).toEqual({ requests: [{ id: "req-1" }] });
	});
});
