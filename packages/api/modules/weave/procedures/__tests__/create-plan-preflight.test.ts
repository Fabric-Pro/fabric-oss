/**
 * Tests for the create-plan planner preflight.
 *
 * Pinned contract:
 *   - The planner `/health` gate runs BEFORE `db.weavePlan.create` — on any
 *     preflight failure (network error, abort, non-2xx, config missing in a
 *     deployed environment) the procedure throws SERVICE_UNAVAILABLE and no
 *     plan row is ever created (no orphaned "Generating plan…" state).
 *   - On a healthy preflight the row is created and the Pattern continuation
 *     is scheduled through the `run-in-background` wrapper with the resolved
 *     base URL (no localhost fallback in deployed environments).
 */
import { ORPCError } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockHasProjectAccess,
	mockAssertProjectPermission,
	mockProjectFindUnique,
	mockPlanCreate,
	mockRunInBackground,
	mockRunPatternGeneration,
	mockFetch,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockAssertProjectPermission: vi.fn(),
	mockProjectFindUnique: vi.fn(),
	mockPlanCreate: vi.fn(),
	mockRunInBackground: vi.fn(),
	mockRunPatternGeneration: vi.fn(),
	mockFetch: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mockProjectFindUnique },
		weavePlan: { create: mockPlanCreate },
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

const baseInput = {
	projectId: "proj-1",
	organizationId: "org-1",
	name: "My Plan",
	description: "Plan description",
	message: "Implement feature: Do the thing",
};

async function loadHandler() {
	const mod = await import("../create-plan");
	return (mod.createPlanProcedure as any)._handler as (args: {
		input: typeof baseInput & Record<string, unknown>;
		context: typeof context;
	}) => Promise<{ success: boolean; planId: string; status: string }>;
}

const ENV_KEYS = [
	"WEAVE_PLANNERS_URL",
	"VERCEL_ENV",
	"FABRIC_ENV",
	"NODE_ENV",
] as const;
let savedEnv: Record<string, string | undefined>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	vi.stubGlobal("fetch", mockFetch);
	savedEnv = {};
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
	}
	// Default: configured planner URL (deployed-style), healthy service.
	process.env.WEAVE_PLANNERS_URL = "http://planners.test:8142";
	mockHasProjectAccess.mockResolvedValue(true);
	mockAssertProjectPermission.mockResolvedValue(undefined);
	mockProjectFindUnique.mockResolvedValue({
		name: "Demo Project",
		description: "Project-level description",
		techStack: ["TypeScript", "Next.js"],
	});
	mockPlanCreate.mockResolvedValue({
		id: "plan-1",
		description: "Plan description",
	});
	mockRunPatternGeneration.mockResolvedValue(undefined);
	mockFetch.mockResolvedValue({ ok: true, status: 200 });
	consoleErrorSpy = vi
		.spyOn(console, "error")
		.mockImplementation(() => undefined);
});

afterEach(() => {
	vi.unstubAllGlobals();
	consoleErrorSpy.mockRestore();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = savedEnv[key];
		}
	}
});

async function expectServiceUnavailable(message?: string) {
	const handler = await loadHandler();
	const error = await handler({ input: baseInput, context }).catch(
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ORPCError);
	expect((error as ORPCError<string, unknown>).code).toBe(
		"SERVICE_UNAVAILABLE",
	);
	if (message) {
		expect((error as Error).message).toBe(message);
	}
	return error as Error;
}

describe("createPlanProcedure — preflight failures (no plan row created)", () => {
	it("network error ⇒ SERVICE_UNAVAILABLE and weavePlan.create not called", async () => {
		mockFetch.mockRejectedValue(new TypeError("fetch failed"));

		await expectServiceUnavailable(
			"The Weave planning service is unreachable. It may be starting up or misconfigured — try again shortly or contact your administrator.",
		);
		expect(mockPlanCreate).not.toHaveBeenCalled();
		expect(mockRunInBackground).not.toHaveBeenCalled();
	});

	it("abort/timeout ⇒ SERVICE_UNAVAILABLE and weavePlan.create not called", async () => {
		mockFetch.mockRejectedValue(
			Object.assign(new Error("This operation was aborted"), {
				name: "AbortError",
			}),
		);

		await expectServiceUnavailable(
			"The Weave planning service is unreachable. It may be starting up or misconfigured — try again shortly or contact your administrator.",
		);
		expect(mockPlanCreate).not.toHaveBeenCalled();
	});

	it("non-200 health response ⇒ SERVICE_UNAVAILABLE and weavePlan.create not called", async () => {
		mockFetch.mockResolvedValue({ ok: false, status: 503 });

		await expectServiceUnavailable(
			"The Weave planning service is unreachable. It may be starting up or misconfigured — try again shortly or contact your administrator.",
		);
		expect(mockPlanCreate).not.toHaveBeenCalled();
	});

	it("unset URL in a deployed environment ⇒ config error naming WEAVE_PLANNERS_URL, no fetch", async () => {
		delete process.env.WEAVE_PLANNERS_URL;
		process.env.VERCEL_ENV = "production";

		await expectServiceUnavailable(
			"The Weave planning service is not configured for this environment — set WEAVE_PLANNERS_URL.",
		);
		expect(mockFetch).not.toHaveBeenCalled();
		expect(mockPlanCreate).not.toHaveBeenCalled();
		expect(mockProjectFindUnique).not.toHaveBeenCalled();
	});
});

describe("createPlanProcedure — healthy preflight", () => {
	it("probes {url}/health, creates the row, and schedules the continuation", async () => {
		const handler = await loadHandler();
		const result = await handler({ input: baseInput, context });

		expect(mockFetch).toHaveBeenCalledExactlyOnceWith(
			"http://planners.test:8142/health",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);

		expect(mockPlanCreate).toHaveBeenCalledExactlyOnceWith({
			data: {
				projectId: "proj-1",
				userStoryId: undefined,
				storyTaskId: undefined,
				name: "My Plan",
				description: "Plan description",
				status: "DRAFT",
				checkboxes: [],
				userId: "user-1",
				organizationId: "org-1",
			},
		});

		// Continuation scheduled through the wrapper (not fire-and-forget),
		// with the preflight's resolved URL — never a localhost fallback.
		expect(mockRunInBackground).toHaveBeenCalledTimes(1);
		expect(mockRunPatternGeneration).toHaveBeenCalledExactlyOnceWith({
			planId: "plan-1",
			patternUrl: "http://planners.test:8142",
			message: baseInput.message,
			userId: "user-1",
			organizationId: "org-1",
			projectContext: {
				projectId: "proj-1",
				projectName: "Demo Project",
				description: "Plan description",
				techStack: "TypeScript, Next.js",
			},
			isRevision: false,
			priorDescription: "Plan description",
		});

		expect(result).toEqual({
			success: true,
			planId: "plan-1",
			status: "DRAFT",
		});
	});

	it("uses the local fallback when not deployed and the env var is unset", async () => {
		delete process.env.WEAVE_PLANNERS_URL;
		delete process.env.VERCEL_ENV;
		delete process.env.FABRIC_ENV;
		// Vitest runs with NODE_ENV=test — not a deployed environment.

		const handler = await loadHandler();
		await handler({ input: baseInput, context });

		expect(mockFetch).toHaveBeenCalledExactlyOnceWith(
			"http://localhost:8142/health",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(mockPlanCreate).toHaveBeenCalledTimes(1);
	});
});
