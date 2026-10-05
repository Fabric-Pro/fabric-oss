/**
 * The `<PROVIDER>_OAUTH_APP` rows hold a provider's stored OAuth client
 * credentials. They share provider, user and organization with the user's
 * connection rows, so only the exact reserved name tells them apart.
 *
 * `deleteWorkflowIntegrationByType` (the generic Disconnect on the workflow
 * integration settings page) hard-deleted every row for the provider, the app
 * credentials included, and the connection listings returned them as if they
 * were connections. The store below applies the queries' real `where` clauses
 * to real rows, so the assertions are about which rows survive and which are
 * returned, not about the clause text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
	id: string;
	userId: string;
	organizationId: string | null;
	provider: string;
	name: string;
	isActive: boolean;
	lastUsedAt: Date | null;
};

const { rows } = vi.hoisted(() => ({ rows: [] as Row[] }));

type Where = Record<string, unknown>;

function matchesField(value: unknown, condition: unknown, key: string) {
	if (condition === null || typeof condition !== "object") {
		return value === condition;
	}
	const keys = Object.keys(condition);
	if (keys.length === 1 && keys[0] === "in") {
		return (condition as { in: unknown[] }).in.includes(value);
	}
	// Anything else is a clause this store does not model: fail the suite
	// rather than silently match.
	throw new Error(
		`unsupported filter ${JSON.stringify(condition)} on ${key}`,
	);
}

function matchesWhere(row: Row, where: Where): boolean {
	return Object.entries(where).every(([key, condition]) =>
		key === "OR"
			? (condition as Where[]).some((clause) => matchesWhere(row, clause))
			: key === "NOT"
				? !matchesWhere(row, condition as Where)
				: matchesField(row[key as keyof Row], condition, key),
	);
}

vi.mock("../prisma/client", () => ({
	db: {
		member: {
			findFirst: vi.fn().mockResolvedValue({ id: "member-example" }),
		},
		workflowIntegration: {
			findMany: async ({ where }: { where: Where }) =>
				rows.filter((row) => matchesWhere(row, where)),
			deleteMany: async ({ where }: { where: Where }) => {
				const hit = rows.filter((row) => matchesWhere(row, where));
				for (const row of hit) {
					rows.splice(rows.indexOf(row), 1);
				}
				return { count: hit.length };
			},
		},
	},
}));

import { getConfiguredIntegrations } from "../prisma/queries/workflows/credential-fetcher";
import {
	deleteWorkflowIntegrationByType,
	getIntegrationsByProvider,
	listWorkflowIntegrations,
	listWorkflowIntegrationsInTenant,
} from "../prisma/queries/workflows/integrations";

const USER = "user-1";
const ORG = "org-example";

function seed(
	id: string,
	overrides: Partial<Row> & Pick<Row, "provider" | "name">,
) {
	rows.push({
		id,
		userId: USER,
		organizationId: ORG,
		isActive: true,
		lastUsedAt: null,
		...overrides,
	});
}

function ids(list: Array<{ id: string }>) {
	return list.map((row) => row.id).sort();
}

beforeEach(() => {
	rows.length = 0;
	// Seeded first, so a query that does not exclude it finds it first.
	seed("gitlab-app", { provider: "GITLAB", name: "GITLAB_OAUTH_APP" });
	seed("gitlab-oauth", { provider: "GITLAB", name: "GitLab: example-user" });
	seed("gitlab-pat", { provider: "GITLAB", name: "GITLAB" });
	seed("slack-app", { provider: "SLACK", name: "SLACK_OAUTH_APP" });
});

describe("deleteWorkflowIntegrationByType", () => {
	it("deletes the connection rows and leaves the stored OAuth app credentials in place", async () => {
		const deleted = await deleteWorkflowIntegrationByType(
			"GITLAB",
			USER,
			ORG,
		);

		expect(deleted).toBe(true);
		expect(ids(rows)).toEqual(["gitlab-app", "slack-app"]);
	});

	it("reports nothing deleted (so the caller keeps its NOT_FOUND) when only the app row exists", async () => {
		const deleted = await deleteWorkflowIntegrationByType(
			"SLACK",
			USER,
			ORG,
		);

		expect(deleted).toBe(false);
		expect(ids(rows)).toContain("slack-app");
	});

	it("matches the reserved name exactly: a connection whose name merely ends in _OAUTH_APP is deleted", async () => {
		seed("gitlab-lookalike", {
			provider: "GITLAB",
			name: "GitLab: team_OAUTH_APP",
		});

		await deleteWorkflowIntegrationByType("GITLAB", USER, ORG);

		expect(ids(rows)).not.toContain("gitlab-lookalike");
		expect(ids(rows)).toContain("gitlab-app");
	});

	it("still scopes to the caller's user and organization", async () => {
		seed("other-user", {
			provider: "GITLAB",
			name: "GITLAB",
			userId: "user-2",
		});
		seed("other-org", {
			provider: "GITLAB",
			name: "GITLAB",
			organizationId: "org-other",
		});

		await deleteWorkflowIntegrationByType("GITLAB", USER, ORG);

		expect(ids(rows)).toEqual(
			["gitlab-app", "other-org", "other-user", "slack-app"].sort(),
		);
	});
});

describe("connection listings", () => {
	it("listWorkflowIntegrations does not return a stored OAuth app", async () => {
		const all = await listWorkflowIntegrations({
			userId: USER,
			organizationId: ORG,
		});
		expect(ids(all)).toEqual(["gitlab-oauth", "gitlab-pat"]);

		const gitlab = await listWorkflowIntegrations({
			userId: USER,
			organizationId: ORG,
			provider: "GITLAB",
		});
		expect(ids(gitlab)).toEqual(["gitlab-oauth", "gitlab-pat"]);

		const slack = await listWorkflowIntegrations({
			userId: USER,
			organizationId: ORG,
			provider: "SLACK",
		});
		expect(slack).toEqual([]);
	});

	it("listWorkflowIntegrationsInTenant does not return a stored OAuth app", async () => {
		const all = await listWorkflowIntegrationsInTenant({
			userId: USER,
			organizationId: ORG,
		});
		expect(ids(all)).toEqual(["gitlab-oauth", "gitlab-pat"]);
	});

	it("getIntegrationsByProvider does not return a stored OAuth app", async () => {
		expect(
			ids(await getIntegrationsByProvider("GITLAB", USER, ORG)),
		).toEqual(["gitlab-oauth", "gitlab-pat"]);
		expect(await getIntegrationsByProvider("SLACK", USER, ORG)).toEqual([]);
	});

	it("getConfiguredIntegrations does not present a stored OAuth app as configured", async () => {
		const configured = await getConfiguredIntegrations(USER, ORG);
		expect(configured.map((row) => row.name).sort()).toEqual([
			"GITLAB",
			"GitLab: example-user",
		]);
	});
});
