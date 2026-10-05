import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	return { handlers };
});

vi.mock("@repo/database", () => ({
	DataConnectionStatusSchema: { optional: () => ({}) },
	getDataConnectionById: vi.fn(),
	getDataConnectionCredentialById: vi.fn(),
	updateDataConnection: vi.fn(),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.update = fn;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null) => organizationId,
		),
	};
});

vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn().mockResolvedValue(true),
}));

import {
	getDataConnectionById,
	getDataConnectionCredentialById,
	updateDataConnection,
} from "@repo/database";

import "../update";

const context = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

function connection(provider: string) {
	return { id: "conn-1", provider, status: "CONNECTED" } as any;
}

describe("updateProcedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(updateDataConnection).mockResolvedValue({ count: 1 } as any);
	});

	it("refuses token credentials for a GitLab connection", async () => {
		vi.mocked(getDataConnectionById).mockResolvedValue(
			connection("GITLAB"),
		);

		const error = await handlers
			.update({
				input: {
					id: "conn-1",
					organizationId: "org-1",
					credentials: { access_token: "glpat-example" },
				},
				context,
			})
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("BAD_REQUEST");
		expect(updateDataConnection).not.toHaveBeenCalled();
	});

	it("refuses assigning a saved credential to a GitLab connection", async () => {
		vi.mocked(getDataConnectionById).mockResolvedValue(
			connection("GITLAB"),
		);
		vi.mocked(getDataConnectionCredentialById).mockResolvedValue({
			id: "cred-1",
			provider: "GITLAB",
		} as any);

		const error = await handlers
			.update({
				input: {
					id: "conn-1",
					organizationId: "org-1",
					credentialId: "cred-1",
				},
				context,
			})
			.catch((e: unknown) => e);

		expect((error as ORPCError<string, unknown>).code).toBe("BAD_REQUEST");
		expect(updateDataConnection).not.toHaveBeenCalled();
	});

	it("still updates a GitLab connection's config and may unassign a credential", async () => {
		vi.mocked(getDataConnectionById).mockResolvedValue(
			connection("GITLAB"),
		);

		await handlers.update({
			input: {
				id: "conn-1",
				organizationId: "org-1",
				config: { projects: ["platform/api"] },
				credentials: {},
				credentialId: null,
			},
			context,
		});

		expect(updateDataConnection).toHaveBeenCalledOnce();
		const { data } = vi.mocked(updateDataConnection).mock.calls[0]![0];
		expect(data).toEqual({
			config: { projects: ["platform/api"] },
			credentialId: null,
		});
	});

	it("keeps storing credentials for other providers", async () => {
		vi.mocked(getDataConnectionById).mockResolvedValue(
			connection("CLICKUP"),
		);

		await handlers.update({
			input: {
				id: "conn-1",
				organizationId: "org-1",
				credentials: { apiKey: "pk_example" },
			},
			context,
		});

		expect(updateDataConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { credentials: { apiKey: "pk_example" } },
			}),
		);
	});
});
