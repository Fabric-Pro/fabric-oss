import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerateObject = vi.fn();
const mockGetAIModelWithMetadata = vi.fn();
const mockProjectFindUnique = vi.fn();

vi.mock("ai", () => ({
	zodSchema: (s: unknown) => s,
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: (...a: unknown[]) =>
		mockGetAIModelWithMetadata(...a),
	generateObject: (...a: unknown[]) => mockGenerateObject(...a),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: (...a: unknown[]) => mockProjectFindUnique(...a),
		},
	},
	hasProjectAccess: vi.fn(async () => true),
}));

vi.mock("../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: { id: string; organizationId?: string | null };
	context: { user: { id: string }; session: { id: string } };
}) => Promise<{ terminalStatuses: string[]; usedFallback: boolean }>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../suggest-terminal-statuses");
	return (
		mod.suggestTerminalStatusesProcedure as unknown as { handler: Handler }
	).handler;
}

const baseInput = { id: "proj-1", organizationId: null };
const baseContext = { user: { id: "user-1" }, session: { id: "sess-1" } };

beforeEach(() => {
	vi.clearAllMocks();
	// Project owner tenant is intentionally distinct from the requesting
	// user/session so we can assert the AI tenant is resolved from the PROJECT.
	mockProjectFindUnique.mockResolvedValue({
		id: "proj-1",
		userId: "owner-user",
		organizationId: "owner-org",
		projectManagementMcpServerId: "azure-devops",
	});
	mockGetAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: {},
		trackUsage: vi.fn(),
	});
});

describe("suggestTerminalStatusesProcedure", () => {
	it("returns AI-recommended statuses on success", async () => {
		mockGenerateObject.mockResolvedValue({
			object: { terminalStatuses: ["Closed", "Done", "Removed"] },
			usage: {},
		});
		const handler = await loadHandler();
		const result = await handler({
			input: baseInput,
			context: baseContext,
		});
		expect(result.terminalStatuses).toEqual(["Closed", "Done", "Removed"]);
		expect(result.usedFallback).toBe(false);
		// AI tenant comes from the PROJECT owner, not the request user/session.
		expect(mockGetAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "SIMPLE" },
			{ userId: "owner-user", organizationId: "owner-org" },
		);
	});

	it("falls back to the built-in set when the AI call throws", async () => {
		mockGenerateObject.mockRejectedValue(new Error("provider down"));
		const handler = await loadHandler();
		const result = await handler({
			input: baseInput,
			context: baseContext,
		});
		expect(result.terminalStatuses).toEqual(["Closed", "Done", "Removed"]);
		expect(result.usedFallback).toBe(true);
	});
});
