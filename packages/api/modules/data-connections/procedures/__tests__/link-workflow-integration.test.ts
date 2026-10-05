import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	return { handlers };
});

vi.mock("@repo/database", () => ({
	createDataConnection: vi.fn(),
	db: { workflowIntegration: { findFirst: vi.fn() } },
	getDataConnectionByProvider: vi.fn(),
	updateDataConnection: vi.fn(),
}));

vi.mock("@repo/integrations/gitlab", () => ({
	findUsableGitLabConnection: vi.fn(),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn((value: string) => value),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.link = fn;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		// The real resolver's rule for the organization a request names (the
		// input's, else the session's; an explicit null suppresses the session
		// fallback; none refused when required). Membership and role are
		// exercised for real in gitlab-request-authorization.test.ts.
		authorizeInputOrganization: async (
			_permission: string,
			orgId: string | null | undefined,
			ctx: { session?: { activeOrganizationId?: string | null } },
			opts?: { requireOrganization?: boolean },
		) => {
			const resolved =
				orgId ||
				(orgId === null
					? undefined
					: ctx.session?.activeOrganizationId || undefined);
			if (!resolved && opts?.requireOrganization) {
				throw new Error(
					"This operation requires an organization context",
				);
			}
			return resolved;
		},
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
	db,
	getDataConnectionByProvider,
	updateDataConnection,
} from "@repo/database";
import { findUsableGitLabConnection } from "@repo/integrations/gitlab";

import "../link-workflow-integration";

const context = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};

const EXISTING = {
	id: "conn-gl",
	provider: "GITLAB",
	config: { baseUrl: "https://gitlab.example.com", projects: ["a/b"] },
};

describe("linkWorkflow — GitLab", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(findUsableGitLabConnection).mockResolvedValue({
			integrationId: "wi-1",
			origin: "https://gitlab.example.com",
		});
		vi.mocked(updateDataConnection).mockResolvedValue({ count: 1 } as any);
		vi.mocked(createDataConnection).mockImplementation(
			async (input: any) => ({ id: "conn-new", ...input }),
		);
	});

	it("links an existing connection without copying a token, keeping its config", async () => {
		vi.mocked(getDataConnectionByProvider).mockResolvedValue(
			EXISTING as any,
		);

		await handlers.link({
			input: {
				provider: "GITLAB",
				name: "GitLab",
				organizationId: "org-1",
			},
			context,
		});

		expect(findUsableGitLabConnection).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
		// The person's GitLab credential is never read here.
		expect(db.workflowIntegration.findFirst).not.toHaveBeenCalled();
		expect(updateDataConnection).toHaveBeenCalledOnce();
		const { data } = vi.mocked(updateDataConnection).mock.calls[0]![0];
		expect(data).toEqual({
			name: "GitLab",
			status: "CONNECTED",
			accessToken: null,
			refreshToken: null,
			tokenExpiresAt: null,
			credentialId: null,
		});
		expect("config" in data).toBe(false);
	});

	it("replaces the config only when one is sent", async () => {
		vi.mocked(getDataConnectionByProvider).mockResolvedValue(
			EXISTING as any,
		);

		await handlers.link({
			input: {
				provider: "GITLAB",
				name: "GitLab",
				organizationId: "org-1",
				config: { projects: ["c/d"] },
			},
			context,
		});

		const { data } = vi.mocked(updateDataConnection).mock.calls[0]![0];
		expect(data.config).toEqual({ projects: ["c/d"] });
	});

	it("creates a new connection with no token", async () => {
		vi.mocked(getDataConnectionByProvider).mockResolvedValue(null);

		await handlers.link({
			input: {
				provider: "GITLAB",
				name: "GitLab",
				organizationId: "org-1",
			},
			context,
		});

		const written = vi.mocked(createDataConnection).mock.calls[0]![0];
		expect(written).toMatchObject({
			provider: "GITLAB",
			status: "CONNECTED",
			config: {},
		});
		expect(written.accessToken).toBeUndefined();
		expect(written.refreshToken).toBeUndefined();
		expect(written.credentials).toBeUndefined();
	});

	it("refuses when the caller has no usable GitLab connection", async () => {
		vi.mocked(findUsableGitLabConnection).mockResolvedValue(null);

		const error = await handlers
			.link({
				input: {
					provider: "GITLAB",
					name: "GitLab",
					organizationId: "org-1",
				},
				context,
			})
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
		expect(updateDataConnection).not.toHaveBeenCalled();
		expect(createDataConnection).not.toHaveBeenCalled();
	});
});

describe("linkWorkflow — other providers keep the token copy", () => {
	it("copies the GitHub workflow token as before", async () => {
		vi.clearAllMocks();
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
			credentials: JSON.stringify({ access_token: "gh-token" }),
			settings: { login: "example" },
		} as any);
		vi.mocked(getDataConnectionByProvider).mockResolvedValue(null);
		vi.mocked(createDataConnection).mockImplementation(
			async (input: any) => ({ id: "conn-gh", ...input }),
		);

		await handlers.link({
			input: {
				provider: "GITHUB",
				name: "GitHub",
				organizationId: "org-1",
			},
			context,
		});

		expect(createDataConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "GITHUB",
				accessToken: "gh-token",
			}),
		);
		expect(findUsableGitLabConnection).not.toHaveBeenCalled();
	});
});
