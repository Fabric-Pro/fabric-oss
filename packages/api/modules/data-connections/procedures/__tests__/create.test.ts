import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	return { handlers };
});

vi.mock("@repo/database", () => ({
	createDataConnection: vi.fn(),
	getDataConnectionCredentialById: vi.fn(),
	getDataConnectionByProvider: vi.fn(),
	DataConnectionProviderSchema: {},
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.create = fn;
			return { _handler: fn };
		},
	};

	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null) => organizationId,
		),
	};
});

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn().mockResolvedValue(true),
}));

import {
	createDataConnection,
	getDataConnectionByProvider,
	getDataConnectionCredentialById,
} from "@repo/database";

import "../create";

describe("createProcedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getDataConnectionByProvider).mockResolvedValue(null);
		vi.mocked(getDataConnectionCredentialById).mockResolvedValue(null);
		vi.mocked(createDataConnection).mockImplementation(
			async (input: any) => ({
				id: "conn-1",
				...input,
			}),
		);
	});

	it("marks Confluence as CONNECTED when manual credentials are supplied", async () => {
		const result = await handlers.create({
			input: {
				organizationId: null,
				provider: "CONFLUENCE",
				name: "Engineering Wiki",
				credentials: {
					domain: "example.atlassian.net",
					email: "test-user@example.com",
					apiToken: "token-123",
				},
				config: {
					spaceKeys: ["ENG"],
				},
			},
			context: {
				user: { id: "user-1" },
				session: { activeOrganizationId: null },
			},
		});

		expect(createDataConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "CONFLUENCE",
				status: "CONNECTED",
				credentials: expect.objectContaining({
					domain: "example.atlassian.net",
				}),
			}),
		);
		expect(result.connection.status).toBe("CONNECTED");
	});

	it("keeps OAuth-backed providers in PENDING status before authorization", async () => {
		await handlers.create({
			input: {
				organizationId: null,
				provider: "GITHUB",
				name: "GitHub",
			},
			context: {
				user: { id: "user-1" },
				session: { activeOrganizationId: null },
			},
		});

		expect(createDataConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "GITHUB",
				status: "PENDING",
			}),
		);
	});

	it("rejects duplicate provider connections for the same tenant", async () => {
		vi.mocked(getDataConnectionByProvider).mockResolvedValueOnce({
			id: "existing-1",
		} as any);

		await expect(
			handlers.create({
				input: {
					organizationId: null,
					provider: "CONFLUENCE",
					name: "Engineering Wiki",
				},
				context: {
					user: { id: "user-1" },
					session: { activeOrganizationId: null },
				},
			}),
		).rejects.toThrow(ORPCError);
	});

	it("accepts a saved credential reference for manual and token connectors", async () => {
		vi.mocked(getDataConnectionCredentialById).mockResolvedValueOnce({
			id: "cred-1",
			provider: "HUBSPOT",
		} as any);

		const result = await handlers.create({
			input: {
				organizationId: null,
				provider: "HUBSPOT",
				name: "HubSpot Search",
				credentialId: "cred-1",
				config: {
					objectTypes: ["contacts"],
				},
			},
			context: {
				user: { id: "user-1" },
				session: { activeOrganizationId: null },
			},
		});

		expect(createDataConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "HUBSPOT",
				credentialId: "cred-1",
				status: "CONNECTED",
			}),
		);
		expect(result.connection.credentialId).toBe("cred-1");
	});
});
