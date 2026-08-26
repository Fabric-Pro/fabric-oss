/**
 * Tests for `acceptInvitationProcedure`: the idempotent accept paths resolve
 * with `{ member }` (no error surfaces when signup/sign-in invite
 * reconciliation already created the membership), while genuinely invalid
 * invitations keep mapping to `ORPCError("NOT_FOUND")`.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlerList } = vi.hoisted(() => ({
	handlerList: [] as Array<(...args: unknown[]) => unknown>,
}));

const mockAcceptProjectInvitation = vi.fn();

vi.mock("@repo/database", () => ({
	acceptProjectInvitation: (...a: unknown[]) =>
		mockAcceptProjectInvitation(...a),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlerList.push(fn);
			return { _handler: fn };
		},
	});
	return {
		protectedProcedure: chainable,
	};
});

// Importing the module registers its handler in `handlerList`.
import "../accept-invitation";

type AcceptHandler = (args: {
	input: { invitationId: string };
	context: { user: { id: string; email: string } };
}) => Promise<{ member: unknown }>;

const handler = handlerList[0] as AcceptHandler;

const context = {
	user: { id: "user-1", email: "invitee@example.com" },
};

const existingMember = {
	id: "pm-1",
	projectId: "proj-1",
	userId: "user-1",
	role: "EDITOR",
	invitedBy: "user-0",
	acceptedAt: new Date("2026-06-01T12:00:00.000Z"),
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("acceptInvitationProcedure", () => {
	it("returns { member } when the accept resolves (idempotent already-accepted-by-member path)", async () => {
		// The DB layer resolves with the existing member when reconciliation
		// already consumed the invitation — the procedure must surface that
		// as plain success, not an error.
		mockAcceptProjectInvitation.mockResolvedValue(existingMember);

		const result = await handler({
			input: { invitationId: "inv-1" },
			context,
		});

		expect(result).toEqual({ member: existingMember });
		expect(mockAcceptProjectInvitation).toHaveBeenCalledTimes(1);
		expect(mockAcceptProjectInvitation).toHaveBeenCalledWith(
			"inv-1",
			"user-1",
			"invitee@example.com",
		);
	});

	it("maps a genuinely invalid invitation to ORPCError NOT_FOUND", async () => {
		mockAcceptProjectInvitation.mockRejectedValue(
			new Error(
				"Invitation not found, expired, or issued to a different email",
			),
		);

		let thrown: unknown;
		try {
			await handler({ input: { invitationId: "inv-bad" }, context });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ORPCError);
		expect((thrown as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
		expect((thrown as ORPCError<string, unknown>).message).toBe(
			"Invitation not found or expired",
		);
	});
});
