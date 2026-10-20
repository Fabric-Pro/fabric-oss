/**
 * Opting a personal key in or out of serving the member's own work while
 * their ChatGPT plans are spent (Fizzy #3085). The procedure takes no
 * organization and finds the row by the session's user, so no input can
 * reach another member's key; an EMBEDDINGS_ONLY key cannot be opted in.
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, inputSchema } = vi.hoisted(() => ({
	mockDb: {
		userCloudProviderConfig: { findFirst: vi.fn(), update: vi.fn() },
	},
	inputSchema: { current: null as unknown },
}));

vi.mock("@repo/database", () => ({ db: mockDb }));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: (schema: unknown) => {
			inputSchema.current = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chainable,
		requirePermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_, prop: string) => prop.toLowerCase() },
		),
	};
});

import { setPlanSpentFallbackProcedure } from "../set-plan-spent-fallback";

const setFallback = setPlanSpentFallbackProcedure as unknown as {
	_handler: (args: {
		input: { provider: string; useWhenPlanSpent: boolean };
		context: unknown;
	}) => Promise<{ useWhenPlanSpent: boolean }>;
};

const context = {
	user: { id: "user-1" },
	session: { id: "s1", activeOrganizationId: "org-1" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mockDb.userCloudProviderConfig.findFirst.mockResolvedValue({
		id: "cfg-1",
		purpose: "ALL",
	});
	mockDb.userCloudProviderConfig.update.mockImplementation(
		async ({ data }: { data: { useWhenPlanSpent: boolean } }) => ({
			useWhenPlanSpent: data.useWhenPlanSpent,
		}),
	);
});

describe("setPlanSpentFallbackProcedure", () => {
	it("opts the caller's own key in, touching updatedAt", async () => {
		await expect(
			setFallback._handler({
				input: { provider: "OPENAI_DIRECT", useWhenPlanSpent: true },
				context,
			}),
		).resolves.toEqual({ useWhenPlanSpent: true });

		expect(mockDb.userCloudProviderConfig.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { userId: "user-1", provider: "OPENAI_DIRECT" },
			}),
		);
		expect(mockDb.userCloudProviderConfig.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "cfg-1" },
				data: { useWhenPlanSpent: true, updatedAt: expect.any(Date) },
			}),
		);
	});

	it("opts it out", async () => {
		await expect(
			setFallback._handler({
				input: { provider: "OPENAI_DIRECT", useWhenPlanSpent: false },
				context,
			}),
		).resolves.toEqual({ useWhenPlanSpent: false });
	});

	it("refuses to opt an embeddings-only key in", async () => {
		mockDb.userCloudProviderConfig.findFirst.mockResolvedValue({
			id: "cfg-1",
			purpose: "EMBEDDINGS_ONLY",
		});
		const error = await setFallback
			._handler({
				input: { provider: "OPENAI_DIRECT", useWhenPlanSpent: true },
				context,
			})
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("BAD_REQUEST");
		expect(mockDb.userCloudProviderConfig.update).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND when the caller has no key for the provider", async () => {
		mockDb.userCloudProviderConfig.findFirst.mockResolvedValue(null);
		const error = await setFallback
			._handler({
				input: { provider: "OPENAI_DIRECT", useWhenPlanSpent: true },
				context,
			})
			.catch((caught: unknown) => caught);
		expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
	});

	it("takes no organization or user from its input", () => {
		const shape = (
			inputSchema.current as { shape: Record<string, unknown> }
		).shape;
		expect(Object.keys(shape).sort()).toEqual([
			"provider",
			"useWhenPlanSpent",
		]);
	});
});
