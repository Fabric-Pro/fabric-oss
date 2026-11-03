/**
 * Saving a GitHub personal access token through the integrations settings
 * form (or the repository import's "paste a token") REPLACES a sign-in grant.
 * Merged into the old credential, the grant's `access_token` stayed the token
 * every reader picked, so the pasted PAT was never used.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	rows: [] as Array<{
		id: string;
		userId: string;
		organizationId: string | null;
		provider: string;
		credentials: string;
	}>,
}));

vi.mock("@repo/database", () => ({
	listWorkflowIntegrations: async (args: {
		userId: string;
		organizationId?: string | null;
		provider: string;
	}) =>
		state.rows.filter(
			(row) =>
				row.userId === args.userId &&
				row.organizationId === (args.organizationId ?? null) &&
				row.provider === args.provider,
		),
	updateWorkflowIntegration: async (
		id: string,
		_userId: string,
		data: Record<string, unknown>,
	) => {
		const row = state.rows.find((r) => r.id === id);
		Object.assign(row ?? {}, data);
		return row;
	},
	createWorkflowIntegration: async () => {
		throw new Error("unexpected create");
	},
}));

vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<object>()),
	encryptApiKey: (value: string) => `enc:${value}`,
	decryptApiKey: (value: string) => value.replace(/^enc:/, ""),
}));

vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async () => ({ role: "member" }),
}));

vi.mock("../../../../../orpc/procedures", () => {
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
		requirePermission: () => (c: unknown) => c,
		authorizeInputOrganization: async (
			_permission: string,
			orgId: string | null | undefined,
		) => orgId ?? undefined,
	};
});

import { saveIntegrationProcedure } from "../save-integration";

type Handler = (args: {
	input: {
		type: string;
		credentials: Record<string, string>;
		organizationId?: string | null;
	};
	context: {
		user: { id: string };
		session: { activeOrganizationId: string | null };
	};
}) => Promise<{ success: boolean; integrationId: string }>;

const handler = (saveIntegrationProcedure as unknown as { handler: Handler })
	.handler;

const context = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

function stored() {
	return JSON.parse(
		(state.rows[0]?.credentials ?? "").replace(/^enc:/, ""),
	) as Record<string, unknown>;
}

beforeEach(() => {
	state.rows = [
		{
			id: "wi-1",
			userId: "user-1",
			organizationId: "org-1",
			provider: "GITHUB",
			credentials: `enc:${JSON.stringify({
				access_token: "ghu-example",
				refresh_token: "ghr-example",
				expires_in: 28800,
				token_obtained_at: "2026-01-01T00:00:00Z",
			})}`,
		},
	];
});

describe("saveIntegration — GitHub personal access token", () => {
	it("replaces a sign-in grant, so the pasted token is the one read", async () => {
		const result = await handler({
			input: {
				type: "GITHUB",
				credentials: { GITHUB_TOKEN: "ghp-example" },
				organizationId: "org-1",
			},
			context,
		});

		expect(result).toMatchObject({ success: true, integrationId: "wi-1" });
		expect(stored()).toEqual({ GITHUB_TOKEN: "ghp-example" });
	});
});
