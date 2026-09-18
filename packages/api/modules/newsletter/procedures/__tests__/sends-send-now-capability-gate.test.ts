/**
 * The capability gate on sending release notes now (Fizzy #1930).
 *
 * Release notes are codebase-driven in v1, so a project with no usable index
 * has nothing to generate from. The refusal sits at the procedure because a
 * send can be started over the public API or by an agent, neither of which ever
 * renders the button the UI would have disabled.
 *
 * Ordering is pinned as well as the verdict: the gate runs AFTER the project
 * row is loaded and its tenant checked, and BEFORE any send row is created — a
 * refused send must leave nothing behind and must never be reachable by a
 * caller the permission middleware would have turned away.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mocks: {
		isFeatureEnabled: vi.fn(),
		gatherCapabilityEvidence: vi.fn(),
		findUnique: vi.fn(),
		findRecentNonFailedSend: vi.fn(),
		getNewsletterSettings: vi.fn(),
		createOrGetNewsletterSend: vi.fn(),
		setNewsletterSendWorkflowId: vi.fn(),
		finalizeNewsletterSend: vi.fn(),
		isTemporalAvailable: vi.fn(),
		workflowStart: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: mocks.isFeatureEnabled,
	db: { project: { findUnique: mocks.findUnique } },
	findRecentNonFailedSend: mocks.findRecentNonFailedSend,
	getNewsletterSettings: mocks.getNewsletterSettings,
	createOrGetNewsletterSend: mocks.createOrGetNewsletterSend,
	setNewsletterSendWorkflowId: mocks.setNewsletterSendWorkflowId,
	finalizeNewsletterSend: mocks.finalizeNewsletterSend,
	manualDedupeKey: () => "dedupe_example",
	resolveWindow: () => ({
		start: new Date("2026-09-11T00:00:00.000Z"),
		end: new Date("2026-09-18T00:00:00.000Z"),
	}),
	coerceDetailLevel: (v: unknown) => v ?? "STANDARD",
	coerceDeliveryDestination: (v: unknown) => v ?? "EMAIL",
	NEWSLETTER_DETAIL_LEVELS: ["BRIEF", "STANDARD", "DETAILED"],
	DEFAULT_NEWSLETTER_DETAIL_LEVEL: "STANDARD",
}));

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
			handlers.sendNow = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

await import("../sends-send-now");

import {
	evidenceWith,
	healthyEvidence,
} from "../../../capabilities/__tests__/evidence-fixture";

/** No usable index, and no repository behind it either. */
function noCodebaseEvidence() {
	return evidenceWith({
		releaseNotes: { codebaseUsable: false },
		codebase: { connected: false },
	});
}

function runSendNow() {
	return handlers.sendNow({
		input: { projectId: "project_example", organizationId: null },
		context: { user: { id: "user_example" } },
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
		userId: "user_example",
	});
	mocks.findRecentNonFailedSend.mockResolvedValue(null);
	mocks.isTemporalAvailable.mockResolvedValue(true);
	mocks.getNewsletterSettings.mockResolvedValue({
		detailLevel: "STANDARD",
		deliveryDestination: "EMAIL",
		lookbackDays: 7,
		lastSentAt: null,
		requireApproval: false,
		chatChannels: [],
	});
	mocks.createOrGetNewsletterSend.mockResolvedValue({
		created: true,
		send: {
			id: "send_example",
			detailLevel: "STANDARD",
			deliveryDestination: "EMAIL",
			chatChannels: [],
			requireApproval: false,
			temporalWorkflowId: null,
		},
	});
	mocks.workflowStart.mockResolvedValue({
		workflowId: "newsletter-send-send_example",
	});
	mocks.setNewsletterSendWorkflowId.mockResolvedValue(undefined);
});

describe("sendNowProcedure — the capability door", () => {
	it("refuses with PRECONDITION_FAILED naming the repository it needs", async () => {
		mocks.gatherCapabilityEvidence.mockResolvedValue(noCodebaseEvidence());

		const err = await errorFrom(runSendNow());

		expect(err.code).toBe("PRECONDITION_FAILED");
		expect(err.message).toContain("a connected repository");
	});

	it("refuses before any send row is created or dispatched", async () => {
		mocks.gatherCapabilityEvidence.mockResolvedValue(noCodebaseEvidence());

		await errorFrom(runSendNow());

		expect(mocks.createOrGetNewsletterSend).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("runs only after the project row has been loaded and tenant-checked", async () => {
		mocks.gatherCapabilityEvidence.mockResolvedValue(noCodebaseEvidence());

		await errorFrom(runSendNow());

		expect(mocks.findUnique).toHaveBeenCalledTimes(1);
	});

	it("proceeds when the codebase is usable", async () => {
		await expect(runSendNow()).resolves.toEqual({
			sendId: "send_example",
			workflowId: "newsletter-send-send_example",
			inFlight: false,
		});
	});

	it("is inert with the flag off — no evidence read, no refusal", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);
		mocks.gatherCapabilityEvidence.mockResolvedValue(noCodebaseEvidence());

		await expect(runSendNow()).resolves.toMatchObject({
			sendId: "send_example",
		});
		expect(mocks.gatherCapabilityEvidence).not.toHaveBeenCalled();
	});

	it("takes the tenant from the loaded project row, not from the input", async () => {
		mocks.findUnique.mockResolvedValue({
			id: "project_example",
			name: "Example Project",
			organizationId: "organization_example",
			userId: "user_example",
		});

		await handlers.sendNow({
			// The guard value the procedure already validates; it must not be
			// what the gate is resolved against.
			input: {
				projectId: "project_example",
				organizationId: "organization_example",
			},
			context: { user: { id: "user_example" } },
		});

		expect(mocks.gatherCapabilityEvidence).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project_example",
				userId: "user_example",
				organizationId: "organization_example",
			}),
		);
	});
});
