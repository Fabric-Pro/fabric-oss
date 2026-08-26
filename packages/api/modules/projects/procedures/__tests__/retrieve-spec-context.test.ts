/**
 * Unit tests for `projects.specContext` (retrieve-spec-context).
 *
 * The procedure wraps the multi-query RRF retrieval
 * (`retrieveRelevantContextsForSpec`) so the "Update Clean Spec" refresh can
 * deterministically front-load stored project context (#1794). Verifies:
 * content mapping, the project-access guard, epoch baseline default, an
 * explicit baseline passthrough, and graceful degradation when no AI provider
 * is configured.
 *
 * Mocks `@repo/database`, `@repo/rag`, `@repo/logs`, and the oRPC procedure
 * base so the handler can be invoked directly (mirrors the update-with-context
 * guard test).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		hasProjectAccess: vi.fn(),
		retrieveRelevantContextsForSpec: vi.fn(),
		loggerWarn: vi.fn(),
		loggerError: vi.fn(),
		loggerInfo: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.hasProjectAccess,
}));

vi.mock("@repo/rag", () => ({
	retrieveRelevantContextsForSpec: mocks.retrieveRelevantContextsForSpec,
	// Context Source Type Labeling (#1888): header helper — "" keeps these
	// fixtures' content strings unchanged.
	contextMetaHeader: () => "",
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: mocks.loggerWarn,
		error: mocks.loggerError,
		info: mocks.loggerInfo,
		debug: vi.fn(),
	},
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.specContext = fn;
			return { _handler: fn };
		},
	});
	const Permissions = new Proxy({}, { get: (_t, p) => String(p) }) as Record<
		string,
		string
	>;
	return {
		tenantProtectedProcedure: chainable,
		Permissions,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

await import("../retrieve-spec-context");

const ctx = {
	user: { id: "user-1" },
	session: { id: "s-1", activeOrganizationId: null },
};

function run(input: Record<string, unknown>) {
	return handlers.specContext({
		input: {
			projectId: "project-1",
			specMarkdown: "## Spec\nsome content",
			organizationId: null,
			...input,
		},
		context: ctx,
	}) as Promise<{ contexts: string[] }>;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.retrieveRelevantContextsForSpec.mockResolvedValue([]);
});

describe("projects.specContext", () => {
	it("maps retrieved contexts to their content strings", async () => {
		mocks.retrieveRelevantContextsForSpec.mockResolvedValue([
			{ content: "transcript A" },
			{ content: "doc B" },
		]);
		const result = await run({});
		expect(result).toEqual({ contexts: ["transcript A", "doc B"] });
	});

	it("throws when the caller lacks project access", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);
		await expect(run({})).rejects.toThrow();
		expect(mocks.retrieveRelevantContextsForSpec).not.toHaveBeenCalled();
	});

	it("defaults the baseline to the epoch (retrieve across all history)", async () => {
		await run({});
		const arg = mocks.retrieveRelevantContextsForSpec.mock.calls[0][0];
		expect(arg.baselineDate).toEqual(new Date(0));
		expect(arg.specMarkdown).toBe("## Spec\nsome content");
	});

	it("passes an explicit baselineDate through", async () => {
		await run({ baselineDate: "2026-06-01T00:00:00.000Z" });
		const arg = mocks.retrieveRelevantContextsForSpec.mock.calls[0][0];
		expect(arg.baselineDate).toEqual(new Date("2026-06-01T00:00:00.000Z"));
	});

	it("degrades to empty contexts when no AI provider is configured", async () => {
		mocks.retrieveRelevantContextsForSpec.mockRejectedValue(
			new Error("No AI provider configured"),
		);
		const result = await run({});
		expect(result).toEqual({ contexts: [] });
		expect(mocks.loggerWarn).toHaveBeenCalled();
	});

	it("degrades to empty contexts on unexpected retrieval errors", async () => {
		mocks.retrieveRelevantContextsForSpec.mockRejectedValue(
			new Error("qdrant exploded"),
		);
		const result = await run({});
		expect(result).toEqual({ contexts: [] });
		expect(mocks.loggerError).toHaveBeenCalled();
	});
});
