/**
 * `GET /integrations` lists the providers connected for the caller's tenant.
 *
 * A stored OAuth app (`<PROVIDER>_OAUTH_APP`, the client id and secret an admin
 * saved) is a `WorkflowIntegration` with the same provider, user and
 * organization as a connection. Listed as one, it reported a provider nobody
 * had connected as `connected`, while the credential store (which does exclude
 * it) found nothing to execute with.
 *
 * The store applies the route's real `where` clause to real rows, so the
 * assertions are about which providers come back, not about the clause text.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { store } = await vi.hoisted(async () => {
	const { createWorkflowIntegrationStore } = await import(
		"../../integrations/__tests__/procedures/workflow-integration-store"
	);
	return { store: createWorkflowIntegrationStore() };
});

vi.mock("@repo/database", () => ({
	db: { workflowIntegration: store.delegate },
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_c: unknown, next: () => Promise<void>) =>
		next(),
}));

vi.mock("../helpers", () => ({
	resolveV1Context: vi.fn(async () => ({
		userId: "user-1",
		organizationId: "org-example",
	})),
	ok: (data: unknown) => ({ data }),
	badRequest: vi.fn(),
	notFound: vi.fn(),
}));

const { registerIntegrationRoutes } = await import("../integrations");

type Row = Parameters<typeof store.rows.push>[0];

function seed(row: Partial<Row> & Pick<Row, "provider" | "name">) {
	store.rows.push({
		id: `row-${store.rows.length + 1}`,
		userId: "user-1",
		organizationId: "org-example",
		isActive: true,
		credentials: "encrypted",
		lastUsedAt: null,
		...row,
	});
}

async function listSlugs(): Promise<string[]> {
	const app = new Hono();
	registerIntegrationRoutes(app as never);
	const response = await app.request("/integrations");
	expect(response.status).toBe(200);
	const body = (await response.json()) as {
		data: Array<{ slug: string; status: string }>;
	};
	return body.data.map((entry) => entry.slug).sort();
}

beforeEach(() => {
	store.reset();
});

describe("GET /integrations", () => {
	it("does not report a provider as connected when only its stored OAuth app exists", async () => {
		seed({ provider: "SLACK", name: "SLACK_OAUTH_APP" });
		seed({ provider: "GITHUB", name: "GITHUB_OAUTH_APP" });

		expect(await listSlugs()).toEqual([]);
	});

	it("still lists a provider that has a real connection beside its OAuth app", async () => {
		seed({ provider: "SLACK", name: "SLACK_OAUTH_APP" });
		seed({ provider: "SLACK", name: "Slack: Example Workspace" });
		seed({ provider: "LINEAR", name: "LINEAR" });

		expect(await listSlugs()).toEqual(["linear", "slack"]);
	});

	it("excludes by exact name: a connection whose name merely ends in _OAUTH_APP is listed", async () => {
		seed({ provider: "NOTION", name: "Notion: team_OAUTH_APP" });

		expect(await listSlugs()).toEqual(["notion"]);
	});
});
