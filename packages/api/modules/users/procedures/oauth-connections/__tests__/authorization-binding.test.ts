import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	registeredHandler,
	findLiveOAuthAuthorizationResource,
	resolveOAuthProjectGrantTarget,
} = vi.hoisted(() => ({
	registeredHandler: {
		fn: undefined as ((...args: unknown[]) => unknown) | undefined,
	},
	findLiveOAuthAuthorizationResource: vi.fn(),
	resolveOAuthProjectGrantTarget: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	findLiveOAuthAuthorizationResource,
	resolveOAuthProjectGrantTarget,
}));

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
		Permissions: { USER_READ_SELF: "user:read_self" },
	};
});

import "../authorization-binding";

function read(userId = "user-1") {
	const handler = registeredHandler.fn;
	if (!handler) {
		throw new Error("the procedure registered no handler");
	}
	return handler({
		context: { user: { id: userId } },
		input: { clientId: "client-1", codeChallenge: "challenge-1" },
	});
}

describe("reading what an agent's authorization is bound to", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("says an authorization that named no project is not bound, and looks nothing else up", async () => {
		findLiveOAuthAuthorizationResource.mockResolvedValueOnce(null);

		await expect(read()).resolves.toEqual({ bound: false, project: null });

		expect(findLiveOAuthAuthorizationResource).toHaveBeenCalledWith(
			"client-1",
			"challenge-1",
		);
		expect(resolveOAuthProjectGrantTarget).not.toHaveBeenCalled();
	});

	it("names the project and its organization for a person who can read it", async () => {
		findLiveOAuthAuthorizationResource.mockResolvedValueOnce({
			resource:
				"https://app.example.com/api/mcp-gateway/projects/project-one",
			projectId: "project-one",
			audience: "mcp",
		});
		resolveOAuthProjectGrantTarget.mockResolvedValueOnce({
			projectId: "project-one",
			projectName: "Example Project",
			organizationId: "org-example-alpha",
			organizationName: "Example Alpha",
		});

		await expect(read()).resolves.toEqual({
			bound: true,
			project: {
				id: "project-one",
				name: "Example Project",
				audience: "mcp",
				organizationId: "org-example-alpha",
				organizationName: "Example Alpha",
			},
		});
		expect(resolveOAuthProjectGrantTarget).toHaveBeenCalledWith(
			"user-1",
			"project-one",
		);
	});

	it("carries the audience of the binding, so the page can repeat it when it answers", async () => {
		findLiveOAuthAuthorizationResource.mockResolvedValueOnce({
			resource: "https://app.example.com/api/v1/projects/project-one",
			projectId: "project-one",
			audience: "api",
		});
		resolveOAuthProjectGrantTarget.mockResolvedValueOnce({
			projectId: "project-one",
			projectName: "Example Project",
			organizationId: "org-example-alpha",
			organizationName: "Example Alpha",
		});

		await expect(read()).resolves.toMatchObject({
			project: { audience: "api" },
		});
	});

	it("names nothing for a person who cannot read the project, whatever the reason", async () => {
		findLiveOAuthAuthorizationResource.mockResolvedValueOnce({
			resource:
				"https://app.example.com/api/mcp-gateway/projects/project-one",
			projectId: "project-one",
			audience: "mcp",
		});
		resolveOAuthProjectGrantTarget.mockResolvedValueOnce(null);

		await expect(read("user-2")).resolves.toEqual({
			bound: true,
			project: null,
		});
	});
});
