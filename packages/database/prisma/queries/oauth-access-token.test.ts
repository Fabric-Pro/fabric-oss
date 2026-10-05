/**
 * `verifyOAuthAccessToken` — the one lookup the MCP gateway and the v1 API both
 * make for a signed-in agent — and the revocation that has to make it fail.
 *
 * The prisma client is replaced by an in-memory stand-in for the four tables the
 * lookup touches, so each refusal below is produced by the row that causes it
 * and not by a mock returning the answer the test wants.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	hashOAuthToken,
	OAUTH_ACCESS_TOKEN_PREFIX,
} from "./oauth-token-format";

interface Rows {
	accessTokens: Array<Record<string, unknown>>;
	refreshTokens: Array<Record<string, unknown>>;
	consents: Array<Record<string, unknown>>;
	clients: Array<Record<string, unknown>>;
	users: Array<Record<string, unknown>>;
	members: Array<{ organizationId: string; userId: string }>;
	projects: Array<Record<string, unknown>>;
	projectMembers: Array<{ projectId: string; userId: string }>;
	findUniqueWhere: unknown[];
	deleteOrder: string[];
}

const rows: Rows = {
	accessTokens: [],
	refreshTokens: [],
	consents: [],
	clients: [],
	users: [],
	members: [],
	projects: [],
	projectMembers: [],
	findUniqueWhere: [],
	deleteOrder: [],
};

type Where = Record<string, unknown>;

function isAfter(value: unknown, bound: unknown): boolean {
	return value instanceof Date && bound instanceof Date && value > bound;
}

/** The slice of a Prisma `where` the live-token reads use. */
function matchesLiveToken(row: Where, where: Where): boolean {
	const { expiresAt, revoked, ...equal } = where;
	return (
		Object.entries(equal).every(([key, value]) => row[key] === value) &&
		(expiresAt === undefined ||
			isAfter(row.expiresAt, (expiresAt as { gt: Date }).gt)) &&
		(revoked === undefined || (row.revoked ?? null) === revoked)
	);
}

function distinctGrants(
	tokens: Array<Record<string, unknown>>,
): Array<{ clientId: unknown; referenceId: unknown }> {
	const seen = new Map<string, { clientId: unknown; referenceId: unknown }>();
	for (const token of tokens) {
		seen.set(`${token.clientId}|${token.referenceId}`, {
			clientId: token.clientId,
			referenceId: token.referenceId,
		});
	}
	return [...seen.values()];
}

function matches(
	row: Record<string, unknown>,
	where: Record<string, unknown>,
): boolean {
	return Object.entries(where).every(([key, value]) => row[key] === value);
}

const tables = {
	oauthAccessToken: {
		findUnique: vi.fn(async ({ where }: { where: { token: string } }) => {
			rows.findUniqueWhere.push(where);
			const row = rows.accessTokens.find(
				(token) => token.token === where.token,
			);
			if (!row) {
				return null;
			}
			return {
				...row,
				client: rows.clients.find(
					(client) => client.clientId === row.clientId,
				),
				user: rows.users.find((user) => user.id === row.userId) ?? null,
			};
		}),
		findMany: vi.fn(async ({ where }: { where: Where }) =>
			distinctGrants(
				rows.accessTokens.filter((row) => matchesLiveToken(row, where)),
			),
		),
		deleteMany: vi.fn(
			async ({ where }: { where: Record<string, unknown> }) => {
				rows.deleteOrder.push("access");
				rows.accessTokens = rows.accessTokens.filter(
					(row) => !matches(row, where),
				);
			},
		),
	},
	oauthRefreshToken: {
		findMany: vi.fn(async ({ where }: { where: Where }) =>
			distinctGrants(
				rows.refreshTokens.filter((row) =>
					matchesLiveToken(row, where),
				),
			),
		),
		deleteMany: vi.fn(
			async ({ where }: { where: Record<string, unknown> }) => {
				rows.deleteOrder.push("refresh");
				rows.refreshTokens = rows.refreshTokens.filter(
					(row) => !matches(row, where),
				);
			},
		),
	},
	oauthConsent: {
		findFirst: vi.fn(
			async ({ where }: { where: Record<string, unknown> }) => {
				const row = rows.consents.find((consent) =>
					matches(consent, where),
				);
				return row
					? {
							...row,
							client: rows.clients.find(
								(client) => client.clientId === row.clientId,
							),
						}
					: null;
			},
		),
		findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
			rows.consents
				.filter((consent) => matches(consent, where))
				.map((consent) => ({
					...consent,
					client: rows.clients.find(
						(client) => client.clientId === consent.clientId,
					),
				})),
		),
		delete: vi.fn(async ({ where }: { where: { id: string } }) => {
			rows.deleteOrder.push("consent");
			rows.consents = rows.consents.filter((row) => row.id !== where.id);
		}),
	},
	member: {
		findFirst: vi.fn(
			async ({ where }: { where: Record<string, unknown> }) =>
				rows.members.find((member) => matches(member, where))
					? { id: "member" }
					: null,
		),
	},
	organization: {
		findMany: vi.fn(async () => [
			{ id: "org-example-alpha", name: "Example Alpha" },
		]),
	},
	project: {
		findFirst: vi.fn(async ({ where }: { where: Where }) => {
			const row = rows.projects.find(
				(project) =>
					project.id === where.id &&
					(where.deletedAt !== null || project.deletedAt === null),
			);
			return row ?? null;
		}),
		findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
			return (
				rows.projects.find((project) => project.id === where.id) ?? null
			);
		}),
	},
	projectMember: {
		findFirst: vi.fn(async ({ where }: { where: Where }) =>
			rows.projectMembers.find(
				(member) =>
					member.projectId === where.projectId &&
					member.userId === where.userId,
			)
				? { id: "project-member" }
				: null,
		),
	},
};

vi.mock("../client", () => ({
	db: {
		...tables,
		$transaction: (work: (tx: typeof tables) => Promise<unknown>) =>
			work(tables),
	},
}));

const { listOAuthConnections, revokeOAuthConnection, verifyOAuthAccessToken } =
	await import("./oauth-access-token");

const NOW = new Date("2026-10-02T12:00:00Z");
const TOKEN = "secret-token-value";
const PRESENTED = `${OAUTH_ACCESS_TOKEN_PREFIX}${TOKEN}`;

beforeEach(() => {
	rows.accessTokens = [
		{
			id: "token-1",
			token: hashOAuthToken(TOKEN),
			clientId: "client-1",
			userId: "user-1",
			referenceId: "org-example-alpha",
			scopes: ["mcp:read", "instructions:read"],
			expiresAt: new Date(NOW.getTime() + 60_000),
		},
	];
	rows.refreshTokens = [
		{
			id: "refresh-1",
			clientId: "client-1",
			userId: "user-1",
			referenceId: "org-example-alpha",
		},
	];
	rows.clients = [
		{
			id: "client-row-1",
			clientId: "client-1",
			name: "Example Agent",
			disabled: false,
		},
	];
	rows.users = [
		{
			id: "user-1",
			name: "Dev",
			email: "dev@example.com",
			role: "user",
			banned: false,
			banExpires: null,
		},
	];
	rows.members = [{ organizationId: "org-example-alpha", userId: "user-1" }];
	rows.projects = [
		{
			id: "project-example-one",
			name: "Example Project",
			userId: "user-1",
			organizationId: "org-example-alpha",
			deletedAt: null,
			organization: { name: "Example Alpha", deletedAt: null },
		},
	];
	rows.projectMembers = [];
	rows.consents = [
		{
			id: "consent-1",
			clientId: "client-1",
			userId: "user-1",
			referenceId: "org-example-alpha",
			scopes: ["mcp:read"],
			createdAt: NOW,
		},
	];
	rows.findUniqueWhere = [];
	rows.deleteOrder = [];
	vi.clearAllMocks();
});

describe("verifying a presented access token", () => {
	it("returns the owner, the organization the token is bound to and its scopes", async () => {
		const result = await verifyOAuthAccessToken(PRESENTED, NOW);

		expect(result).toEqual({
			valid: true,
			tokenId: "token-1",
			clientRowId: "client-row-1",
			clientName: "Example Agent",
			userId: "user-1",
			userName: "Dev",
			email: "dev@example.com",
			role: "user",
			organizationId: "org-example-alpha",
			projectId: null,
			audience: null,
			scopes: ["mcp:read", "instructions:read"],
		});
	});

	it("looks the token up by its digest and never by the token", async () => {
		await verifyOAuthAccessToken(PRESENTED, NOW);

		expect(rows.findUniqueWhere).toEqual([
			{ token: hashOAuthToken(TOKEN) },
		]);
	});

	it("does not touch the database for a value that is not an access token", async () => {
		for (const other of ["fab_key", "org_key", "garbage", ""]) {
			expect(await verifyOAuthAccessToken(other, NOW)).toEqual({
				valid: false,
				reason: "unknown",
			});
		}
		expect(tables.oauthAccessToken.findUnique).not.toHaveBeenCalled();
	});

	it("refuses an unknown token", async () => {
		expect(
			await verifyOAuthAccessToken(
				`${OAUTH_ACCESS_TOKEN_PREFIX}other`,
				NOW,
			),
		).toEqual({
			valid: false,
			reason: "unknown",
		});
	});

	it("refuses an expired token", async () => {
		rows.accessTokens[0].expiresAt = new Date(NOW.getTime() - 1);

		expect(await verifyOAuthAccessToken(PRESENTED, NOW)).toEqual({
			valid: false,
			reason: "expired",
		});
	});

	it("refuses a token whose client was disabled", async () => {
		rows.clients[0].disabled = true;

		expect(await verifyOAuthAccessToken(PRESENTED, NOW)).toEqual({
			valid: false,
			reason: "client_disabled",
		});
	});

	it("refuses a token once its owner is no longer a member of the bound organization", async () => {
		rows.members = [];

		expect(await verifyOAuthAccessToken(PRESENTED, NOW)).toEqual({
			valid: false,
			reason: "not_a_member",
		});
	});

	it("refuses a token for a user who is banned, until the ban lapses", async () => {
		rows.users[0].banned = true;
		rows.users[0].banExpires = null;
		expect(await verifyOAuthAccessToken(PRESENTED, NOW)).toEqual({
			valid: false,
			reason: "user_banned",
		});

		rows.users[0].banExpires = new Date(NOW.getTime() - 1000);
		expect((await verifyOAuthAccessToken(PRESENTED, NOW)).valid).toBe(true);
	});

	it("refuses a token that is bound to no organization", async () => {
		rows.accessTokens[0].referenceId = null;

		expect(await verifyOAuthAccessToken(PRESENTED, NOW)).toEqual({
			valid: false,
			reason: "no_organization",
		});
	});

	it("refuses a token whose owner no longer exists", async () => {
		rows.users = [];

		expect(await verifyOAuthAccessToken(PRESENTED, NOW)).toEqual({
			valid: false,
			reason: "unknown",
		});
	});
});

describe("revoking a connected agent", () => {
	it("deletes the tokens, then the consent, and keeps the client registration", async () => {
		const revoked = await revokeOAuthConnection({
			userId: "user-1",
			consentId: "consent-1",
		});

		expect(revoked).toEqual({
			clientId: "client-1",
			clientName: "Example Agent",
			organizationId: "org-example-alpha",
			projectId: null,
		});
		expect(rows.deleteOrder).toEqual(["access", "refresh", "consent"]);
		expect(rows.accessTokens).toHaveLength(0);
		expect(rows.refreshTokens).toHaveLength(0);
		expect(rows.consents).toHaveLength(0);
		// The agent signs in again with the client_id it already holds.
		expect(rows.clients).toHaveLength(1);
	});

	it("makes the revoked token fail at the next request", async () => {
		expect((await verifyOAuthAccessToken(PRESENTED, NOW)).valid).toBe(true);

		await revokeOAuthConnection({
			userId: "user-1",
			consentId: "consent-1",
		});

		expect(await verifyOAuthAccessToken(PRESENTED, NOW)).toEqual({
			valid: false,
			reason: "unknown",
		});
	});

	it("keeps the client and its other organizations' tokens when only one consent goes", async () => {
		rows.consents.push({
			id: "consent-2",
			clientId: "client-1",
			userId: "user-1",
			referenceId: "org-example-beta",
			scopes: ["mcp:read"],
			createdAt: NOW,
		});
		rows.accessTokens.push({
			id: "token-2",
			token: hashOAuthToken("beta"),
			clientId: "client-1",
			userId: "user-1",
			referenceId: "org-example-beta",
			scopes: ["mcp:read"],
			expiresAt: new Date(NOW.getTime() + 60_000),
		});

		await revokeOAuthConnection({
			userId: "user-1",
			consentId: "consent-1",
		});

		expect(rows.clients).toHaveLength(1);
		expect(rows.accessTokens.map((token) => token.id)).toEqual(["token-2"]);
		expect(rows.consents.map((consent) => consent.id)).toEqual([
			"consent-2",
		]);
	});

	it("treats another user's consent exactly like one that does not exist", async () => {
		expect(
			await revokeOAuthConnection({
				userId: "user-2",
				consentId: "consent-1",
			}),
		).toBeNull();
		expect(
			await revokeOAuthConnection({
				userId: "user-1",
				consentId: "missing",
			}),
		).toBeNull();
		expect(rows.consents).toHaveLength(1);
		expect(rows.accessTokens).toHaveLength(1);
	});
});

describe("listing connected agents", () => {
	it("names the client and the organization each consent was given for", async () => {
		expect(await listOAuthConnections("user-1", NOW)).toEqual([
			{
				consentId: "consent-1",
				clientName: "Example Agent",
				organizationId: "org-example-alpha",
				organizationName: "Example Alpha",
				projectId: null,
				projectName: null,
				audience: null,
				scopes: ["mcp:read"],
				createdAt: NOW,
			},
		]);
	});

	it("lists nothing for a user with no consent", async () => {
		expect(await listOAuthConnections("user-2", NOW)).toEqual([]);
	});

	it("names the project and its organization for a project grant", async () => {
		rows.consents = [
			{
				id: "consent-project",
				clientId: "client-1",
				userId: "user-1",
				referenceId: "project:mcp:project-example-one",
				scopes: ["mcp:read"],
				createdAt: NOW,
			},
		];
		rows.accessTokens[0].referenceId = "project:mcp:project-example-one";

		expect(await listOAuthConnections("user-1", NOW)).toEqual([
			{
				consentId: "consent-project",
				clientName: "Example Agent",
				organizationId: "org-example-alpha",
				organizationName: "Example Alpha",
				projectId: "project-example-one",
				projectName: "Example Project",
				audience: "mcp",
				scopes: ["mcp:read"],
				createdAt: NOW,
			},
		]);
	});

	it("keeps a project grant listed but unnamed once its owner can no longer read the project", async () => {
		rows.consents[0].referenceId = "project:api:project-example-one";
		rows.accessTokens[0].referenceId = "project:api:project-example-one";
		rows.projects[0].userId = "someone-else";

		const [connection] = await listOAuthConnections("user-1", NOW);

		expect(connection).toMatchObject({
			projectId: "project-example-one",
			projectName: null,
			organizationName: null,
			audience: "api",
		});
	});

	it("lists one row per grant when a client holds an organization and a project grant", async () => {
		rows.consents.push({
			id: "consent-project",
			clientId: "client-1",
			userId: "user-1",
			referenceId: "project:mcp:project-example-one",
			scopes: ["mcp:read"],
			createdAt: NOW,
		});
		rows.refreshTokens.push({
			id: "refresh-project",
			clientId: "client-1",
			userId: "user-1",
			referenceId: "project:mcp:project-example-one",
			revoked: null,
			expiresAt: new Date(NOW.getTime() + 60_000),
		});

		const connections = await listOAuthConnections("user-1", NOW);

		expect(connections.map((connection) => connection.consentId)).toEqual([
			"consent-1",
			"consent-project",
		]);
	});

	describe("hides a consent that nothing can still sign in with", () => {
		it("when its access token has expired and it has no refresh token", async () => {
			rows.accessTokens[0].expiresAt = new Date(NOW.getTime() - 1);
			rows.refreshTokens = [];

			expect(await listOAuthConnections("user-1", NOW)).toEqual([]);
		});

		it("when its refresh token was spent or has expired", async () => {
			rows.accessTokens = [];
			rows.refreshTokens = [
				{
					id: "refresh-spent",
					clientId: "client-1",
					userId: "user-1",
					referenceId: "org-example-alpha",
					revoked: NOW,
					expiresAt: new Date(NOW.getTime() + 60_000),
				},
				{
					id: "refresh-expired",
					clientId: "client-1",
					userId: "user-1",
					referenceId: "org-example-alpha",
					revoked: null,
					expiresAt: new Date(NOW.getTime() - 1),
				},
			];

			expect(await listOAuthConnections("user-1", NOW)).toEqual([]);
		});

		it("but lists it while only the refresh token is live", async () => {
			rows.accessTokens[0].expiresAt = new Date(NOW.getTime() - 1);
			rows.refreshTokens = [
				{
					id: "refresh-live",
					clientId: "client-1",
					userId: "user-1",
					referenceId: "org-example-alpha",
					revoked: null,
					expiresAt: new Date(NOW.getTime() + 60_000),
				},
			];

			expect(await listOAuthConnections("user-1", NOW)).toHaveLength(1);
		});

		it("when the live token belongs to another organization's grant of the same client", async () => {
			rows.accessTokens[0].referenceId = "org-example-beta";

			expect(await listOAuthConnections("user-1", NOW)).toEqual([]);
		});
	});
});

describe("verifying a project grant", () => {
	beforeEach(() => {
		rows.accessTokens[0].referenceId = "project:mcp:project-example-one";
	});

	it("returns the project, its audience and the organization hosting it", async () => {
		const result = await verifyOAuthAccessToken(PRESENTED, NOW);

		expect(result).toMatchObject({
			valid: true,
			userId: "user-1",
			organizationId: "org-example-alpha",
			projectId: "project-example-one",
			audience: "mcp",
		});
	});

	it("carries the API audience of an API grant", async () => {
		rows.accessTokens[0].referenceId = "project:api:project-example-one";

		expect(await verifyOAuthAccessToken(PRESENTED, NOW)).toMatchObject({
			valid: true,
			projectId: "project-example-one",
			audience: "api",
		});
	});

	it("admits a guest who holds a project membership and none in the organization", async () => {
		rows.members = [];
		rows.projects[0].userId = "someone-else";
		rows.projectMembers = [
			{ projectId: "project-example-one", userId: "user-1" },
		];

		expect((await verifyOAuthAccessToken(PRESENTED, NOW)).valid).toBe(true);
	});

	it("refuses once its owner can no longer read the project", async () => {
		rows.projects[0].userId = "someone-else";

		expect(await verifyOAuthAccessToken(PRESENTED, NOW)).toEqual({
			valid: false,
			reason: "not_a_member",
		});
	});

	it("refuses once the organization membership behind the project access is gone", async () => {
		rows.members = [];

		expect(await verifyOAuthAccessToken(PRESENTED, NOW)).toEqual({
			valid: false,
			reason: "not_a_member",
		});
	});

	it("refuses a deleted project, a missing project and a deleted organization alike", async () => {
		rows.projects[0].deletedAt = NOW;
		expect(await verifyOAuthAccessToken(PRESENTED, NOW)).toEqual({
			valid: false,
			reason: "not_a_member",
		});

		rows.projects[0].deletedAt = null;
		rows.projects[0].organization = {
			name: "Example Alpha",
			deletedAt: NOW,
		};
		expect(await verifyOAuthAccessToken(PRESENTED, NOW)).toEqual({
			valid: false,
			reason: "not_a_member",
		});

		rows.projects = [];
		expect(await verifyOAuthAccessToken(PRESENTED, NOW)).toEqual({
			valid: false,
			reason: "not_a_member",
		});
	});

	it("refuses a project reference that is not well formed rather than reading it as an organization", async () => {
		for (const referenceId of [
			"project:",
			"project:mcp",
			"project:web:project-example-one",
			"project:mcp:a/b",
		]) {
			rows.accessTokens[0].referenceId = referenceId;

			expect(
				await verifyOAuthAccessToken(PRESENTED, NOW),
				referenceId,
			).toEqual({ valid: false, reason: "no_organization" });
		}
	});
});

describe("revoking a project grant", () => {
	beforeEach(() => {
		rows.consents[0].referenceId = "project:mcp:project-example-one";
		rows.accessTokens[0].referenceId = "project:mcp:project-example-one";
		rows.refreshTokens[0].referenceId = "project:mcp:project-example-one";
	});

	it("names the project and the organization hosting it for the audit row", async () => {
		expect(
			await revokeOAuthConnection({
				userId: "user-1",
				consentId: "consent-1",
			}),
		).toEqual({
			clientId: "client-1",
			clientName: "Example Agent",
			organizationId: "org-example-alpha",
			projectId: "project-example-one",
		});
	});

	it("leaves the same client's organization grant alone", async () => {
		rows.consents.push({
			id: "consent-org",
			clientId: "client-1",
			userId: "user-1",
			referenceId: "org-example-alpha",
			scopes: ["mcp:read"],
			createdAt: NOW,
		});
		rows.accessTokens.push({
			id: "token-org",
			token: hashOAuthToken("organization"),
			clientId: "client-1",
			userId: "user-1",
			referenceId: "org-example-alpha",
			scopes: ["mcp:read"],
			expiresAt: new Date(NOW.getTime() + 60_000),
		});

		await revokeOAuthConnection({
			userId: "user-1",
			consentId: "consent-1",
		});

		expect(rows.accessTokens.map((token) => token.id)).toEqual([
			"token-org",
		]);
		expect(rows.consents.map((consent) => consent.id)).toEqual([
			"consent-org",
		]);
	});
});
