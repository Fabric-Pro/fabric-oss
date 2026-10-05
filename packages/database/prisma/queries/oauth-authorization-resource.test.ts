/**
 * What an authorization asked to be bound to is written down at the first
 * request and read back at consent, for as long as the authorization lives and
 * not a moment after. A live row is written once.
 *
 * The prisma client is replaced by an in-memory stand-in for the one table, so
 * expiry and cleanup are decided by the rows and not by a mock returning the
 * answer the test wants.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
	id: string;
	clientId: string;
	codeChallenge: string;
	resource: string;
	projectId: string;
	audience: string;
	createdAt: Date;
	expiresAt: Date;
}

const NOW = new Date("2026-10-04T12:00:00Z");
const AT = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

let rows: Row[] = [];
let nextId = 1;
/** The instant the database stamps on a row it inserts. */
let clock = NOW;

type Key = { clientId: string; codeChallenge: string };

const table = {
	createMany: vi.fn(
		async ({
			data,
			skipDuplicates,
		}: {
			data: Array<Omit<Row, "id" | "createdAt">>;
			skipDuplicates: boolean;
		}) => {
			for (const entry of data) {
				const taken = rows.some(
					(row) =>
						row.clientId === entry.clientId &&
						row.codeChallenge === entry.codeChallenge,
				);
				if (taken && !skipDuplicates) {
					throw new Error("unique constraint");
				}
				if (!taken) {
					rows.push({
						...entry,
						id: `row-${nextId++}`,
						createdAt: clock,
					});
				}
			}
		},
	),
	findUnique: vi.fn(
		async ({ where }: { where: { clientId_codeChallenge: Key } }) =>
			rows.find(
				(row) =>
					row.clientId === where.clientId_codeChallenge.clientId &&
					row.codeChallenge ===
						where.clientId_codeChallenge.codeChallenge,
			) ?? null,
	),
	findMany: vi.fn(
		async ({
			where,
			take,
		}: {
			where: { expiresAt: { lt: Date } };
			take: number;
		}) =>
			rows
				.filter((row) => row.expiresAt < where.expiresAt.lt)
				.slice(0, take)
				.map((row) => ({ id: row.id })),
	),
	deleteMany: vi.fn(
		async ({
			where,
		}: {
			where: {
				id?: { in: string[] };
				expiresAt?: { lte: Date };
			} & Partial<Key>;
		}) => {
			rows = rows.filter(
				(row) =>
					!(
						(where.id === undefined ||
							where.id.in.includes(row.id)) &&
						(where.expiresAt === undefined ||
							row.expiresAt <= where.expiresAt.lte) &&
						(where.clientId === undefined ||
							row.clientId === where.clientId) &&
						(where.codeChallenge === undefined ||
							row.codeChallenge === where.codeChallenge)
					),
			);
		},
	),
	updateMany: vi.fn(
		async ({
			where,
			data,
		}: {
			where: Key & { expiresAt: { gt: Date } };
			data: { expiresAt: Date };
		}) => {
			for (const row of rows) {
				if (
					row.clientId === where.clientId &&
					row.codeChallenge === where.codeChallenge &&
					row.expiresAt > where.expiresAt.gt
				) {
					row.expiresAt = data.expiresAt;
				}
			}
		},
	),
};

vi.mock("../client", () => ({ db: { oauthAuthorizationResource: table } }));

const queries = await import("./oauth-authorization-resource");
const {
	extendOAuthAuthorizationResource,
	findLiveOAuthAuthorizationResource,
	OAUTH_AUTHORIZATION_RESOURCE_MAX_LIFETIME_MS,
	OAUTH_AUTHORIZATION_RESOURCE_TTL_MS,
	saveOAuthAuthorizationResource,
} = queries;

const BINDING = {
	clientId: "client-1",
	codeChallenge: "challenge-1",
	resource: "https://app.example.com/api/mcp-gateway/projects/project-one",
	projectId: "project-one",
	audience: "mcp" as const,
};

beforeEach(() => {
	rows = [];
	nextId = 1;
	clock = NOW;
	vi.clearAllMocks();
});

function saveAt(params: typeof BINDING, at: Date) {
	clock = at;
	return saveOAuthAuthorizationResource(params, at);
}

describe("saving what an authorization asked for", () => {
	it("is read back as the project and audience until it expires", async () => {
		await saveOAuthAuthorizationResource(BINDING, NOW);

		expect(
			await findLiveOAuthAuthorizationResource(
				"client-1",
				"challenge-1",
				NOW,
			),
		).toEqual({
			resource: BINDING.resource,
			projectId: "project-one",
			audience: "mcp",
		});
		expect(
			await findLiveOAuthAuthorizationResource(
				"client-1",
				"challenge-1",
				AT(OAUTH_AUTHORIZATION_RESOURCE_TTL_MS - 1),
			),
		).not.toBeNull();
		expect(
			await findLiveOAuthAuthorizationResource(
				"client-1",
				"challenge-1",
				AT(OAUTH_AUTHORIZATION_RESOURCE_TTL_MS),
			),
		).toBeNull();
	});

	it("outlives the plugin's ten-minute signed query", () => {
		expect(OAUTH_AUTHORIZATION_RESOURCE_TTL_MS).toBeGreaterThan(
			10 * 60 * 1000,
		);
	});

	it("is found only by the client and the challenge that wrote it", async () => {
		await saveOAuthAuthorizationResource(BINDING, NOW);

		expect(
			await findLiveOAuthAuthorizationResource(
				"client-2",
				"challenge-1",
				NOW,
			),
		).toBeNull();
		expect(
			await findLiveOAuthAuthorizationResource(
				"client-1",
				"challenge-2",
				NOW,
			),
		).toBeNull();
	});

	it("answers with the binding it wrote", async () => {
		expect(await saveOAuthAuthorizationResource(BINDING, NOW)).toEqual({
			resource: BINDING.resource,
			projectId: "project-one",
			audience: "mcp",
		});
	});

	it("keeps a live binding when another project is asked for with the same key, and answers with the one that stands", async () => {
		await saveOAuthAuthorizationResource(BINDING, NOW);

		const standing = await saveOAuthAuthorizationResource(
			{
				...BINDING,
				projectId: "project-two",
				resource:
					"https://app.example.com/api/mcp-gateway/projects/project-two",
			},
			AT(1000),
		);

		expect(standing).toMatchObject({ projectId: "project-one" });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			projectId: "project-one",
			createdAt: NOW,
			expiresAt: AT(OAUTH_AUTHORIZATION_RESOURCE_TTL_MS),
		});
	});

	it("keeps a live binding when the other audience is asked for", async () => {
		await saveOAuthAuthorizationResource(BINDING, NOW);

		const standing = await saveOAuthAuthorizationResource(
			{ ...BINDING, audience: "api" },
			AT(1000),
		);

		expect(standing).toMatchObject({ audience: "mcp" });
	});

	it("replaces a binding that has expired, like none at all", async () => {
		await saveAt(BINDING, NOW);
		const later = AT(OAUTH_AUTHORIZATION_RESOURCE_TTL_MS + 1000);

		const standing = await saveAt(
			{
				...BINDING,
				projectId: "project-two",
				resource:
					"https://app.example.com/api/mcp-gateway/projects/project-two",
			},
			later,
		);

		expect(standing).toMatchObject({ projectId: "project-two" });
		expect(rows).toHaveLength(1);
		expect(rows[0].createdAt).toEqual(later);
	});

	it("reads a row with an audience it does not know as no binding", async () => {
		await saveOAuthAuthorizationResource(BINDING, NOW);
		rows[0].audience = "web";

		expect(
			await findLiveOAuthAuthorizationResource(
				"client-1",
				"challenge-1",
				NOW,
			),
		).toBeNull();
	});
});

describe("tidying expired bindings as new ones are written", () => {
	it("removes the expired rows and keeps the live ones", async () => {
		await saveOAuthAuthorizationResource(
			{ ...BINDING, clientId: "old-client" },
			AT(-2 * OAUTH_AUTHORIZATION_RESOURCE_TTL_MS),
		);

		await saveOAuthAuthorizationResource(BINDING, NOW);

		expect(rows.map((row) => row.clientId)).toEqual(["client-1"]);
	});

	it("removes a bounded batch per write, never the whole table", async () => {
		for (let index = 0; index < 120; index += 1) {
			rows.push({
				id: `stale-${index}`,
				clientId: `stale-${index}`,
				codeChallenge: "challenge",
				resource: BINDING.resource,
				projectId: "project-one",
				audience: "mcp",
				createdAt: AT(-OAUTH_AUTHORIZATION_RESOURCE_TTL_MS * 3),
				expiresAt: AT(-OAUTH_AUTHORIZATION_RESOURCE_TTL_MS * 2),
			});
		}

		await saveOAuthAuthorizationResource(BINDING, NOW);

		expect(rows.filter((row) => row.id.startsWith("stale-"))).toHaveLength(
			70,
		);
		expect(
			await findLiveOAuthAuthorizationResource(
				"client-1",
				"challenge-1",
				NOW,
			),
		).not.toBeNull();
	});
});

describe("keeping a binding alive", () => {
	it("pushes a live binding's expiry out", async () => {
		await saveOAuthAuthorizationResource(BINDING, NOW);
		const later = AT(OAUTH_AUTHORIZATION_RESOURCE_TTL_MS - 1000);

		await extendOAuthAuthorizationResource(
			"client-1",
			"challenge-1",
			later,
		);

		expect(
			await findLiveOAuthAuthorizationResource(
				"client-1",
				"challenge-1",
				AT(OAUTH_AUTHORIZATION_RESOURCE_TTL_MS + 1000),
			),
		).not.toBeNull();
	});

	it("leaves a lapsed binding lapsed", async () => {
		await saveOAuthAuthorizationResource(BINDING, NOW);
		const lapsed = AT(OAUTH_AUTHORIZATION_RESOURCE_TTL_MS + 1000);

		await extendOAuthAuthorizationResource(
			"client-1",
			"challenge-1",
			lapsed,
		);

		expect(
			await findLiveOAuthAuthorizationResource(
				"client-1",
				"challenge-1",
				lapsed,
			),
		).toBeNull();
	});
});

describe("how long a binding may be kept alive", () => {
	it("is never extended past thirty minutes after it was written", async () => {
		await saveAt(BINDING, NOW);

		let at = NOW;
		for (let step = 0; step < 10; step += 1) {
			at = AT(
				(step + 1) * (OAUTH_AUTHORIZATION_RESOURCE_TTL_MS - 60 * 1000),
			);
			await extendOAuthAuthorizationResource(
				"client-1",
				"challenge-1",
				at,
			);
		}

		expect(rows[0].expiresAt).toEqual(
			AT(OAUTH_AUTHORIZATION_RESOURCE_MAX_LIFETIME_MS),
		);
		expect(
			await findLiveOAuthAuthorizationResource(
				"client-1",
				"challenge-1",
				AT(OAUTH_AUTHORIZATION_RESOURCE_MAX_LIFETIME_MS),
			),
		).toBeNull();
	});

	it("is extended to the full lifetime while the cap is not reached", async () => {
		await saveAt(BINDING, NOW);
		const later = AT(5 * 60 * 1000);

		await extendOAuthAuthorizationResource(
			"client-1",
			"challenge-1",
			later,
		);

		expect(rows[0].expiresAt).toEqual(
			new Date(later.getTime() + OAUTH_AUTHORIZATION_RESOURCE_TTL_MS),
		);
	});

	it("is never shortened by an extension", async () => {
		await saveAt(BINDING, NOW);
		const before = rows[0].expiresAt;

		await extendOAuthAuthorizationResource(
			"client-1",
			"challenge-1",
			AT(-60 * 1000),
		);

		expect(rows[0].expiresAt).toEqual(before);
		expect(table.updateMany).not.toHaveBeenCalled();
	});

	it("allows a cap longer than the lifetime of one extension", () => {
		expect(OAUTH_AUTHORIZATION_RESOURCE_MAX_LIFETIME_MS).toBeGreaterThan(
			OAUTH_AUTHORIZATION_RESOURCE_TTL_MS,
		);
	});
});

describe("nothing but expiry removes a live binding", () => {
	it("is not removed by writing, extending or reading another binding of the same key", async () => {
		await saveOAuthAuthorizationResource(BINDING, NOW);

		await saveOAuthAuthorizationResource(
			{ ...BINDING, projectId: "project-two" },
			AT(1000),
		);
		await extendOAuthAuthorizationResource(
			"client-1",
			"challenge-1",
			AT(2000),
		);
		await findLiveOAuthAuthorizationResource(
			"client-1",
			"challenge-1",
			AT(3000),
		);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ projectId: "project-one" });
		for (const [call] of table.deleteMany.mock.calls) {
			expect(call.where.expiresAt ?? call.where.id).toBeDefined();
		}
	});

	it("is not given a way out: the module exports no function that deletes a binding by its key", () => {
		expect(Object.keys(queries).sort()).toEqual([
			"OAUTH_AUTHORIZATION_RESOURCE_MAX_LIFETIME_MS",
			"OAUTH_AUTHORIZATION_RESOURCE_TTL_MS",
			"extendOAuthAuthorizationResource",
			"findLiveOAuthAuthorizationResource",
			"saveOAuthAuthorizationResource",
		]);
	});
});
