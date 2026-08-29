/**
 * Regression test for the Daily Brief `regenerate` procedure's response shape
 * (Fizzy 1869 follow-up, Task 7). After extracting
 * `requestDailyBriefRegeneration` into `../lib/request-regeneration`, the
 * procedure must reconstruct its EXISTING response byte-for-byte:
 * `{ briefId, workflowId, inFlight }`. This test snapshots that mapping for the
 * `started` and `in_flight` paths (plus the null-workflowId and the
 * rate_limited / unavailable / not-found branches) so a future refactor of the
 * helper can never silently change the endpoint contract.
 *
 * Fully offline — mirrors the harness in
 * newsletter/procedures/__tests__/sends-approve.test.ts: `@repo/database`, the
 * regeneration helper, and `../../../../orpc/procedures` are mocked, and the
 * procedure's `.handler` is invoked directly via the chainable-proxy `_handler`.
 *
 * Run with: pnpm --filter @repo/api test regenerate
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { mockProjectFindUnique, mockRequestRegeneration } = vi.hoisted(() => ({
	mockProjectFindUnique: vi.fn(),
	mockRequestRegeneration: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mockProjectFindUnique },
	},
	// Real values — regenerate.ts calls
	// `timeWindowKindSchema.default(DEFAULT_DAILY_BRIEF_WINDOW)` at module-load
	// time when building its input schema, so these need to be real.
	DEFAULT_DAILY_BRIEF_WINDOW: "LAST_7D",
	timeWindowKindSchema: z.enum(["LAST_24H", "LAST_7D", "LAST_2W", "CUSTOM"]),
}));

vi.mock("../../lib/request-regeneration", () => ({
	requestDailyBriefRegeneration: mockRequestRegeneration,
}));

vi.mock("../../../../orpc/procedures", () => {
	// biome-ignore lint/suspicious/noExplicitAny: minimal chainable test double
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

import { regenerateProcedure } from "../regenerate";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const regenerate = (regenerateProcedure as unknown as { _handler: Handler })
	._handler;

const orgContext = {
	user: { id: "user-1", email: "u@example.com", name: "User" },
	session: { activeOrganizationId: "org-9" },
};

const project = {
	id: "p1",
	organizationId: "org-9",
	userId: "owner-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	mockProjectFindUnique.mockResolvedValue(project);
});

describe("dailyBrief.regenerate response shape", () => {
	it("started -> { briefId, workflowId, inFlight: false } (unchanged contract)", async () => {
		mockRequestRegeneration.mockResolvedValue({
			status: "started",
			brief: { id: "brief-1", temporalWorkflowId: "daily-brief-brief-1" },
			workflowId: "daily-brief-brief-1",
		});

		const result = await regenerate({
			input: { projectId: "p1", organizationId: "org-9" },
			context: orgContext,
		});

		expect(result).toEqual({
			briefId: "brief-1",
			workflowId: "daily-brief-brief-1",
			inFlight: false,
		});
	});

	it("in_flight -> { briefId, workflowId, inFlight: true } (unchanged contract)", async () => {
		mockRequestRegeneration.mockResolvedValue({
			status: "in_flight",
			brief: { id: "brief-2", temporalWorkflowId: "daily-brief-brief-2" },
		});

		const result = await regenerate({
			input: { projectId: "p1", organizationId: "org-9" },
			context: orgContext,
		});

		expect(result).toEqual({
			briefId: "brief-2",
			workflowId: "daily-brief-brief-2",
			inFlight: true,
		});
	});

	it("in_flight with a not-yet-recorded workflow id -> workflowId: null (unchanged contract)", async () => {
		mockRequestRegeneration.mockResolvedValue({
			status: "in_flight",
			brief: { id: "brief-3", temporalWorkflowId: null },
		});

		const result = await regenerate({
			input: { projectId: "p1", organizationId: "org-9" },
			context: orgContext,
		});

		expect(result).toEqual({
			briefId: "brief-3",
			workflowId: null,
			inFlight: true,
		});
	});

	it("passes the authorized project + acting user through, WITHOUT force (normal rate-limited path)", async () => {
		mockRequestRegeneration.mockResolvedValue({
			status: "started",
			brief: { id: "brief-1", temporalWorkflowId: "daily-brief-brief-1" },
			workflowId: "daily-brief-brief-1",
		});

		await regenerate({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				timeWindow: "LAST_24H",
			},
			context: orgContext,
		});

		expect(mockRequestRegeneration).toHaveBeenCalledWith({
			projectId: "p1",
			project: { organizationId: "org-9", userId: "owner-1" },
			triggeredByUserId: "user-1",
			timeWindow: "LAST_24H",
		});
		// The user-facing endpoint must NEVER force past the rate limit.
		expect(mockRequestRegeneration.mock.calls[0][0]).not.toHaveProperty(
			"force",
		);
	});

	it("rate_limited -> TOO_MANY_REQUESTS", async () => {
		mockRequestRegeneration.mockResolvedValue({ status: "rate_limited" });

		const error = await regenerate({
			input: { projectId: "p1", organizationId: "org-9" },
			context: orgContext,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe(
			"TOO_MANY_REQUESTS",
		);
	});

	it("unavailable -> SERVICE_UNAVAILABLE", async () => {
		mockRequestRegeneration.mockResolvedValue({ status: "unavailable" });

		const error = await regenerate({
			input: { projectId: "p1", organizationId: "org-9" },
			context: orgContext,
		}).catch((e: unknown) => e);

		expect((error as ORPCError<string, unknown>).code).toBe(
			"SERVICE_UNAVAILABLE",
		);
	});

	it("project not found -> NOT_FOUND before the helper is called", async () => {
		mockProjectFindUnique.mockResolvedValue(null);

		const error = await regenerate({
			input: { projectId: "other-tenant", organizationId: "org-9" },
			context: orgContext,
		}).catch((e: unknown) => e);

		expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
		expect(mockRequestRegeneration).not.toHaveBeenCalled();
	});
});
