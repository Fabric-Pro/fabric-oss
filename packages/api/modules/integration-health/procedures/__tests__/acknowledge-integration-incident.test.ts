/**
 * Tests for acknowledgeIntegrationIncidentProcedure.
 *
 * Mirrors the error-rate acknowledge tests, but against the integration
 * incident DB helper + signal helper.
 */
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockAck, mockSignal } = vi.hoisted(() => ({
	mockAck: vi.fn(),
	mockSignal: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	acknowledgeIntegrationIncident: (...args: unknown[]) => mockAck(...args),
}));

vi.mock("../../../incidents/lib/lifecycle-signal", () => ({
	signalIncidentAcknowledged: (...args: unknown[]) => mockSignal(...args),
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

const adminCtx = { user: { id: "admin-1", role: "admin" } };

async function loadHandler() {
	const mod = await import("../acknowledge-integration-incident");
	return (mod.acknowledgeIntegrationIncidentProcedure as any)
		._handler as (args: {
		input: { id: string; note?: string };
		context: typeof adminCtx;
	}) => Promise<{ incident: unknown }>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
});

describe("acknowledgeIntegrationIncidentProcedure", () => {
	it("acknowledges integration incident and signals lifecycle", async () => {
		mockAck.mockResolvedValue({ id: "ii-1", status: "ACKNOWLEDGED" });
		const handler = await loadHandler();
		const result = await handler({
			input: { id: "ii-1", note: "ack" },
			context: adminCtx,
		});
		expect(mockAck).toHaveBeenCalledWith({
			incidentId: "ii-1",
			actorUserId: "admin-1",
			note: "ack",
		});
		expect(mockSignal).toHaveBeenCalledWith({
			incidentId: "ii-1",
			userId: "admin-1",
			note: "ack",
		});
		expect(result.incident).toMatchObject({ status: "ACKNOWLEDGED" });
	});

	it("throws NOT_FOUND when the row is missing", async () => {
		mockAck.mockResolvedValue(null);
		const handler = await loadHandler();
		await expect(
			handler({ input: { id: "x" }, context: adminCtx }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockSignal).not.toHaveBeenCalled();
	});
});
