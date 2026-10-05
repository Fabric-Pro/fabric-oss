/**
 * `integrations.gitlab.listRepositoryLinks` lists the organization's GitLab
 * project repository links for the GitLab provider page: only links on
 * projects the caller can see (`hasProjectAccess`), `canDisconnect` from the
 * same check the per-project disconnect route enforces
 * (`canEditProjectSettings`), and never a token.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	rows: [] as Array<Record<string, unknown>>,
	visible: new Set<string>(),
	editable: new Set<string>(),
	findManyArgs: [] as unknown[],
	permissionCalls: [] as unknown[][],
}));

vi.mock("@repo/database", () => ({
	db: {
		projectRepositoryIntegration: {
			findMany: async (args: {
				where: {
					provider: string;
					project: { organizationId: string };
				};
			}) => {
				state.findManyArgs.push(args);
				return state.rows.filter(
					(row) =>
						row.provider === args.where.provider &&
						(row.project as { organizationId: string })
							.organizationId ===
							args.where.project.organizationId,
				);
			},
		},
	},
	hasProjectAccess: vi.fn(async (projectId: string) =>
		state.visible.has(projectId),
	),
	canEditProjectSettings: vi.fn(async (projectId: string) =>
		state.editable.has(projectId),
	),
}));

vi.mock("../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (fn: unknown) => ({ handler: fn }),
	});
	return {
		tenantProtectedProcedure: chain,
		requireInputOrgPermission: (...args: unknown[]) => {
			state.permissionCalls.push(args);
			return {};
		},
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? undefined,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
	};
});

import { canEditProjectSettings, hasProjectAccess } from "@repo/database";
import { listGitLabRepositoryLinksProcedure } from "../../procedures/gitlab-repository-links";

const USER = "user-1";
const ORG = "example-org";

type Handler = {
	handler: (args: {
		input: Record<string, unknown>;
		context: Record<string, unknown>;
	}) => Promise<{ links: Array<Record<string, unknown>> }>;
};
const run = (input: Record<string, unknown>) =>
	(listGitLabRepositoryLinksProcedure as unknown as Handler).handler({
		input,
		context: {
			user: { id: USER, email: "dev@example.com", name: "Dev" },
			session: { id: "session-1", activeOrganizationId: ORG },
		},
	});

function link(
	id: string,
	projectId: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		id,
		projectId,
		provider: "GITLAB",
		repositoryOwner: "example-group",
		repositoryName: `repo-${id}`,
		repositoryUrl: `https://gitlab.example.com/example-group/repo-${id}`,
		authMethod: "OAUTH",
		status: "ACTIVE",
		accessToken: "secret-link-token",
		refreshToken: "secret-link-refresh",
		project: { name: `Project ${projectId}`, organizationId: ORG },
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	state.rows = [];
	state.visible = new Set();
	state.editable = new Set();
	state.findManyArgs = [];
});

describe("integrations.gitlab.listRepositoryLinks", () => {
	it("requires an organization and the integration read permission", () => {
		expect(state.permissionCalls).toContainEqual([
			"INTEGRATION_READ",
			{ requireOrganization: true },
		]);
	});

	it("lists only links on projects the caller can see, with canDisconnect from the project settings check", async () => {
		state.rows = [
			link("a", "project-editable"),
			link("b", "project-readonly"),
			link("c", "project-hidden"),
			link("d", "project-editable", { status: "NEEDS_REAUTH" }),
		];
		state.visible = new Set(["project-editable", "project-readonly"]);
		state.editable = new Set(["project-editable"]);

		const { links } = await run({ organizationId: ORG });

		expect(links.map((l) => [l.id, l.canDisconnect, l.status])).toEqual([
			["a", true, "ACTIVE"],
			["b", false, "ACTIVE"],
			["d", true, "NEEDS_REAUTH"],
		]);
		expect(hasProjectAccess).toHaveBeenCalledWith("project-hidden", USER);
		// The edit check runs only for projects the caller can see, once each.
		expect(canEditProjectSettings).not.toHaveBeenCalledWith(
			"project-hidden",
			USER,
		);
		expect(canEditProjectSettings).toHaveBeenCalledTimes(2);
	});

	it("reads only the organization's GitLab links", async () => {
		state.rows = [
			link("mine", "project-editable"),
			link("github", "project-editable", { provider: "GITHUB" }),
			link("other-org", "project-other", {
				project: { name: "Other", organizationId: "other-org" },
			}),
		];
		state.visible = new Set(["project-editable", "project-other"]);

		const { links } = await run({ organizationId: ORG });

		expect(links.map((l) => l.id)).toEqual(["mine"]);
		expect(state.findManyArgs[0]).toMatchObject({
			where: { provider: "GITLAB", project: { organizationId: ORG } },
		});
	});

	it("never returns a token", async () => {
		state.rows = [link("a", "project-editable")];
		state.visible = new Set(["project-editable"]);

		const result = await run({ organizationId: ORG });

		expect(JSON.stringify(result)).not.toContain("secret-link");
		expect(Object.keys(result.links[0]).sort()).toEqual([
			"authMethod",
			"canDisconnect",
			"id",
			"projectId",
			"projectName",
			"repositoryName",
			"repositoryOwner",
			"repositoryUrl",
			"status",
		]);
	});

	it("refuses without an organization", async () => {
		await expect(run({ organizationId: null })).rejects.toThrow(
			/An organization is required/,
		);
		expect(state.findManyArgs).toHaveLength(0);
	});
});
