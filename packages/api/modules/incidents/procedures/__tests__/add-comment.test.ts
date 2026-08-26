/**
 * Tests for addCommentProcedure (error-rate incident).
 *
 * Covers:
 *   - happy path: writes event with actor user id
 *   - NOT_FOUND when the incident does not exist
 *   - validation: empty message rejected via Zod (covered at integration; we
 *     verify the handler does not call addComment when the incident is gone)
 */
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetById, mockAddComment } = vi.hoisted(() => ({
	mockGetById: vi.fn(),
	mockAddComment: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getErrorRateIncidentById: (...args: unknown[]) => mockGetById(...args),
	addErrorRateIncidentComment: (...args: unknown[]) =>
		mockAddComment(...args),
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

const adminCtx = { user: { id: "admin-2", role: "admin" } };

async function loadHandler() {
	const mod = await import("../add-comment");
	return (mod.addCommentProcedure as any)._handler as (args: {
		input: { id: string; message: string };
		context: typeof adminCtx;
	}) => Promise<{ event: unknown }>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
});

describe("addCommentProcedure (error-rate)", () => {
	it("writes a comment with the actor user id", async () => {
		mockGetById.mockResolvedValue({ id: "inc-1" });
		mockAddComment.mockResolvedValue({ id: "ev-1", eventType: "COMMENT" });

		const handler = await loadHandler();
		const result = await handler({
			input: { id: "inc-1", message: "investigating" },
			context: adminCtx,
		});

		expect(mockAddComment).toHaveBeenCalledWith({
			incidentId: "inc-1",
			actorUserId: "admin-2",
			message: "investigating",
		});
		expect(result.event).toMatchObject({ eventType: "COMMENT" });
	});

	it("throws NOT_FOUND when the incident is missing — no comment is written", async () => {
		mockGetById.mockResolvedValue(null);
		const handler = await loadHandler();
		await expect(
			handler({
				input: { id: "ghost", message: "hi" },
				context: adminCtx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockAddComment).not.toHaveBeenCalled();
	});
});
