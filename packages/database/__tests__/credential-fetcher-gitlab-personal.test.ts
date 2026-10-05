/**
 * A GitLab `WorkflowIntegration` row is one person's own GitLab connection
 * (owned by the GitLab connection service). The
 * workflow credential readers return another member's row only when its
 * owner shared it with the organization (`usageScope`); a GitLab connection
 * is never shared, so it resolves only for its owner — even a row marked
 * shared — while another provider's shared row stays usable by members.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
	id: string;
	userId: string | null;
	organizationId: string | null;
	provider: string;
	name: string;
	workflowId: string | null;
	isActive: boolean;
	credentials: string;
	usageScope: "OWNER_ONLY" | "ORGANIZATION_SHARED";
};

const { rows, memberFindFirstMock } = vi.hoisted(() => ({
	rows: [] as Row[],
	memberFindFirstMock: vi.fn(),
}));

/** The subset of Prisma `where` semantics these readers use. */
function matches(row: Row, where: Record<string, unknown>): boolean {
	const value = row as Record<string, unknown>;
	return Object.entries(where).every(([key, expected]) => {
		if (expected === undefined) {
			return true;
		}
		if (key === "OR") {
			return (expected as Array<Record<string, unknown>>).some((clause) =>
				matches(row, clause),
			);
		}
		if (key === "NOT") {
			return !matches(row, expected as Record<string, unknown>);
		}
		if (expected && typeof expected === "object") {
			const filter = expected as { in?: unknown[]; notIn?: unknown[] };
			if (filter.in) {
				return filter.in.includes(value[key]);
			}
			if (filter.notIn) {
				return !filter.notIn.includes(value[key]);
			}
		}
		return value[key] === expected;
	});
}

vi.mock("../prisma/client", () => ({
	db: {
		workflowIntegration: {
			findFirst: vi.fn(
				async (args: { where: Record<string, unknown> }) =>
					rows.find((row) => matches(row, args.where)) ?? null,
			),
		},
		member: { findFirst: memberFindFirstMock },
	},
}));

vi.mock("@repo/utils", () => ({ decryptApiKey: (value: string) => value }));

const {
	fetchCredentialsByIdAndProviderInTenant,
	fetchCredentialsByIdInTenant,
	fetchCredentialsByProvider,
} = await import("../prisma/queries/workflows/credential-fetcher");

function gitlabRow(
	id: string,
	userId: string,
	token: string,
	usageScope: Row["usageScope"] = "OWNER_ONLY",
): Row {
	return {
		id,
		userId,
		organizationId: "org-1",
		provider: "GITLAB",
		name: "GitLab",
		workflowId: null,
		isActive: true,
		usageScope,
		credentials: JSON.stringify({
			access_token: token,
			issuer: {
				kind: "mcp-dcr",
				mcpConfigId: `cfg-${userId}`,
				serverKey: "gitlab-official",
				clientId: "dcr-client",
				origin: "https://gitlab.example.com",
			},
		}),
	};
}

beforeEach(() => {
	rows.length = 0;
	memberFindFirstMock.mockReset();
	memberFindFirstMock.mockResolvedValue({ id: "member-row" });
});

describe("another member's personal GitLab connection", () => {
	beforeEach(() => {
		rows.push(gitlabRow("wi-a", "user-a", "token-of-a"));
	});

	it("is not returned by id to another member", async () => {
		await expect(
			fetchCredentialsByIdInTenant("wi-a", "user-b", "org-1"),
		).resolves.toBeNull();
		await expect(
			fetchCredentialsByIdAndProviderInTenant(
				"wi-a",
				"GITLAB",
				"user-b",
				"org-1",
			),
		).resolves.toBeNull();
	});

	it("is not returned by provider to another member", async () => {
		await expect(
			fetchCredentialsByProvider("GITLAB", "user-b", "org-1"),
		).resolves.toBeNull();
	});

	it("is still returned to its owner", async () => {
		await expect(
			fetchCredentialsByIdAndProviderInTenant(
				"wi-a",
				"GITLAB",
				"user-a",
				"org-1",
			),
		).resolves.toMatchObject({ GITLAB_ACCESS_TOKEN: "token-of-a" });
		await expect(
			fetchCredentialsByProvider("GITLAB", "user-a", "org-1"),
		).resolves.toMatchObject({ GITLAB_ACCESS_TOKEN: "token-of-a" });
	});

	it("does not stop the provider lookup from finding the caller's own row", async () => {
		rows.push(gitlabRow("wi-b", "user-b", "token-of-b"));

		await expect(
			fetchCredentialsByProvider("GITLAB", "user-b", "org-1"),
		).resolves.toMatchObject({ GITLAB_ACCESS_TOKEN: "token-of-b" });
	});
});

describe("a GitLab row marked shared with the organization", () => {
	beforeEach(() => {
		rows.push(
			gitlabRow("wi-a", "user-a", "token-of-a", "ORGANIZATION_SHARED"),
		);
	});

	it("is still not returned to another member, by id or by provider", async () => {
		await expect(
			fetchCredentialsByIdInTenant("wi-a", "user-b", "org-1"),
		).resolves.toBeNull();
		await expect(
			fetchCredentialsByIdAndProviderInTenant(
				"wi-a",
				"GITLAB",
				"user-b",
				"org-1",
			),
		).resolves.toBeNull();
		await expect(
			fetchCredentialsByProvider("GITLAB", "user-b", "org-1"),
		).resolves.toBeNull();
	});

	it("is returned to its owner", async () => {
		await expect(
			fetchCredentialsByProvider("GITLAB", "user-a", "org-1"),
		).resolves.toMatchObject({ GITLAB_ACCESS_TOKEN: "token-of-a" });
	});
});

describe("other providers follow the owner's sharing choice", () => {
	it("resolves another member's shared row by id and by provider", async () => {
		rows.push({
			id: "wi-slack",
			userId: "user-a",
			organizationId: "org-1",
			provider: "SLACK",
			name: "Slack",
			workflowId: null,
			isActive: true,
			usageScope: "ORGANIZATION_SHARED",
			credentials: JSON.stringify({ access_token: "slack-token" }),
		});

		await expect(
			fetchCredentialsByIdInTenant("wi-slack", "user-b", "org-1"),
		).resolves.toEqual({ SLACK_TOKEN: "slack-token" });
		await expect(
			fetchCredentialsByProvider("SLACK", "user-b", "org-1"),
		).resolves.toEqual({ SLACK_TOKEN: "slack-token" });
	});
});
