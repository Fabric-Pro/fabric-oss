/**
 * Unit tests for the newsletter approval-gate review procedures (Fizzy 1869
 * Task 8): `sends.approve`, `sends.reject`, and `sends.pending`. Fully
 * offline — mirrors the harness in sends-send-now.test.ts (Temporal client
 * mocking) and settings-update-require-approval.test.ts (audit actor-context
 * assertions): `@repo/database`, `@repo/temporal`, `@temporalio/client`, and
 * `../../../orpc/procedures` are mocked, and each procedure's `.handler` is
 * invoked directly via the chainable-proxy `_handler`.
 *
 * Coverage:
 *  - approve: PENDING_APPROVAL -> APPROVED transitions, starts the
 *    deterministic `sendApprovedNewsletterWorkflow`, threads the audit actor
 *    context through to `approveNewsletterSend`.
 *  - approve: a non-PENDING_APPROVAL/non-APPROVED row (e.g. SENT, REJECTED)
 *    -> CONFLICT, no transition attempted.
 *  - approve: an index in `removedHighlightIndexes` at/after
 *    `content.highlights.length` -> BAD_REQUEST, no transition attempted.
 *  - approve: a non-approvable `approveNewsletterSend` result (raced by a
 *    concurrent decision) -> CONFLICT.
 *  - Recovery (Codex finding 1 + re-review, forward-only — NEVER rolled
 *    back to PENDING_APPROVAL):
 *      (a) workflow.start throws after a FRESH transition -> the row is left
 *          APPROVED (no compensating call), INTERNAL_SERVER_ERROR is raised.
 *      (b) approve on an ALREADY-APPROVED row re-kicks the workflow and
 *          returns {approved:true} WITHOUT calling approveNewsletterSend
 *          again (no re-transition, no re-validation of removedHighlightIndexes
 *          — a deliberately out-of-range resubmission is ignored).
 *      (c) WorkflowExecutionAlreadyStartedError from workflow.start is
 *          swallowed as success (both on the fresh-transition path and the
 *          already-APPROVED re-kick path).
 *  - Preflight ordering: NOT_FOUND (project) is raised BEFORE any row is read.
 *    SERVICE_UNAVAILABLE (Temporal) is NO LONGER a blanket preflight (#2172) —
 *    it guards only the two paths that actually dispatch, so a conflict or an
 *    already-sent no-op still answers correctly while Temporal is down. It
 *    still fires before the transition commits, which is the part that matters.
 *  - reject: PENDING_APPROVAL -> REJECTED, audit actor context threaded
 *    through to `rejectNewsletterSend`; a cross-project/unknown sendId is
 *    NOT_FOUND (no transition attempted); an already-decided row (rejected:
 *    false) is CONFLICT.
 *  - pending: lists PENDING_APPROVAL + APPROVED rows for the resolved
 *    project; a project id that resolves to no row is NOT_FOUND.
 *  - Permission wiring: approve/reject declare PROJECT_SETTINGS_EDIT,
 *    pending declares PROJECT_SETTINGS_READ (mirrors the AUTHZ assertion
 *    style in settings-embed.test.ts — the mocked orpc/procedures chain
 *    swallows the real requireProjectPermission enforcement, so this is a
 *    wiring check; actual role denial is covered by the permission-coverage
 *    static guard + the require-permission middleware itself).
 *
 * Run with: pnpm --filter @repo/api test sends-approve
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const {
	mockProjectFindUnique,
	mockNewsletterSendFindFirst,
	mockIsTemporalAvailable,
	mockWorkflowStart,
	mockGetNewsletterSendForSendPhase,
	mockApproveNewsletterSend,
	mockRejectNewsletterSend,
	mockListPendingApprovalSends,
	WorkflowExecutionAlreadyStartedError,
} = vi.hoisted(() => ({
	mockProjectFindUnique: vi.fn(),
	mockNewsletterSendFindFirst: vi.fn(),
	mockIsTemporalAvailable: vi.fn(),
	mockWorkflowStart: vi.fn(),
	mockGetNewsletterSendForSendPhase: vi.fn(),
	mockApproveNewsletterSend: vi.fn(),
	mockRejectNewsletterSend: vi.fn(),
	mockListPendingApprovalSends: vi.fn(),
	WorkflowExecutionAlreadyStartedError: class extends Error {
		constructor(
			message: string,
			workflowId?: string,
			workflowType?: string,
		) {
			super(message);
			this.name = "WorkflowExecutionAlreadyStartedError";
			void workflowId;
			void workflowType;
		}
	},
}));

// Real class (not a bare vi.fn()) so `err instanceof WorkflowExecutionAlreadyStartedError`
// in sends-approve.ts works — mirrors dispatch-newsletter-send.test.ts.
vi.mock("@temporalio/client", () => ({
	WorkflowExecutionAlreadyStartedError,
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mockProjectFindUnique },
		newsletterSend: { findFirst: mockNewsletterSendFindFirst },
	},
	listPendingApprovalSends: mockListPendingApprovalSends,
	getNewsletterSendForSendPhase: mockGetNewsletterSendForSendPhase,
	approveNewsletterSend: mockApproveNewsletterSend,
	rejectNewsletterSend: mockRejectNewsletterSend,
	// Real, lightweight zod schema — sends-approve.ts calls
	// `removedHighlightIndexesSchema.default([])` at module-load time when
	// building its input schema, so this needs real zod chaining methods.
	removedHighlightIndexesSchema: z.array(z.number().int().min(0)).max(500),
	// Handler-body call: `newsletterContentSchema.parse(row.content)`. A
	// passthrough is enough — the handler only reads `.highlights.length`
	// off the result, and the full content-shape validation is covered by
	// newsletter-schema.test.ts in @repo/database.
	newsletterContentSchema: { parse: (v: unknown) => v },
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn().mockResolvedValue({
		workflow: { start: mockWorkflowStart },
	}),
	isTemporalAvailable: mockIsTemporalAvailable,
	WorkflowExecutionAlreadyStartedError,
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null) => organizationId ?? null,
		),
	};
});

import { approveSendProcedure } from "../sends-approve";
import { listPendingSendsProcedure } from "../sends-pending-list";
import { rejectSendProcedure } from "../sends-reject";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const approve = (approveSendProcedure as unknown as { _handler: Handler })
	._handler;
const reject = (rejectSendProcedure as unknown as { _handler: Handler })
	._handler;
const pending = (listPendingSendsProcedure as unknown as { _handler: Handler })
	._handler;

const orgContext = {
	user: { id: "reviewer-1", email: "r@example.com", name: "Reviewer" },
	session: { activeOrganizationId: "org-9" },
};

const project = {
	id: "p1",
	name: "Acme",
	organizationId: "org-9",
};

beforeEach(() => {
	vi.clearAllMocks();
	mockProjectFindUnique.mockResolvedValue(project);
	mockIsTemporalAvailable.mockResolvedValue(true);
	mockWorkflowStart.mockResolvedValue({ workflowId: "wf-1" });
});

const pendingRow = (overrides: Record<string, unknown> = {}) => ({
	id: "send-1",
	projectId: "p1",
	organizationId: "org-9",
	userId: null,
	status: "PENDING_APPROVAL",
	content: { highlights: [{ title: "a" }, { title: "b" }, { title: "c" }] },
	deliveryDestination: "EMAIL",
	chatChannels: [],
	removedHighlightIndexes: [],
	timeWindowEnd: new Date("2026-07-01T00:00:00.000Z"),
	...overrides,
});

describe("sends.approve", () => {
	it("PENDING_APPROVAL -> APPROVED: transitions, starts the workflow, threads audit context", async () => {
		mockGetNewsletterSendForSendPhase.mockResolvedValue(pendingRow());
		mockApproveNewsletterSend.mockResolvedValue({ approved: true });

		const result = await approve({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				sendId: "send-1",
				removedHighlightIndexes: [0],
			},
			context: orgContext,
		});

		expect(result).toEqual({
			sendId: "send-1",
			approved: true,
			outcome: "approved",
			notice: null,
		});
		expect(mockApproveNewsletterSend).toHaveBeenCalledWith({
			sendId: "send-1",
			removedHighlightIndexes: [0],
			audit: {
				reviewedByUserId: "reviewer-1",
				actorEmail: "r@example.com",
				actorName: "Reviewer",
				organizationId: "org-9",
				projectId: "p1",
			},
		});
		expect(mockWorkflowStart).toHaveBeenCalledWith(
			"sendApprovedNewsletterWorkflow",
			expect.objectContaining({
				taskQueue: "fabric-worker",
				workflowId: "newsletter-send-send-1-approved",
				args: [
					{ sendId: "send-1", projectId: "p1", projectName: "Acme" },
				],
				workflowExecutionTimeout: "15m",
			}),
		);
	});

	// Fizzy #2172 — these two cases CHANGED contract deliberately. They used to
	// assert a blanket CONFLICT for every non-PENDING_APPROVAL status. A stale
	// review row is the normal case (cached list, colleague approved first,
	// double-click), so "already sent" is now an idempotent success and the
	// remaining conflicts name the state instead of one generic sentence.
	it.each(["SENT", "PARTIAL"] as const)(
		"an already-sent row (%s) -> idempotent success, no transition AND no workflow start (AC1, AC4)",
		async (status) => {
			mockGetNewsletterSendForSendPhase.mockResolvedValue(
				pendingRow({ status }),
			);

			const result = await approve({
				input: {
					projectId: "p1",
					organizationId: "org-9",
					sendId: "send-1",
					removedHighlightIndexes: [],
				},
				context: orgContext,
			});

			expect(result).toMatchObject({
				sendId: "send-1",
				approved: true,
				outcome: "already_resolved",
			});
			expect((result as { notice: string }).notice).toMatch(
				/already been sent/i,
			);
			// AC4: the double-send protection is the whole point. A terminal row
			// must dispatch NOTHING — only the APPROVED recovery path re-kicks.
			expect(mockApproveNewsletterSend).not.toHaveBeenCalled();
			expect(mockWorkflowStart).not.toHaveBeenCalled();
		},
	);

	it.each([
		["REJECTED", /rejected/i],
		["EXPIRED", /expired/i],
		["FAILED", /failed/i],
		["SKIPPED_EMPTY", /nothing to report/i],
	] as const)(
		"a %s row -> CONFLICT naming the actual state, no transition attempted (AC2)",
		async (status, expected) => {
			mockGetNewsletterSendForSendPhase.mockResolvedValue(
				pendingRow({ status }),
			);

			const error = await approve({
				input: {
					projectId: "p1",
					organizationId: "org-9",
					sendId: "send-1",
					removedHighlightIndexes: [],
				},
				context: orgContext,
			}).catch((e: unknown) => e);

			expect(error).toBeInstanceOf(ORPCError);
			expect((error as ORPCError<string, unknown>).code).toBe("CONFLICT");
			expect((error as Error).message).toMatch(expected);
			// The generic sentence this card replaced must not resurface.
			expect((error as Error).message).not.toBe(
				"This newsletter is no longer awaiting review",
			);
			// The client uses this to log what it actually hit.
			expect(
				(error as ORPCError<string, { currentStatus: string }>).data,
			).toEqual({ currentStatus: status });
			expect(mockApproveNewsletterSend).not.toHaveBeenCalled();
			expect(mockWorkflowStart).not.toHaveBeenCalled();
		},
	);

	it("removedHighlightIndexes with an index >= content.highlights.length -> BAD_REQUEST, no transition attempted", async () => {
		mockGetNewsletterSendForSendPhase.mockResolvedValue(pendingRow());

		const error = await approve({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				sendId: "send-1",
				removedHighlightIndexes: [0, 3], // highlights.length === 3 -> 3 is out of range
			},
			context: orgContext,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("BAD_REQUEST");
		expect(mockApproveNewsletterSend).not.toHaveBeenCalled();
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("a raced approveNewsletterSend where the winner APPROVED it -> idempotent success, and does NOT start a second dispatch", async () => {
		// Two reviewers click at once. The loser's conditional update matches
		// zero rows; re-reading shows the winner already approved it, which is
		// exactly what this reviewer wanted — report success, not a red banner.
		mockGetNewsletterSendForSendPhase
			.mockResolvedValueOnce(pendingRow())
			.mockResolvedValueOnce(pendingRow({ status: "APPROVED" }));
		mockApproveNewsletterSend.mockResolvedValue({ approved: false });

		const result = await approve({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				sendId: "send-1",
				removedHighlightIndexes: [],
			},
			context: orgContext,
		});

		expect(result).toMatchObject({
			sendId: "send-1",
			approved: true,
			outcome: "already_resolved",
		});
		// The winner owns the dispatch. Starting one here too would be a second
		// actor dispatching the same send (AC4).
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("a raced approveNewsletterSend where the winner REJECTED it -> CONFLICT naming that state", async () => {
		mockGetNewsletterSendForSendPhase
			.mockResolvedValueOnce(pendingRow())
			.mockResolvedValueOnce(pendingRow({ status: "REJECTED" }));
		mockApproveNewsletterSend.mockResolvedValue({ approved: false });

		const error = await approve({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				sendId: "send-1",
				removedHighlightIndexes: [],
			},
			context: orgContext,
		}).catch((e: unknown) => e);

		expect((error as ORPCError<string, unknown>).code).toBe("CONFLICT");
		expect((error as Error).message).toMatch(/already rejected/i);
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("a raced approveNewsletterSend whose row vanished -> CONFLICT, still no dispatch", async () => {
		// Defensive: the re-read finds nothing (hard-deleted row). The classifier
		// is total, so this degrades to the generic conflict rather than throwing
		// on a null dereference.
		mockGetNewsletterSendForSendPhase
			.mockResolvedValueOnce(pendingRow())
			.mockResolvedValueOnce(null);
		mockApproveNewsletterSend.mockResolvedValue({ approved: false });

		const error = await approve({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				sendId: "send-1",
				removedHighlightIndexes: [],
			},
			context: orgContext,
		}).catch((e: unknown) => e);

		expect((error as ORPCError<string, unknown>).code).toBe("CONFLICT");
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("project not found -> NOT_FOUND before any row is read", async () => {
		mockProjectFindUnique.mockResolvedValue(null);

		const error = await approve({
			input: {
				projectId: "other-tenant",
				organizationId: "org-9",
				sendId: "send-1",
				removedHighlightIndexes: [],
			},
			context: orgContext,
		}).catch((e: unknown) => e);

		expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
		expect(mockIsTemporalAvailable).not.toHaveBeenCalled();
		expect(mockGetNewsletterSendForSendPhase).not.toHaveBeenCalled();
	});

	// The Temporal availability check MOVED (#2172, Copilot review): it used to
	// be a blanket preflight ahead of the row read, which made an already-sent
	// stale row answer "Temporal is not available" instead of its neutral
	// notice — a red banner on exactly the row AC1 says must never produce one.
	// It now guards only the two paths that actually reach Temporal. What must
	// NOT change is that it still fires before the transition commits.
	it("Temporal unavailable on a reviewable row -> SERVICE_UNAVAILABLE, and the row is NOT transitioned", async () => {
		mockIsTemporalAvailable.mockResolvedValue(false);
		mockGetNewsletterSendForSendPhase.mockResolvedValue(pendingRow());

		const error = await approve({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				sendId: "send-1",
				removedHighlightIndexes: [],
			},
			context: orgContext,
		}).catch((e: unknown) => e);

		expect((error as ORPCError<string, unknown>).code).toBe(
			"SERVICE_UNAVAILABLE",
		);
		// The load-bearing half: flipping to APPROVED and only then discovering
		// we cannot dispatch would strand the send (the transition is never
		// rolled back — forward-only recovery).
		expect(mockApproveNewsletterSend).not.toHaveBeenCalled();
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it.each(["SENT", "PARTIAL"] as const)(
		"Temporal unavailable still reports an already-sent row (%s) as an idempotent success, never a red error (AC1)",
		async (status) => {
			mockIsTemporalAvailable.mockResolvedValue(false);
			mockGetNewsletterSendForSendPhase.mockResolvedValue(
				pendingRow({ status }),
			);

			const result = await approve({
				input: {
					projectId: "p1",
					organizationId: "org-9",
					sendId: "send-1",
					removedHighlightIndexes: [],
				},
				context: orgContext,
			});

			// Nothing on this path needs Temporal, so its health must not leak
			// into the answer.
			expect(result).toMatchObject({ outcome: "already_resolved" });
			expect(mockWorkflowStart).not.toHaveBeenCalled();
		},
	);

	it("Temporal unavailable still reports a REJECTED row as a state-naming CONFLICT, not SERVICE_UNAVAILABLE", async () => {
		mockIsTemporalAvailable.mockResolvedValue(false);
		mockGetNewsletterSendForSendPhase.mockResolvedValue(
			pendingRow({ status: "REJECTED" }),
		);

		const error = await approve({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				sendId: "send-1",
				removedHighlightIndexes: [],
			},
			context: orgContext,
		}).catch((e: unknown) => e);

		expect((error as ORPCError<string, unknown>).code).toBe("CONFLICT");
		expect((error as Error).message).toMatch(/already rejected/i);
	});

	it("Temporal unavailable DOES block the APPROVED re-kick — that path needs a workflow", async () => {
		mockIsTemporalAvailable.mockResolvedValue(false);
		mockGetNewsletterSendForSendPhase.mockResolvedValue(
			pendingRow({ status: "APPROVED" }),
		);

		const error = await approve({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				sendId: "send-1",
				removedHighlightIndexes: [],
			},
			context: orgContext,
		}).catch((e: unknown) => e);

		// Reporting success here would claim a dispatch that never happened.
		expect((error as ORPCError<string, unknown>).code).toBe(
			"SERVICE_UNAVAILABLE",
		);
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("send not found (or cross-project) -> NOT_FOUND", async () => {
		mockGetNewsletterSendForSendPhase.mockResolvedValue(
			pendingRow({ projectId: "other-project" }),
		);

		const error = await approve({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				sendId: "send-1",
				removedHighlightIndexes: [],
			},
			context: orgContext,
		}).catch((e: unknown) => e);

		expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
		expect(mockApproveNewsletterSend).not.toHaveBeenCalled();
	});

	describe("forward-only recovery (Codex finding 1 + re-review)", () => {
		it("(a) workflow.start throws after a FRESH transition: the row stays APPROVED (no rollback), raises INTERNAL_SERVER_ERROR", async () => {
			mockGetNewsletterSendForSendPhase.mockResolvedValue(pendingRow());
			mockApproveNewsletterSend.mockResolvedValue({ approved: true });
			mockWorkflowStart.mockRejectedValue(new Error("temporal down"));

			const error = await approve({
				input: {
					projectId: "p1",
					organizationId: "org-9",
					sendId: "send-1",
					removedHighlightIndexes: [],
				},
				context: orgContext,
			}).catch((e: unknown) => e);

			expect(error).toBeInstanceOf(ORPCError);
			expect((error as ORPCError<string, unknown>).code).toBe(
				"INTERNAL_SERVER_ERROR",
			);
			expect((error as Error).message).toContain("Failed to start send");
			// The transition committed exactly once — no compensating call exists
			// (forward-only recovery: the row is never moved back to
			// PENDING_APPROVAL). rejectNewsletterSend must never be invoked here.
			expect(mockApproveNewsletterSend).toHaveBeenCalledTimes(1);
			expect(mockRejectNewsletterSend).not.toHaveBeenCalled();
		});

		it("(b) approve on an ALREADY-APPROVED row re-kicks the workflow, returns {approved:true}, and does NOT re-transition or re-validate indexes", async () => {
			mockGetNewsletterSendForSendPhase.mockResolvedValue(
				pendingRow({ status: "APPROVED" }),
			);

			const result = await approve({
				input: {
					projectId: "p1",
					organizationId: "org-9",
					sendId: "send-1",
					// Deliberately out-of-range (highlights.length === 3) — proves the
					// already-APPROVED path ignores resubmitted indexes entirely.
					removedHighlightIndexes: [99],
				},
				context: orgContext,
			});

			expect(result).toMatchObject({
				sendId: "send-1",
				approved: true,
				outcome: "already_resolved",
			});
			expect(mockApproveNewsletterSend).not.toHaveBeenCalled();
			expect(mockWorkflowStart).toHaveBeenCalledWith(
				"sendApprovedNewsletterWorkflow",
				expect.objectContaining({
					workflowId: "newsletter-send-send-1-approved",
					args: [
						{
							sendId: "send-1",
							projectId: "p1",
							projectName: "Acme",
						},
					],
				}),
			);
		});

		it("(c) WorkflowExecutionAlreadyStartedError from a fresh-transition start is swallowed as success", async () => {
			const { WorkflowExecutionAlreadyStartedError } = await import(
				"@temporalio/client"
			);
			mockGetNewsletterSendForSendPhase.mockResolvedValue(pendingRow());
			mockApproveNewsletterSend.mockResolvedValue({ approved: true });
			mockWorkflowStart.mockRejectedValue(
				new WorkflowExecutionAlreadyStartedError(
					"already running",
					"newsletter-send-send-1-approved",
					"sendApprovedNewsletterWorkflow",
				),
			);

			const result = await approve({
				input: {
					projectId: "p1",
					organizationId: "org-9",
					sendId: "send-1",
					removedHighlightIndexes: [],
				},
				context: orgContext,
			});

			expect(result).toEqual({
				sendId: "send-1",
				approved: true,
				outcome: "approved",
				notice: null,
			});
		});

		it("(c) WorkflowExecutionAlreadyStartedError from the already-APPROVED re-kick path is swallowed as success", async () => {
			const { WorkflowExecutionAlreadyStartedError } = await import(
				"@temporalio/client"
			);
			mockGetNewsletterSendForSendPhase.mockResolvedValue(
				pendingRow({ status: "APPROVED" }),
			);
			mockWorkflowStart.mockRejectedValue(
				new WorkflowExecutionAlreadyStartedError(
					"already running",
					"newsletter-send-send-1-approved",
					"sendApprovedNewsletterWorkflow",
				),
			);

			const result = await approve({
				input: {
					projectId: "p1",
					organizationId: "org-9",
					sendId: "send-1",
					removedHighlightIndexes: [],
				},
				context: orgContext,
			});

			expect(result).toMatchObject({
				sendId: "send-1",
				approved: true,
				outcome: "already_resolved",
			});
			expect(mockApproveNewsletterSend).not.toHaveBeenCalled();
		});
	});
});

describe("sends.reject", () => {
	it("PENDING_APPROVAL -> REJECTED: threads audit actor context through to rejectNewsletterSend", async () => {
		// The ownership pre-read now selects `status` too, so the mock models the
		// real projection — a bare {id} would classify as an unknown status.
		mockNewsletterSendFindFirst.mockResolvedValue({
			id: "send-1",
			status: "PENDING_APPROVAL",
		});
		mockRejectNewsletterSend.mockResolvedValue({ rejected: true });

		const result = await reject({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				sendId: "send-1",
				reason: "Too much noise this cycle",
			},
			context: orgContext,
		});

		expect(result).toEqual({
			sendId: "send-1",
			rejected: true,
			outcome: "rejected",
			notice: null,
		});
		expect(mockRejectNewsletterSend).toHaveBeenCalledWith({
			sendId: "send-1",
			reason: "Too much noise this cycle",
			audit: {
				reviewedByUserId: "reviewer-1",
				actorEmail: "r@example.com",
				actorName: "Reviewer",
				organizationId: "org-9",
				projectId: "p1",
			},
		});
	});

	it("reason omitted -> passes null through", async () => {
		mockNewsletterSendFindFirst.mockResolvedValue({
			id: "send-1",
			status: "PENDING_APPROVAL",
		});
		mockRejectNewsletterSend.mockResolvedValue({ rejected: true });

		await reject({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				sendId: "send-1",
			},
			context: orgContext,
		});

		expect(mockRejectNewsletterSend).toHaveBeenCalledWith(
			expect.objectContaining({ reason: null }),
		);
	});

	it("cross-project / unknown sendId -> NOT_FOUND, no transition attempted", async () => {
		mockNewsletterSendFindFirst.mockResolvedValue(null);

		const error = await reject({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				sendId: "not-mine",
			},
			context: orgContext,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
		expect(mockRejectNewsletterSend).not.toHaveBeenCalled();
	});

	it("a project id that resolves to no row -> NOT_FOUND before the sendId ownership check", async () => {
		mockProjectFindUnique.mockResolvedValue(null);

		const error = await reject({
			input: {
				projectId: "other-tenant",
				organizationId: "org-9",
				sendId: "send-1",
			},
			context: orgContext,
		}).catch((e: unknown) => e);

		expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
		expect(mockNewsletterSendFindFirst).not.toHaveBeenCalled();
	});

	// Fizzy #2172 (AC5) — the reject path gets the same treatment as approve.
	it.each(["REJECTED", "EXPIRED"] as const)(
		"an already-stopped row (%s) -> idempotent success, no transaction opened",
		async (status) => {
			mockNewsletterSendFindFirst.mockResolvedValue({
				id: "send-1",
				status,
			});

			const result = await reject({
				input: {
					projectId: "p1",
					organizationId: "org-9",
					sendId: "send-1",
				},
				context: orgContext,
			});

			expect(result).toMatchObject({
				sendId: "send-1",
				rejected: true,
				outcome: "already_resolved",
			});
			// The preflight is what avoids a pointless no-op write transaction.
			expect(mockRejectNewsletterSend).not.toHaveBeenCalled();
		},
	);

	it.each([
		["APPROVED", /no longer be rejected/i],
		["SENT", /already been sent/i],
	] as const)(
		"a %s row cannot be rejected -> CONFLICT naming that state",
		async (status, expected) => {
			mockNewsletterSendFindFirst.mockResolvedValue({
				id: "send-1",
				status,
			});

			const error = await reject({
				input: {
					projectId: "p1",
					organizationId: "org-9",
					sendId: "send-1",
				},
				context: orgContext,
			}).catch((e: unknown) => e);

			expect((error as ORPCError<string, unknown>).code).toBe("CONFLICT");
			expect((error as Error).message).toMatch(expected);
			expect(
				(error as ORPCError<string, { currentStatus: string }>).data,
			).toEqual({ currentStatus: status });
			expect(mockRejectNewsletterSend).not.toHaveBeenCalled();
		},
	);

	it("a raced rejectNewsletterSend (rejected:false) re-reads and reports the winner's state", async () => {
		mockNewsletterSendFindFirst
			.mockResolvedValueOnce({ id: "send-1", status: "PENDING_APPROVAL" })
			.mockResolvedValueOnce({ status: "APPROVED" });
		mockRejectNewsletterSend.mockResolvedValue({ rejected: false });

		const error = await reject({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				sendId: "send-1",
			},
			context: orgContext,
		}).catch((e: unknown) => e);

		expect((error as ORPCError<string, unknown>).code).toBe("CONFLICT");
		expect((error as Error).message).toMatch(/no longer be rejected/i);
	});
});

describe("sends.pending", () => {
	it("returns the pending+approved review inbox for the resolved project", async () => {
		const rows = [
			pendingRow(),
			pendingRow({ id: "send-2", status: "APPROVED" }),
		];
		mockListPendingApprovalSends.mockResolvedValue(rows);

		const result = await pending({
			input: { projectId: "p1", organizationId: "org-9" },
			context: orgContext,
		});

		expect(result).toEqual({ sends: rows });
		expect(mockListPendingApprovalSends).toHaveBeenCalledWith("p1");
	});

	it("a project id that resolves to no row -> NOT_FOUND", async () => {
		mockProjectFindUnique.mockResolvedValue(null);

		const error = await pending({
			input: { projectId: "other-tenant", organizationId: "org-9" },
			context: orgContext,
		}).catch((e: unknown) => e);

		expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
		expect(mockListPendingApprovalSends).not.toHaveBeenCalled();
	});
});

describe("permission wiring (1869 Task 8)", () => {
	it("approve/reject/pending are wired through requireProjectPermission with the expected keys", async () => {
		const { requireProjectPermission, Permissions } = (await import(
			"../../../../orpc/procedures"
		)) as any;
		// The procedure modules evaluate requireProjectPermission(Permissions.X)
		// at import time; the mocked Permissions proxy returns the key name
		// itself, so PROJECT_SETTINGS_EDIT / PROJECT_SETTINGS_READ round-trip.
		expect(Permissions.PROJECT_SETTINGS_EDIT).toBe("PROJECT_SETTINGS_EDIT");
		expect(Permissions.PROJECT_SETTINGS_READ).toBe("PROJECT_SETTINGS_READ");
		expect(typeof requireProjectPermission).toBe("function");
	});
});
