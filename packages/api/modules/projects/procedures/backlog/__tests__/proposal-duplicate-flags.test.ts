/**
 * Possible-duplicate flags for the whole Proposal Inbox of a project: read
 * access to the project is required, the result says how many items are
 * still to be checked, only a call that embeds counts against the AI rate
 * limit, and every other failure, the request deadline included, degrades
 * to an error result with no flags instead of throwing.
 */

import { ORPCError } from "@orpc/client";
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

/** A finished check: every item compared and every candidate verified. */
const CHECKED = {
	flags: [FLAG],
	stillChecking: 0,
	verifying: 0,
	checking: [],
};

const PATH = ["projects", "backlog", "proposals", "duplicateFlags"];

const call = () =>
	handlers.flags({
		input: { projectId: "project-1", organizationId: null },
		context: { user: { id: "user-1" } },
		path: PATH,
	});

/** A check that embeds: it asks `beforeEmbed` first. */
function embeddingCheck() {
	mocks.detect.mockImplementation(
		async ({ beforeEmbed }: { beforeEmbed: () => Promise<void> }) => {
			await beforeEmbed();
			return CHECKED;
		},
	);
}

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
	mocks.detect.mockResolvedValue(CHECKED);
	delete process.env.DUPLICATE_CHECK_TIMEOUT_MS;
});

describe("proposalDuplicateFlagsProcedure — access", () => {
	it("needs read permission", () => {
		expect(uses).toContainEqual({
			requireProjectPermission: "project:read",
		});
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

describe("proposalDuplicateFlagsProcedure — AI rate limit", () => {
	it("counts a call that embeds, like the other AI checks", async () => {
		embeddingCheck();
		mocks.rateLimit.mockResolvedValue(undefined);

		await expect(call()).resolves.toEqual(CHECKED);
		expect(mocks.rateLimit).toHaveBeenCalledWith("user-1", PATH, {
			limit: 20,
		});
	});

	it("does not count a call answered from the cache", async () => {
		await call();

		expect(mocks.rateLimit).not.toHaveBeenCalled();
	});

	it("throws the refusal when the limit is reached", async () => {
		embeddingCheck();
		mocks.rateLimit.mockRejectedValue(
			new ORPCError("TOO_MANY_REQUESTS", { message: "Slow down" }),
		);

		expect((await errorFrom(call())).code).toBe("TOO_MANY_REQUESTS");
	});
});

describe("proposalDuplicateFlagsProcedure — results", () => {
	it("returns the flags found, with the tenant taken from the project", async () => {
		await expect(call()).resolves.toEqual(CHECKED);
		expect(mocks.detect).toHaveBeenCalledTimes(1);
		expect(mocks.detect).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project-1",
				userId: "user-1",
				organizationId: "org-1",
				maxStaleEmbeds: 200,
				abortSignal: expect.any(AbortSignal),
			}),
		);
	});

	it("says which items are still to be compared or verified", async () => {
		const pending = {
			flags: [FLAG],
			stillChecking: 40,
			verifying: 1,
			checking: [{ proposalId: "prop-2", changeIndex: 1 }],
		};
		mocks.detect.mockResolvedValue(pending);

		await expect(call()).resolves.toEqual(pending);
	});

	it("waits for nothing when the check fails", async () => {
		mocks.detect.mockRejectedValue(new Error("embedding outage"));

		await expect(call()).resolves.toEqual(
			expect.objectContaining({
				flags: [],
				stillChecking: 0,
				verifying: 0,
				checking: [],
			}),
		);
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
