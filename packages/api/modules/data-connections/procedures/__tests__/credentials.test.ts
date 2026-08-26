import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	return { handlers };
});

vi.mock("@repo/database", () => {
	// Minimal zod-schema stub: the procedure module calls `.optional()` on
	// DataConnectionProviderSchema, so the stub returns itself for any
	// chained method.
	const schemaStub: Record<string, unknown> = {};
	const chainable = new Proxy(schemaStub, {
		get: () => () => chainable,
	});
	return {
		createDataConnectionCredential: vi.fn(),
		getDataConnectionCredentialById: vi.fn(),
		getDataConnectionCredentials: vi.fn(),
		getDataConnectionById: vi.fn(),
		updateDataConnection: vi.fn(),
		DataConnectionProviderSchema: chainable,
	};
});

vi.mock("@repo/utils", () => ({
	encryptApiKey: vi.fn((value: string) => `enc:${value}`),
}));

vi.mock("../../../../orpc/procedures", () => {
	const inner = {
		route() {
			return {
				input() {
					return {
						handler(fn: (...args: unknown[]) => unknown) {
							const callIndex = Object.keys(handlers).length;
							const keys = [
								"list",
								"create",
								"get",
								"assignToConnection",
							];
							// biome-ignore lint/style/noNonNullAssertion: test assertion — keys[callIndex] is valid within the test setup
							handlers[keys[callIndex]!] = fn;
							return { _handler: fn };
						},
					};
				},
			};
		},
	};

	return {
		tenantProtectedProcedure: {
			use: () => inner,
			...inner,
		},
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
	createDataConnectionCredential,
	getDataConnectionById,
	getDataConnectionCredentialById,
	getDataConnectionCredentials,
	updateDataConnection,
} from "@repo/database";

import "../credentials";

describe("credentialsProcedures", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getDataConnectionCredentials).mockResolvedValue([]);
		vi.mocked(createDataConnectionCredential).mockImplementation(
			async (input: any) => ({
				id: "cred-1",
				...input,
			}),
		);
	});

	it("lists saved credentials for the tenant", async () => {
		vi.mocked(getDataConnectionCredentials).mockResolvedValueOnce([
			{ id: "cred-1", name: "HubSpot prod" },
		] as any);

		const result = await handlers.list({
			input: {
				organizationId: null,
				provider: "HUBSPOT",
			},
			context: {
				user: { id: "user-1" },
				session: { activeOrganizationId: null },
			},
		});

		expect(result.credentials).toHaveLength(1);
		expect(getDataConnectionCredentials).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "HUBSPOT",
			}),
		);
	});

	it("creates and encrypts a reusable connector credential", async () => {
		const result = await handlers.create({
			input: {
				organizationId: null,
				provider: "CLICKUP",
				name: "ClickUp PAT",
				credentialType: "apiKey",
				payload: {
					apiKey: "pk_test",
				},
			},
			context: {
				user: { id: "user-1" },
				session: { activeOrganizationId: null },
			},
		});

		expect(createDataConnectionCredential).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "CLICKUP",
				name: "ClickUp PAT",
				encryptedPayload: 'enc:{"apiKey":"pk_test"}',
			}),
		);
		expect(result.credential.id).toBe("cred-1");
	});

	it("assigns a saved credential to an existing connection", async () => {
		vi.mocked(getDataConnectionById).mockResolvedValueOnce({
			id: "conn-1",
			provider: "CLICKUP",
		} as any);
		vi.mocked(getDataConnectionCredentialById).mockResolvedValueOnce({
			id: "cred-1",
			provider: "CLICKUP",
		} as any);

		const result = await handlers.assignToConnection({
			input: {
				id: "conn-1",
				credentialId: "cred-1",
				organizationId: null,
			},
			context: {
				user: { id: "user-1" },
				session: { activeOrganizationId: null },
			},
		});

		expect(updateDataConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "conn-1",
				data: expect.objectContaining({
					credentialId: "cred-1",
					status: "CONNECTED",
				}),
			}),
		);
		expect(result.ok).toBe(true);
	});

	it("rejects missing credentials on lookup", async () => {
		vi.mocked(getDataConnectionCredentialById).mockResolvedValueOnce(null);

		await expect(
			handlers.get({
				input: {
					id: "missing",
					organizationId: null,
				},
				context: {
					user: { id: "user-1" },
					session: { activeOrganizationId: null },
				},
			}),
		).rejects.toThrow(ORPCError);
	});
});
