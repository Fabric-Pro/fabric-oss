/**
 * Tests for the retryGeneration procedure.
 *
 * Pinned contract:
 *   - FAILED-only: any other status throws BAD_REQUEST naming the current
 *     status, with no writes.
 *   - Tenant-XOR lookup: org context filters by organizationId, personal
 *     context by organizationId: null; a miss throws NOT_FOUND.
 *   - Planner preflight runs before any write — an unreachable planner
 *     leaves the plan FAILED (still retryable).
 *   - On success: status reset to DRAFT + "Retrying plan generation..." and
 *     the shared continuation is scheduled with `isRevision: false`.
 *   - Message reconstruction: feature-linked plans rebuild the
 *     create-from-feature shape from the story; standalone plans seed from
 *     the plan name.
 */
import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockHasProjectAccess,
	mockAssertProjectPermission,
	mockPlanFindFirst,
	mockPlanUpdate,
	mockRunInBackground,
	mockRunPatternGeneration,
	mockFetch,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockAssertProjectPermission: vi.fn(),
	mockPlanFindFirst: vi.fn(),
	mockPlanUpdate: vi.fn(),
	mockRunInBackground: vi.fn(),
	mockRunPatternGeneration: vi.fn(),
	mockFetch: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		weavePlan: {
			findFirst: mockPlanFindFirst,
			update: mockPlanUpdate,
		},
	},
	hasProjectAccess: mockHasProjectAccess,
}));

vi.mock("../../lib/run-in-background", () => ({
	runInBackground: mockRunInBackground,
}));

vi.mock("../../lib/run-pattern-generation", () => ({
	runPatternGeneration: mockRunPatternGeneration,
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
	return {
		protectedProcedure: chainable,
		assertProjectPermission: mockAssertProjectPermission,
		requirePermission: () => () => undefined,
		requireProjectPermission: () => () => undefined,
		Permissions: new Proxy({}, { get: (_target, prop) => String(prop) }),
		resolveOrganizationIdForCaller: async (
			inputOrganizationId: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => {
			// Mirrors the resolution half only. The membership half it adds is
			// covered directly in the orpc procedure tests; these suites are
			// about weave's own behaviour, and a caller who is not a member
			// never reaches them.
			if (inputOrganizationId) {
				return inputOrganizationId;
			}
			if (inputOrganizationId === null) {
				return undefined;
			}
			return session.activeOrganizationId ?? undefined;
		},
		resolveOrganizationId: (
			inputOrganizationId: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => {
			if (inputOrganizationId) {
				return inputOrganizationId;
			}
			if (inputOrganizationId === null) {
				return undefined;
			}
			return session?.activeOrganizationId ?? undefined;
		},
	};
});

const context = {
	user: { id: "user-1" },
	session: { activeOrganizationId: null },
};

const failedPlan = {
	id: "plan-1",
	projectId: "proj-1",
	name: "My failed plan",
	description: "Plan generation failed: Pattern unavailable.",
	status: "FAILED",
	userStoryId: null,
	userStory: null,
	project: {
		name: "Demo Project",
		description: "Project description",
		techStack: ["TypeScript", "Next.js"],
	},
};

async function loadHandler() {
	const mod = await import("../retry-generation");
	return (mod.retryGenerationProcedure as any)._handler as (args: {
		input: { planId: string; organizationId?: string | null };
		context: typeof context;
	}) => Promise<{ success: boolean; planId: string; status: string }>;
}

let savedPlannersUrl: string | undefined;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	vi.stubGlobal("fetch", mockFetch);
	savedPlannersUrl = process.env.WEAVE_PLANNERS_URL;
	process.env.WEAVE_PLANNERS_URL = "http://planners.test:8142";
	mockHasProjectAccess.mockResolvedValue(true);
	mockAssertProjectPermission.mockResolvedValue(undefined);
	mockPlanFindFirst.mockResolvedValue(failedPlan);
	mockPlanUpdate.mockResolvedValue({});
	mockRunPatternGeneration.mockResolvedValue(undefined);
	mockFetch.mockResolvedValue({ ok: true, status: 200 });
	consoleErrorSpy = vi
		.spyOn(console, "error")
		.mockImplementation(() => undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
	consoleErrorSpy.mockRestore();
	if (savedPlannersUrl === undefined) {
		delete process.env.WEAVE_PLANNERS_URL;
	} else {
		process.env.WEAVE_PLANNERS_URL = savedPlannersUrl;
	}
});

describe("retryGenerationProcedure — guards", () => {
	it("throws NOT_FOUND when the tenant-XOR lookup misses", async () => {
		mockPlanFindFirst.mockResolvedValue(null);

		const handler = await loadHandler();
		const error = await handler({
			input: { planId: "plan-1", organizationId: "org-1" },
			context,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as { code: string }).code).toBe("NOT_FOUND");
		// Org context: lookup is scoped to the organization.
		expect(mockPlanFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "plan-1",
					userId: "user-1",
					organizationId: "org-1",
				},
			}),
		);
		expect(mockPlanUpdate).not.toHaveBeenCalled();
	});

	it("scopes the lookup to organizationId: null in personal context", async () => {
		mockPlanFindFirst.mockResolvedValue(null);

		const handler = await loadHandler();
		await handler({
			input: { planId: "plan-1", organizationId: null },
			context,
		}).catch(() => undefined);

		expect(mockPlanFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "plan-1",
					userId: "user-1",
					organizationId: null,
				},
			}),
		);
	});

	it("throws FORBIDDEN without project access", async () => {
		mockAssertProjectPermission.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "Missing required permission",
			}),
		);

		const handler = await loadHandler();
		const error = await handler({
			input: { planId: "plan-1", organizationId: "org-1" },
			context,
		}).catch((e: unknown) => e);

		expect((error as { code: string }).code).toBe("FORBIDDEN");
		expect(mockPlanUpdate).not.toHaveBeenCalled();
	});

	it("rejects non-FAILED plans with BAD_REQUEST and performs no writes", async () => {
		mockPlanFindFirst.mockResolvedValue({
			...failedPlan,
			status: "PENDING_APPROVAL",
		});

		const handler = await loadHandler();
		const error = await handler({
			input: { planId: "plan-1", organizationId: "org-1" },
			context,
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as { code: string }).code).toBe("BAD_REQUEST");
		expect((error as Error).message).toBe(
			"Only failed plans can be retried (current status: PENDING_APPROVAL).",
		);
		expect(mockPlanUpdate).not.toHaveBeenCalled();
		expect(mockRunInBackground).not.toHaveBeenCalled();
		// The status guard runs before the preflight — no probe either.
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("preflight failure ⇒ SERVICE_UNAVAILABLE and the plan is left untouched (still FAILED)", async () => {
		mockFetch.mockRejectedValue(new TypeError("fetch failed"));

		const handler = await loadHandler();
		const error = await handler({
			input: { planId: "plan-1", organizationId: "org-1" },
			context,
		}).catch((e: unknown) => e);

		expect((error as { code: string }).code).toBe("SERVICE_UNAVAILABLE");
		expect(mockPlanUpdate).not.toHaveBeenCalled();
		expect(mockRunInBackground).not.toHaveBeenCalled();
	});
});

describe("retryGenerationProcedure — FAILED plan retry", () => {
	it("preflights, resets to DRAFT with the retry description, and schedules the continuation", async () => {
		const handler = await loadHandler();
		const result = await handler({
			input: { planId: "plan-1", organizationId: "org-1" },
			context,
		});

		expect(mockFetch).toHaveBeenCalledExactlyOnceWith(
			"http://planners.test:8142/health",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);

		expect(mockPlanUpdate).toHaveBeenCalledExactlyOnceWith({
			where: { id: "plan-1" },
			data: {
				status: "DRAFT",
				description: "Retrying plan generation...",
			},
		});

		expect(mockRunInBackground).toHaveBeenCalledTimes(1);
		expect(mockRunPatternGeneration).toHaveBeenCalledExactlyOnceWith({
			planId: "plan-1",
			patternUrl: "http://planners.test:8142",
			message: "Implement: My failed plan",
			userId: "user-1",
			organizationId: "org-1",
			projectContext: {
				projectId: "proj-1",
				projectName: "Demo Project",
				description: "Project description",
				techStack: "TypeScript, Next.js",
			},
			isRevision: false,
		});

		expect(result).toEqual({
			success: true,
			planId: "plan-1",
			status: "DRAFT",
		});
	});

	it("feature-linked plan rebuilds the create-from-feature message from the story", async () => {
		mockPlanFindFirst.mockResolvedValue({
			...failedPlan,
			userStoryId: "story-1",
			userStory: {
				title: "Add CSV export",
				description: "Users need to export the table as CSV.",
				acceptanceCriteria: "Given a table, when I click Export…",
			},
		});

		const handler = await loadHandler();
		await handler({
			input: { planId: "plan-1", organizationId: "org-1" },
			context,
		});

		expect(mockRunPatternGeneration).toHaveBeenCalledWith(
			expect.objectContaining({
				message:
					"Implement feature: Add CSV export\n\nUsers need to export the table as CSV.\n\nGiven a table, when I click Export…",
			}),
		);
	});

	it("omits absent story parts from the rebuilt message", async () => {
		mockPlanFindFirst.mockResolvedValue({
			...failedPlan,
			userStoryId: "story-1",
			userStory: {
				title: "Add CSV export",
				description: null,
				acceptanceCriteria: null,
			},
		});

		const handler = await loadHandler();
		await handler({
			input: { planId: "plan-1", organizationId: "org-1" },
			context,
		});

		expect(mockRunPatternGeneration).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Implement feature: Add CSV export",
			}),
		);
	});

	it("standalone plan (no linked story) seeds the message from the plan name", async () => {
		const handler = await loadHandler();
		await handler({
			input: { planId: "plan-1", organizationId: "org-1" },
			context,
		});

		expect(mockRunPatternGeneration).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Implement: My failed plan" }),
		);
	});
});
