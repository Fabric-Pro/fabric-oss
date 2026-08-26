import { describe, expect, it, vi } from "vitest";

// Stub @repo/database so importing `../inbox` does not pull in the Prisma
// client singleton (which throws when DATABASE_URL is not set in unit tests).
vi.mock("@repo/database", () => ({
	db: {},
}));

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn(),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: () => ({ _handler: () => null }),
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null) =>
			organizationId,
	};
});

import { mapAgentReplyStatus } from "../inbox";

describe("agent inbox status mapping", () => {
	it("uses metadata.status to mark Fabric replies as failed", () => {
		expect(mapAgentReplyStatus({ status: "failed" })).toBe("failed");
	});

	it("does not infer failure from reply text", () => {
		expect(
			mapAgentReplyStatus({
				note: "I couldn't generate a reply: old text should not drive status",
			}),
		).toBe("completed");
	});

	it("treats missing, null, and non-object metadata as completed", () => {
		expect(mapAgentReplyStatus(undefined)).toBe("completed");
		expect(mapAgentReplyStatus(null)).toBe("completed");
		expect(mapAgentReplyStatus("failed")).toBe("completed");
		expect(mapAgentReplyStatus(["failed"])).toBe("completed");
	});
});
