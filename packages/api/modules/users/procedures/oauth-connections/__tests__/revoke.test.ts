import { beforeEach, describe, expect, it, vi } from "vitest";

const { registeredHandler, revokeOAuthConnection, recordAuditFromRequest } =
	vi.hoisted(() => ({
		registeredHandler: {
			fn: undefined as ((...args: unknown[]) => unknown) | undefined,
		},
		revokeOAuthConnection: vi.fn(),
		recordAuditFromRequest: vi.fn(),
	}));

vi.mock("@repo/database", () => ({ revokeOAuthConnection }));

vi.mock("../../../../../lib/audit", () => ({ recordAuditFromRequest }));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			registeredHandler.fn = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		requirePermission: (permission: string) => permission,
		Permissions: { USER_UPDATE_SELF: "user:update_self" },
	};
});

import "../revoke";

function revoke(consentId: string, userId = "user-1") {
	const handler = registeredHandler.fn;
	if (!handler) {
		throw new Error("the procedure registered no handler");
	}
	return handler({ context: { user: { id: userId } }, input: { consentId } });
}

describe("revoking a connected agent", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("revokes the caller's own consent and audits it against the public client id", async () => {
		revokeOAuthConnection.mockResolvedValueOnce({
			clientId: "client-public-id",
			clientName: "Example Agent",
			organizationId: "org-example-alpha",
		});

		await expect(revoke("consent-1")).resolves.toEqual({ success: true });

		expect(revokeOAuthConnection).toHaveBeenCalledWith({
			userId: "user-1",
			consentId: "consent-1",
		});
		expect(recordAuditFromRequest).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "account.oauth.consent_revoked",
				organizationId: "org-example-alpha",
				resource: {
					type: "oauth_client",
					id: "client-public-id",
					name: "Example Agent",
				},
				metadata: { consentId: "consent-1" },
			}),
		);
	});

	it("answers NOT_FOUND, and audits nothing, for a consent that is not the caller's", async () => {
		revokeOAuthConnection.mockResolvedValueOnce(null);

		await expect(revoke("consent-of-someone-else")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(recordAuditFromRequest).not.toHaveBeenCalled();
	});
});
