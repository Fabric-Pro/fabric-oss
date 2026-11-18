/**
 * Possible-duplicate flags for the whole Proposal Inbox of a project: read
 * access to the project is required, and every failure or the request
 * deadline degrades to an error result with no flags instead of throwing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, uses, mocks } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	uses: [] as unknown[],
	mocks: {
		getTenant: vi.fn(),
		hasAccess: vi.fn(),
		detect: vi.fn(),
		rateLimit: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	getProjectTenantId: mocks.getTenant,
	hasProjectAccess: mocks.hasAccess,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../../../lib/rate-limit", () => ({
	RATE_LIMIT_PRESETS: { ai: { limit: 20 } },
}));

vi.mock("../../../lib/proposal-duplicate-matching", () => ({
	detectInboxDuplicates: mocks.detect,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: (...args: unknown[]) => {
			uses.push(...args);
			return chainable;
		},
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.flags = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_READ: "project:read" },
		requireProjectPermission: (permission: string) => {
			uses.push({ requireProjectPermission: permission });
			return (c: unknown) => c;
		},
		enforceAiRateLimit: mocks.rateLimit,
	};
});

await import("../proposal-duplicate-flags");

const FLAG = {
	proposalId: "prop-1",
	changeIndex: 0,
	matches: [
		{
			kind: "story",
			storyId: "story-1",
			identifier: "F-12",
			title: "Export throttling",
			similarity: 0.91,
		},
	],
};

const call = () =>
	handlers.flags({
		input: { projectId: "project-1", organizationId: null },
		context: { user: { id: "user-1" } },
	});

async function errorFrom(promise: unknown) {
	try {
		await promise;
	} catch (error) {
		return error as { code?: string };
	}
	throw new Error("expected the handler to throw");
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getTenant.mockResolvedValue({ organizationId: "org-1" });
	mocks.hasAccess.mockResolvedValue(true);
	mocks.detect.mockResolvedValue([FLAG]);
	delete process.env.DUPLICATE_CHECK_TIMEOUT_MS;
});

describe("proposalDuplicateFlagsProcedure — access", () => {
	it("needs read permission and is rate-limited like the other AI checks", () => {
		expect(uses).toContainEqual({
			requireProjectPermission: "project:read",
		});
		expect(uses.some((use) => typeof use === "function")).toBe(true);
	});

	it("refuses a caller without access to the project", async () => {
		mocks.hasAccess.mockResolvedValue(false);

		expect((await errorFrom(call())).code).toBe("FORBIDDEN");
		expect(mocks.detect).not.toHaveBeenCalled();
	});

	it("refuses a project with no tenant row", async () => {
		mocks.getTenant.mockResolvedValue(null);

		expect((await errorFrom(call())).code).toBe("FORBIDDEN");
		expect(mocks.detect).not.toHaveBeenCalled();
	});
});

describe("proposalDuplicateFlagsProcedure — results", () => {
	it("returns the whole inbox's flags in one call, with the tenant taken from the project", async () => {
		await expect(call()).resolves.toEqual({ flags: [FLAG] });
		expect(mocks.detect).toHaveBeenCalledTimes(1);
		expect(mocks.detect).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project-1",
				userId: "user-1",
				organizationId: "org-1",
				maxStaleEmbeds: 200,
				abortSignal: expect.any(AbortSignal),
				judgeSignal: expect.any(AbortSignal),
			}),
		);
		const [args] = mocks.detect.mock.calls[0] ?? [];
		expect(args?.judgeSignal).not.toBe(args?.abortSignal);
	});

	it("returns an error result, never throwing, when the check fails", async () => {
		mocks.detect.mockRejectedValue(new Error("embedding outage"));

		const result = (await call()) as { flags: unknown[]; error?: string };

		expect(result.flags).toEqual([]);
		expect(result.error).toBeTruthy();
	});

	it("returns an error result within the request deadline", async () => {
		process.env.DUPLICATE_CHECK_TIMEOUT_MS = "20";
		mocks.detect.mockImplementation(() => new Promise(() => {}));

		const startedAt = Date.now();
		const result = (await call()) as { flags: unknown[]; error?: string };

		expect(Date.now() - startedAt).toBeLessThan(2_000);
		expect(result.flags).toEqual([]);
		expect(result.error).toBeTruthy();
	});
});
