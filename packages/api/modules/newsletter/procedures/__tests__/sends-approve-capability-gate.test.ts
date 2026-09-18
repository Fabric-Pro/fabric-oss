/**
 * The capability gate on approving a release-notes send (Fizzy #1930).
 *
 * Placement carries most of the weight here, and it is not "as early as
 * possible". This procedure is reached with a deliberately stale row as the
 * NORMAL case — the pending list is cached, so by the time Approve is pressed
 * the send may already have been approved or sent. Asserting right after
 * authorization would answer those rows with a red refusal instead of the
 * neutral notice Fizzy #2172 exists to give, which is the regression that file
 * already documents for `requireTemporal`. So the gate sits on the fresh
 * dispatch path, before the point of no return.
 *
 * The APPROVED re-kick is deliberately left ungated and pinned as such: its
 * content is already generated and frozen, so refusing it could only strand a
 * row that a failed `workflow.start` left behind.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mocks: {
		isFeatureEnabled: vi.fn(),
		gatherCapabilityEvidence: vi.fn(),
		findUnique: vi.fn(),
		getNewsletterSendForSendPhase: vi.fn(),
		approveNewsletterSend: vi.fn(),
		isTemporalAvailable: vi.fn(),
		workflowStart: vi.fn(),
	},
}));

vi.mock("@repo/database", async () => {
	const { z } = await import("zod");
	return {
		isFeatureEnabled: mocks.isFeatureEnabled,
		db: { project: { findUnique: mocks.findUnique } },
		getNewsletterSendForSendPhase: mocks.getNewsletterSendForSendPhase,
		approveNewsletterSend: mocks.approveNewsletterSend,
		newsletterContentSchema: { parse: (value: unknown) => value },
		removedHighlightIndexesSchema: z.array(z.number()),
	};
});

vi.mock("../../../capabilities/evidence", () => ({
	gatherCapabilityEvidence: mocks.gatherCapabilityEvidence,
}));

vi.mock("@repo/temporal", () => ({
	isTemporalAvailable: mocks.isTemporalAvailable,
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));

vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(args: T) => args,
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.approve = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

await import("../sends-approve");

import {
	evidenceWith,
	healthyEvidence,
} from "../../../capabilities/__tests__/evidence-fixture";

function noCodebaseEvidence() {
	return evidenceWith({
		releaseNotes: { codebaseUsable: false },
		codebase: { connected: false },
	});
}

function sendRow(status: string) {
	return {
		id: "send_example",
		projectId: "project_example",
		status,
		content: { highlights: [] },
	};
}

function runApprove() {
	return handlers.approve({
		input: {
			projectId: "project_example",
			organizationId: null,
			sendId: "send_example",
			removedHighlightIndexes: [],
		},
		context: {
			user: {
				id: "user_example",
				email: "dev@example.com",
				name: "Example User",
			},
		},
	}) as Promise<unknown>;
}

async function errorFrom(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (err) {
		return err as { code?: string; message?: string };
	}
	throw new Error("expected the handler to throw");
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.gatherCapabilityEvidence.mockResolvedValue(healthyEvidence());
	mocks.findUnique.mockResolvedValue({
		id: "project_example",
		name: "Example Project",
		organizationId: null,
	});
	mocks.getNewsletterSendForSendPhase.mockResolvedValue(
		sendRow("PENDING_APPROVAL"),
	);
	mocks.approveNewsletterSend.mockResolvedValue({ approved: true });
	mocks.isTemporalAvailable.mockResolvedValue(true);
	mocks.workflowStart.mockResolvedValue({ workflowId: "approved_example" });
});

describe("approveSendProcedure — the capability door", () => {
	it("refuses with PRECONDITION_FAILED naming the repository it needs", async () => {
		mocks.gatherCapabilityEvidence.mockResolvedValue(noCodebaseEvidence());

		const err = await errorFrom(runApprove());

		expect(err.code).toBe("PRECONDITION_FAILED");
		expect(err.message).toContain("a connected repository");
	});

	it("refuses before the row is transitioned or anything is dispatched", async () => {
		// Before the point of no return: the APPROVED transition is never
		// rolled back, so a refusal after it would strand the send.
		mocks.gatherCapabilityEvidence.mockResolvedValue(noCodebaseEvidence());

		await errorFrom(runApprove());

		expect(mocks.approveNewsletterSend).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("proceeds when the codebase is usable", async () => {
		await expect(runApprove()).resolves.toMatchObject({
			approved: true,
			outcome: "approved",
		});
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
	});

	it("still gives an already-sent row its neutral notice, not a refusal", async () => {
		// The #2172 placement proof. A stale row is the normal case here, and a
		// gate in front of the status classification would turn every one of
		// them into a red error the moment a prerequisite lapsed.
		mocks.getNewsletterSendForSendPhase.mockResolvedValue(sendRow("SENT"));
		mocks.gatherCapabilityEvidence.mockResolvedValue(noCodebaseEvidence());

		await expect(runApprove()).resolves.toMatchObject({
			approved: true,
			outcome: "already_resolved",
		});
		expect(mocks.gatherCapabilityEvidence).not.toHaveBeenCalled();
	});

	it("leaves the APPROVED re-kick ungated so a stranded row can recover", async () => {
		// Nothing is generated on this path — the content is frozen and the
		// workflow only delivers it. Refusing here would make the recovery
		// impossible for exactly the rows that need it.
		mocks.getNewsletterSendForSendPhase.mockResolvedValue(
			sendRow("APPROVED"),
		);
		mocks.gatherCapabilityEvidence.mockResolvedValue(noCodebaseEvidence());

		await expect(runApprove()).resolves.toMatchObject({
			approved: true,
			outcome: "already_resolved",
		});
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		expect(mocks.gatherCapabilityEvidence).not.toHaveBeenCalled();
	});

	it("is inert with the flag off — no evidence read, no refusal", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);
		mocks.gatherCapabilityEvidence.mockResolvedValue(noCodebaseEvidence());

		await expect(runApprove()).resolves.toMatchObject({
			outcome: "approved",
		});
		expect(mocks.gatherCapabilityEvidence).not.toHaveBeenCalled();
	});
});
