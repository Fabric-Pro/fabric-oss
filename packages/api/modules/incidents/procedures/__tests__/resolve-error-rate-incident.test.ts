/**
 * Tests for resolveErrorRateIncidentProcedure.
 *
 * Covers:
 *   - happy path: DB resolve + signal called
 *   - NOT_FOUND when the DB helper returns null
 *   - signal reason defaults to "MANUAL_RESOLVED" when note is unset
 */
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolve, mockSignalResolved } = vi.hoisted(() => ({
	mockResolve: vi.fn(),
	mockSignalResolved: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	resolveErrorRateIncident: (...args: unknown[]) => mockResolve(...args),
}));

vi.mock("../../lib/lifecycle-signal", () => ({
	signalIncidentResolved: (...args: unknown[]) => mockSignalResolved(...args),
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

const adminCtx = { user: { id: "admin-3", role: "admin" } };

async function loadHandler() {
	const mod = await import("../resolve-error-rate-incident");
	return (mod.resolveErrorRateIncidentProcedure as any)._handler as (args: {
		input: { id: string; note?: string };
		context: typeof adminCtx;
	}) => Promise<{ incident: unknown }>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
});

describe("resolveErrorRateIncidentProcedure", () => {
	it("resolves the DB row and signals with the supplied note", async () => {
		mockResolve.mockResolvedValue({ id: "inc-1", status: "RESOLVED" });
		const handler = await loadHandler();
		await handler({
			input: { id: "inc-1", note: "false alarm" },
			context: adminCtx,
		});
		expect(mockResolve).toHaveBeenCalledWith({
			incidentId: "inc-1",
			actorUserId: "admin-3",
			note: "false alarm",
		});
		expect(mockSignalResolved).toHaveBeenCalledWith({
			incidentId: "inc-1",
			userId: "admin-3",
			reason: "false alarm",
		});
	});

	it("defaults signal reason to MANUAL_RESOLVED when no note is provided", async () => {
		mockResolve.mockResolvedValue({ id: "inc-2", status: "RESOLVED" });
		const handler = await loadHandler();
		await handler({ input: { id: "inc-2" }, context: adminCtx });
		expect(mockSignalResolved).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "MANUAL_RESOLVED" }),
		);
	});

	it("throws NOT_FOUND when the DB row is missing", async () => {
		mockResolve.mockResolvedValue(null);
		const handler = await loadHandler();
		await expect(
			handler({ input: { id: "ghost" }, context: adminCtx }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockSignalResolved).not.toHaveBeenCalled();
	});
});
