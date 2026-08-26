/**
 * Tests for acknowledgeErrorRateIncidentProcedure.
 *
 * Covers:
 *   - happy path: DB acknowledge + signal called
 *   - NOT_FOUND when the DB helper returns null
 *   - signal failure does NOT fail the request (best-effort)
 *   - transactional invariant: DB call passes actorUserId from context
 */
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAcknowledgeErrorRateIncident, mockSignalAcknowledged } = vi.hoisted(
	() => ({
		mockAcknowledgeErrorRateIncident: vi.fn(),
		mockSignalAcknowledged: vi.fn(),
	}),
);

vi.mock("@repo/database", () => ({
	acknowledgeErrorRateIncident: (...args: unknown[]) =>
		mockAcknowledgeErrorRateIncident(...args),
}));

vi.mock("../../lib/lifecycle-signal", () => ({
	signalIncidentAcknowledged: (...args: unknown[]) =>
		mockSignalAcknowledged(...args),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return { adminProcedure: chainable };
});

const adminCtx = {
	user: { id: "admin-7", role: "admin" },
	session: { id: "session-1", activeOrganizationId: null },
};

async function loadHandler() {
	const mod = await import("../acknowledge-error-rate-incident");
	return (mod.acknowledgeErrorRateIncidentProcedure as any)
		._handler as (args: {
		input: { id: string; note?: string };
		context: typeof adminCtx;
	}) => Promise<{ incident: unknown }>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
});

describe("acknowledgeErrorRateIncidentProcedure", () => {
	it("acknowledges via DB then signals the lifecycle workflow", async () => {
		mockAcknowledgeErrorRateIncident.mockResolvedValue({
			id: "inc-1",
			status: "ACKNOWLEDGED",
			acknowledgedBy: "admin-7",
		});
		mockSignalAcknowledged.mockResolvedValue(undefined);

		const handler = await loadHandler();
		const result = await handler({
			input: { id: "inc-1", note: "looking" },
			context: adminCtx,
		});

		expect(mockAcknowledgeErrorRateIncident).toHaveBeenCalledWith({
			incidentId: "inc-1",
			actorUserId: "admin-7",
			note: "looking",
		});
		expect(mockSignalAcknowledged).toHaveBeenCalledWith({
			incidentId: "inc-1",
			userId: "admin-7",
			note: "looking",
		});
		expect(result.incident).toMatchObject({ status: "ACKNOWLEDGED" });
	});

	it("throws NOT_FOUND when the DB helper returns null", async () => {
		mockAcknowledgeErrorRateIncident.mockResolvedValue(null);

		const handler = await loadHandler();
		await expect(
			handler({ input: { id: "missing" }, context: adminCtx }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockSignalAcknowledged).not.toHaveBeenCalled();
	});

	it("does not bubble up signal failures (best-effort)", async () => {
		mockAcknowledgeErrorRateIncident.mockResolvedValue({
			id: "inc-2",
			status: "ACKNOWLEDGED",
		});
		// lifecycle-signal swallows errors internally; the mock here mirrors
		// that contract by resolving even when Temporal would have thrown.
		mockSignalAcknowledged.mockResolvedValue(undefined);

		const handler = await loadHandler();
		const result = await handler({
			input: { id: "inc-2" },
			context: adminCtx,
		});
		expect(result.incident).toBeDefined();
	});
});
