/**
 * Tests for `dispatchNewsletterSendActivity` — the idempotent, self-healing
 * dispatcher step (adversarial-review hardening).
 *
 * Contract:
 *   - created row → starts the workflow and persists its id;
 *   - created + start throws a generic error → re-throws and NEVER marks the
 *     send FAILED (finalizeNewsletterSend is not even imported here);
 *   - created + start ok but persisting the id throws → does NOT throw (the
 *     workflow is alive and will finalize the row itself);
 *   - reused terminal row (created:false, status SENT) → returns without start;
 *   - reused PENDING row with no workflowId (a prior dispatch claimed it but
 *     failed at start) → (re)starts with the same deterministic workflowId;
 *   - start throws WorkflowExecutionAlreadyStartedError → returns without
 *     re-throwing (a concurrent dispatch won the race).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

const {
	mockCreateOrGet,
	mockSetWorkflowId,
	mockStart,
	mockGetClient,
	mockActorValid,
	mockReclaim,
} = vi.hoisted(() => ({
	mockCreateOrGet: vi.fn(),
	mockSetWorkflowId: vi.fn(),
	mockStart: vi.fn(),
	mockGetClient: vi.fn(),
	mockActorValid: vi.fn(),
	mockReclaim: vi.fn(),
}));

// Surface a real instanceof-able class so the activity's
// `err instanceof WorkflowExecutionAlreadyStartedError` branch works. Defined
// inside the (hoisted) factory to avoid the top-level-variable hoist trap, then
// re-imported below for use in the test bodies.
vi.mock("@temporalio/client", () => ({
	WorkflowExecutionAlreadyStartedError: class extends Error {},
}));

vi.mock("@repo/database", () => ({
	createOrGetNewsletterSend: (...a: unknown[]) => mockCreateOrGet(...a),
	setNewsletterSendWorkflowId: (...a: unknown[]) => mockSetWorkflowId(...a),
	isScheduledNewsletterActorValid: (...a: unknown[]) => mockActorValid(...a),
	reclaimStaleReviewSends: (...a: unknown[]) => mockReclaim(...a),
	coerceDetailLevel: (v: unknown) =>
		v === "BRIEF" || v === "DETAILED" ? v : "STANDARD",
	coerceDeliveryDestination: (v: unknown) =>
		v === "CHAT" || v === "BOTH" ? v : "EMAIL",
}));

// Relative to THIS test file (src/activities/newsletter/) → resolves to the
// same module the activity imports (`../../client` → src/client).
vi.mock("../../client", () => ({ getTemporalClient: mockGetClient }));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from "@repo/logs";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { dispatchNewsletterSendActivity } from "./dispatch-newsletter-send";

const project = {
	projectId: "proj-1",
	organizationId: null,
	userId: "user-1",
	triggeredByUserId: "user-1",
	projectName: "Acme",
	timeWindowStart: "2026-06-08T09:00:00.000Z",
	timeWindowEnd: "2026-06-15T09:00:00.000Z",
	dedupeKey: "scheduled:proj-1:2026-W25",
	detailLevel: "STANDARD" as const,
	deliveryDestination: "EMAIL" as const,
	chatChannels: [],
	requireApproval: false,
};

beforeEach(() => {
	vi.clearAllMocks();
	mockStart.mockResolvedValue({ workflowId: "newsletter-send-send-1" });
	mockGetClient.mockResolvedValue({ workflow: { start: mockStart } });
	mockSetWorkflowId.mockResolvedValue(undefined);
	mockActorValid.mockResolvedValue(true);
	mockReclaim.mockResolvedValue({
		expiredDraftId: null,
		failedApprovedId: null,
	});
});

describe("dispatchNewsletterSendActivity", () => {
	it("(a) created → starts workflow and persists id", async () => {
		mockCreateOrGet.mockResolvedValue({
			send: { id: "send-1", status: "PENDING", temporalWorkflowId: null },
			created: true,
		});
		await dispatchNewsletterSendActivity(project);
		expect(mockStart).toHaveBeenCalledWith(
			"generateAndSendNewsletterWorkflow",
			expect.objectContaining({
				taskQueue: "fabric-worker",
				workflowId: "newsletter-send-send-1",
			}),
		);
		expect(mockSetWorkflowId).toHaveBeenCalledWith(
			"send-1",
			"newsletter-send-send-1",
		);
	});

	it("(b) created + start throws generic → re-throws, never marks FAILED", async () => {
		mockCreateOrGet.mockResolvedValue({
			send: { id: "send-1", status: "PENDING", temporalWorkflowId: null },
			created: true,
		});
		mockStart.mockRejectedValue(new Error("temporal down"));
		await expect(dispatchNewsletterSendActivity(project)).rejects.toThrow(
			"temporal down",
		);
		// No FAILED finalize: the row stays PENDING for a retry. The activity does
		// not even import finalizeNewsletterSend.
		expect(mockSetWorkflowId).not.toHaveBeenCalled();
	});

	it("(c) created + start ok but persist throws → does NOT throw", async () => {
		mockCreateOrGet.mockResolvedValue({
			send: { id: "send-1", status: "PENDING", temporalWorkflowId: null },
			created: true,
		});
		mockSetWorkflowId.mockRejectedValue(new Error("db blip"));
		await expect(
			dispatchNewsletterSendActivity(project),
		).resolves.toBeUndefined();
		expect(mockStart).toHaveBeenCalledTimes(1);
	});

	it("(d) reused terminal row (created:false, SENT) → returns without starting", async () => {
		mockCreateOrGet.mockResolvedValue({
			send: { id: "send-1", status: "SENT", temporalWorkflowId: "wf-1" },
			created: false,
		});
		await dispatchNewsletterSendActivity(project);
		expect(mockStart).not.toHaveBeenCalled();
		expect(mockSetWorkflowId).not.toHaveBeenCalled();
	});

	it("(e) reused PENDING with no workflowId (created:false) → restarts same id", async () => {
		mockCreateOrGet.mockResolvedValue({
			send: { id: "send-1", status: "PENDING", temporalWorkflowId: null },
			created: false,
		});
		await dispatchNewsletterSendActivity(project);
		expect(mockStart).toHaveBeenCalledWith(
			"generateAndSendNewsletterWorkflow",
			expect.objectContaining({ workflowId: "newsletter-send-send-1" }),
		);
		expect(mockSetWorkflowId).toHaveBeenCalledWith(
			"send-1",
			"newsletter-send-send-1",
		);
	});

	it("(f) start throws AlreadyStarted → returns without re-throwing", async () => {
		mockCreateOrGet.mockResolvedValue({
			send: { id: "send-1", status: "PENDING", temporalWorkflowId: null },
			created: true,
		});
		mockStart.mockRejectedValue(
			new WorkflowExecutionAlreadyStartedError(
				"already running",
				"newsletter-send-send-1",
				"generateAndSendNewsletterWorkflow",
			),
		);
		await expect(
			dispatchNewsletterSendActivity(project),
		).resolves.toBeUndefined();
		expect(mockSetWorkflowId).not.toHaveBeenCalled();
	});

	it("(h) actor invalid at dispatch (removed between sweep and dispatch) → no send, no start", async () => {
		// TOCTOU guard: findDue passed, but the admin was removed before dispatch.
		mockActorValid.mockResolvedValue(false);
		const orgProject = {
			...project,
			organizationId: "org-9",
			userId: null,
		};
		await dispatchNewsletterSendActivity(orgProject);
		expect(mockActorValid).toHaveBeenCalledWith("user-1", "org-9", null);
		expect(mockCreateOrGet).not.toHaveBeenCalled();
		expect(mockReclaim).not.toHaveBeenCalled();
		expect(mockStart).not.toHaveBeenCalled();
		expect(mockSetWorkflowId).not.toHaveBeenCalled();
	});

	it("(g) reused PENDING WITH a temporalWorkflowId → still attempts restart; AlreadyStarted → no re-throw", async () => {
		// Proves we no longer skip a started-but-unfinalized row: a recorded
		// workflowId must NOT short-circuit dispatch — we restart the same
		// deterministic id, and a live workflow makes that a safe no-op.
		mockCreateOrGet.mockResolvedValue({
			send: {
				id: "send-1",
				status: "PENDING",
				temporalWorkflowId: "wf-x",
			},
			created: false,
		});
		mockStart.mockRejectedValue(
			new WorkflowExecutionAlreadyStartedError(
				"already running",
				"newsletter-send-send-1",
				"generateAndSendNewsletterWorkflow",
			),
		);
		await expect(
			dispatchNewsletterSendActivity(project),
		).resolves.toBeUndefined();
		expect(mockStart).toHaveBeenCalledWith(
			"generateAndSendNewsletterWorkflow",
			expect.objectContaining({ workflowId: "newsletter-send-send-1" }),
		);
		// AlreadyStarted path persists nothing.
		expect(mockSetWorkflowId).not.toHaveBeenCalled();
	});

	it("(i) reused row's stored detailLevel wins over the freshly-projected input", async () => {
		// The row was created earlier at BRIEF; a later sweep now projects
		// DETAILED (e.g. settings changed mid-retry). A retry of a still-PENDING
		// row must NOT silently change the level it runs at — the workflow arg
		// must come from the persisted row, not from `p.detailLevel`.
		mockCreateOrGet.mockResolvedValue({
			send: {
				id: "send-1",
				status: "PENDING",
				temporalWorkflowId: null,
				detailLevel: "BRIEF",
			},
			created: true,
		});
		await dispatchNewsletterSendActivity({
			...project,
			detailLevel: "DETAILED",
		});
		const startArgs = mockStart.mock.calls[0][1].args[0];
		expect(startArgs.detailLevel).toBe("BRIEF");
	});

	it("(j) threads deliveryDestination + chatChannels: passed to createOrGetNewsletterSend, and the stored (frozen row) destination + chatChannels reach the workflow-start args", async () => {
		const projectedChatChannels = [
			{
				platform: "SLACK" as const,
				teamId: "team-1",
				channelId: "chan-1",
			},
		];
		const frozenChatChannels = [
			{
				platform: "TEAMS" as const,
				teamId: "team-2",
				channelId: "chan-2",
			},
		];
		// The persisted send row's deliveryDestination (CHAT) and chatChannels
		// deliberately DIFFER from the pre-persist projected values below. The
		// workflow-start args must come from the row read-back (send.*), not from
		// `p.*` — mirrors how test (i) above proves the same read-back precedence
		// for detailLevel (Fizzy 1869: chatChannels is now frozen at creation too).
		mockCreateOrGet.mockResolvedValue({
			send: {
				id: "send-1",
				status: "PENDING",
				temporalWorkflowId: null,
				detailLevel: "STANDARD",
				deliveryDestination: "CHAT",
				chatChannels: frozenChatChannels,
				requireApproval: false,
			},
			created: true,
		});
		await dispatchNewsletterSendActivity({
			...project,
			deliveryDestination: "EMAIL",
			chatChannels: projectedChatChannels,
		});
		expect(mockCreateOrGet).toHaveBeenCalledWith(
			expect.objectContaining({
				deliveryDestination: "EMAIL",
				chatChannels: projectedChatChannels,
			}),
		);
		const startArgs = mockStart.mock.calls[0][1].args[0];
		expect(startArgs.deliveryDestination).toBe("CHAT");
		expect(startArgs.chatChannels).toEqual(frozenChatChannels);
	});

	it("(k) threads requireApproval: passed to createOrGetNewsletterSend, and the stored (frozen row) value reaches the workflow-start args", async () => {
		mockCreateOrGet.mockResolvedValue({
			send: {
				id: "send-1",
				status: "PENDING",
				temporalWorkflowId: null,
				detailLevel: "STANDARD",
				deliveryDestination: "EMAIL",
				chatChannels: [],
				requireApproval: true,
			},
			created: true,
		});
		await dispatchNewsletterSendActivity({
			...project,
			requireApproval: true,
		});
		expect(mockCreateOrGet).toHaveBeenCalledWith(
			expect.objectContaining({ requireApproval: true }),
		);
		const startArgs = mockStart.mock.calls[0][1].args[0];
		expect(startArgs.requireApproval).toBe(true);
	});

	it("(l) reclaims stale review sends for the project before creating/reusing the send row", async () => {
		mockCreateOrGet.mockResolvedValue({
			send: { id: "send-1", status: "PENDING", temporalWorkflowId: null },
			created: true,
		});
		await dispatchNewsletterSendActivity(project);
		expect(mockReclaim).toHaveBeenCalledWith("proj-1");
		const reclaimOrder = mockReclaim.mock.invocationCallOrder[0];
		const createOrGetOrder = mockCreateOrGet.mock.invocationCallOrder[0];
		expect(reclaimOrder).toBeLessThan(createOrGetOrder);
	});

	it("(m) logs a warning when reclaimStaleReviewSends frees a stale send", async () => {
		mockReclaim.mockResolvedValue({
			expiredDraftId: "expired-1",
			failedApprovedId: null,
		});
		mockCreateOrGet.mockResolvedValue({
			send: { id: "send-1", status: "PENDING", temporalWorkflowId: null },
			created: true,
		});
		await dispatchNewsletterSendActivity(project);
		expect(logger.warn).toHaveBeenCalledWith(
			"[Newsletter] reclaimed stale review send",
			expect.objectContaining({
				projectId: "proj-1",
				expiredDraftId: "expired-1",
				failedApprovedId: null,
			}),
		);
	});

	it("(n) does NOT log when reclaimStaleReviewSends finds nothing stale", async () => {
		mockCreateOrGet.mockResolvedValue({
			send: { id: "send-1", status: "PENDING", temporalWorkflowId: null },
			created: true,
		});
		await dispatchNewsletterSendActivity(project);
		expect(logger.warn).not.toHaveBeenCalledWith(
			"[Newsletter] reclaimed stale review send",
			expect.anything(),
		);
	});
});
