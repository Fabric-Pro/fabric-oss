import { createHash } from "node:crypto";
import { Client } from "pg";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock("../prisma/client", () => ({ db: { $queryRaw: queryRaw } }));

import {
	getContextQualitySourceMetadata,
	readContextQualitySourceBody,
} from "../prisma/queries/projects/context-quality-body";

const scope = {
	sourceId: "example-source",
	projectId: "example-project",
	organizationId: "example-org",
};
const configuredUrl = process.env.CONTEXT_QUALITY_SQL_TEST_URL;

describe("context quality database read admission", () => {
	beforeEach(() => {
		queryRaw.mockReset();
	});
	it("fails closed on an absent organization before database access", async () => {
		await expect(
			getContextQualitySourceMetadata({ ...scope, organizationId: "" }),
		).resolves.toBeNull();
		await expect(
			readContextQualitySourceBody({
				...scope,
				organizationId: "",
				maxBytes: 100,
			}),
		).resolves.toEqual({
			content: "",
			truncated: false,
			hasReadableText: false,
		});
		expect(queryRaw).not.toHaveBeenCalled();
	});
	it.each([0, -1, 1.5, 96 * 1024 + 1, Number.POSITIVE_INFINITY])(
		"refuses unsafe byte ceiling %s before database access",
		async (maxBytes) => {
			await expect(
				readContextQualitySourceBody({ ...scope, maxBytes }),
			).rejects.toThrow("Invalid context quality body byte limit");
			expect(queryRaw).not.toHaveBeenCalled();
		},
	);
});

/**
 * Opt-in PostgreSQL contract test. Only a loopback database is accepted. All
 * fixtures live in session-local TEMP tables; production tables are never
 * inserted into or altered. The actual parameterized helper SQL runs through
 * pg, independently of Prisma mocks' interpretation of its predicates. This
 * validates SQL/byte/format behavior, not application-role RLS certification.
 */
describe.skipIf(!configuredUrl)(
	"bounded canonical context body SQL on PostgreSQL",
	() => {
		let client: Client;
		beforeAll(async () => {
			if (
				!configuredUrl ||
				!["localhost", "127.0.0.1", "[::1]"].includes(
					new URL(configuredUrl).hostname,
				)
			) {
				throw new Error(
					"Context quality SQL tests require an explicitly configured loopback database",
				);
			}
			client = new Client({ connectionString: configuredUrl });
			await client.connect();
			await client.query(`
			CREATE TEMP TABLE project_context (
				id text PRIMARY KEY, "projectId" text NOT NULL, "organizationId" text NOT NULL,
				type text NOT NULL DEFAULT 'TEXT', "urlScope" text,
				content text NOT NULL DEFAULT '', "extractionStatus" text NOT NULL DEFAULT 'COMPLETED',
				"indexingExcluded" boolean NOT NULL DEFAULT false, "updatedAt" timestamptz NOT NULL DEFAULT now(),
				"sourceTitle" text, "originalFilename" text, metadata jsonb
			);
			CREATE TEMP TABLE project_context_url_page (
				id text PRIMARY KEY, "parentContextId" text NOT NULL, "projectId" text NOT NULL,
				"organizationId" text NOT NULL, "pageUrl" text NOT NULL, "pageTitle" text,
				content text NOT NULL
			);
			CREATE TEMP TABLE project_context_conversation_bundle (
				id text PRIMARY KEY, "parentContextId" text NOT NULL, "projectId" text NOT NULL,
				"organizationId" text NOT NULL, content text NOT NULL, "bundleStartedAt" timestamptz NOT NULL
			);
		`);
		});
		afterAll(async () => {
			await client?.end();
		});
		beforeEach(async () => {
			await client.query(
				"TRUNCATE pg_temp.project_context, pg_temp.project_context_url_page, pg_temp.project_context_conversation_bundle",
			);
			queryRaw.mockImplementation(
				async (strings: TemplateStringsArray, ...values: unknown[]) => {
					const text = strings.reduce(
						(sql, part, index) =>
							sql +
							part +
							(index < values.length ? `$${index + 1}` : ""),
						"",
					);
					return (await client.query(text, values)).rows;
				},
			);
		});

		async function parent(
			overrides: {
				type?: string;
				urlScope?: string;
				content?: string;
				metadata?: unknown;
				title?: string;
				extractionStatus?: string;
			} = {},
		) {
			await client.query(
				`INSERT INTO pg_temp.project_context
			(id, "projectId", "organizationId", type, "urlScope", content, metadata, "sourceTitle", "extractionStatus")
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
				[
					scope.sourceId,
					scope.projectId,
					scope.organizationId,
					overrides.type ?? "TEXT",
					overrides.urlScope ?? null,
					overrides.content ?? "",
					JSON.stringify(overrides.metadata ?? {}),
					overrides.title ?? "Example source",
					overrides.extractionStatus ?? "COMPLETED",
				],
			);
		}

		async function page(
			id: string,
			url: string,
			content: string,
			title: string | null = null,
			organizationId = scope.organizationId,
			projectId = scope.projectId,
		) {
			await client.query(
				`INSERT INTO pg_temp.project_context_url_page (id,"parentContextId","projectId","organizationId","pageUrl","pageTitle",content) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				[
					id,
					scope.sourceId,
					projectId,
					organizationId,
					url,
					title,
					content,
				],
			);
		}

		async function bundle(
			id: string,
			content: string,
			started: string,
			organizationId = scope.organizationId,
			projectId = scope.projectId,
		) {
			await client.query(
				`INSERT INTO pg_temp.project_context_conversation_bundle (id,"parentContextId","projectId","organizationId",content,"bundleStartedAt") VALUES ($1,$2,$3,$4,$5,$6)`,
				[
					id,
					scope.sourceId,
					projectId,
					organizationId,
					content,
					started,
				],
			);
		}

		it("metadata never transfers the full source, private JSON or an unbounded title", async () => {
			await parent({
				content: "private text".repeat(100_000),
				title: "🌱".repeat(10_000),
				metadata: {
					source: "google-docs",
					connection: "synthetic-private-value",
				},
			});
			const metadata = await getContextQualitySourceMetadata(scope);
			expect(metadata).toMatchObject({
				id: scope.sourceId,
				content: null,
				metadata: { source: "google-docs" },
				sourceTitle: "🌱".repeat(240),
			});
			expect(JSON.stringify(metadata)).not.toContain("private text");
			expect(JSON.stringify(metadata)).not.toContain(
				"synthetic-private-value",
			);
			expect(
				Buffer.byteLength(JSON.stringify(metadata), "utf8"),
			).toBeLessThan(2048);
		});

		it("measures inline UTF-8 bytes exactly and returns no text above the ceiling", async () => {
			const content = "🌱🌱";
			await parent({ content });
			await expect(
				readContextQualitySourceBody({ ...scope, maxBytes: 8 }),
			).resolves.toEqual({
				content,
				truncated: false,
				hasReadableText: true,
			});
			await expect(
				readContextQualitySourceBody({ ...scope, maxBytes: 7 }),
			).resolves.toEqual({
				content: "",
				truncated: true,
				hasReadableText: false,
			});
		});

		it("does not transfer a large inline body merely to reject it in Node", async () => {
			await parent({ content: "x".repeat(1024 * 1024) });
			await expect(
				readContextQualitySourceBody({ ...scope, maxBytes: 96 * 1024 }),
			).resolves.toEqual({
				content: "",
				truncated: true,
				hasReadableText: false,
			});
		});

		it("matches canonical URL markdown ordering, titles, separators and UTF-8 size", async () => {
			await parent({
				type: "LINK",
				urlScope: "PATH_PREFIX",
				content: "parent text is not a crawl body",
			});
			await page("page-b", "https://example.com/b", "Beta");
			await page("page-a", "https://example.com/a", "Alpha🌱", "Title A");
			await page("page-empty", "https://example.com/empty", "");
			await page(
				"page-other-org",
				"https://example.com/private",
				"other organization",
				null,
				"example-other-org",
			);
			await page(
				"page-other-project",
				"https://example.com/private-project",
				"other project",
				null,
				scope.organizationId,
				"example-other-project",
			);
			const content =
				"## Title A\nhttps://example.com/a\n\nAlpha🌱\n\n---\n\n## https://example.com/b\nhttps://example.com/b\n\nBeta\n";
			const bytes = Buffer.byteLength(content, "utf8");
			await expect(
				readContextQualitySourceBody({ ...scope, maxBytes: bytes }),
			).resolves.toEqual({
				content,
				truncated: false,
				hasReadableText: true,
			});
			await expect(
				readContextQualitySourceBody({ ...scope, maxBytes: bytes - 1 }),
			).resolves.toEqual({
				content: "",
				truncated: true,
				hasReadableText: false,
			});
		});

		it("counts crawl headers in the bound before aggregating child text", async () => {
			await parent({ type: "LINK", urlScope: "PATH_PREFIX" });
			await page(
				"page-long-title",
				"https://example.com/a",
				"small text",
				"x".repeat(200_000),
			);
			await expect(
				readContextQualitySourceBody({ ...scope, maxBytes: 96 * 1024 }),
			).resolves.toEqual({
				content: "",
				truncated: true,
				hasReadableText: false,
			});
		});

		it("gives duplicate URLs the same canonical body and digest after opposite insertion orders", async () => {
			await parent({ type: "LINK", urlScope: "PATH_PREFIX" });
			const url = "https://example.com/shared";
			await page("page-z", url, "Second by id", "Second");
			await page("page-a", url, "First by id 🌱", "First");
			const first = await readContextQualitySourceBody({
				...scope,
				maxBytes: 1024,
			});
			const expected = `## First\n${url}\n\nFirst by id 🌱\n\n---\n\n## Second\n${url}\n\nSecond by id\n`;
			expect(first).toEqual({
				content: expected,
				truncated: false,
				hasReadableText: true,
			});
			const firstDigest = createHash("sha256")
				.update(first.content, "utf8")
				.digest("hex");
			await client.query("TRUNCATE pg_temp.project_context_url_page");
			await page("page-a", url, "First by id 🌱", "First");
			await page("page-z", url, "Second by id", "Second");
			const second = await readContextQualitySourceBody({
				...scope,
				maxBytes: 1024,
			});
			expect(second.content).toBe(expected);
			expect(
				createHash("sha256")
					.update(second.content, "utf8")
					.digest("hex"),
			).toBe(firstDigest);
		});

		it("a crawl with no stored pages has no readable body or inline fallback", async () => {
			await parent({
				type: "LINK",
				urlScope: "PATH_PREFIX",
				content: "pointer placeholder",
			});
			await expect(
				readContextQualitySourceBody({ ...scope, maxBytes: 100 }),
			).resolves.toEqual({
				content: "",
				truncated: false,
				hasReadableText: false,
			});
		});

		it("reads a PENDING Slack pointer's captured body in chronological/id order", async () => {
			await parent({
				type: "INTEGRATION",
				extractionStatus: "PENDING",
				metadata: { provider: "SLACK", channelId: "example-channel" },
			});
			await bundle("bundle-b", "Second", "2026-11-02T00:00:00Z");
			await bundle("bundle-a", "First🌱", "2026-11-02T00:00:00Z");
			await bundle("bundle-empty", "", "2026-11-01T00:00:00Z");
			await bundle(
				"bundle-other-org",
				"other organization",
				"2026-11-01T00:00:00Z",
				"example-other-org",
			);
			await bundle(
				"bundle-other-project",
				"other project",
				"2026-11-01T00:00:00Z",
				scope.organizationId,
				"example-other-project",
			);
			const content = "First🌱\n\n---\n\nSecond";
			const bytes = Buffer.byteLength(content, "utf8");
			await expect(
				getContextQualitySourceMetadata(scope),
			).resolves.toMatchObject({
				extractionStatus: "PENDING",
				metadata: {},
			});
			await expect(
				readContextQualitySourceBody({ ...scope, maxBytes: bytes }),
			).resolves.toEqual({
				content,
				truncated: false,
				hasReadableText: true,
			});
			await expect(
				readContextQualitySourceBody({ ...scope, maxBytes: bytes - 1 }),
			).resolves.toEqual({
				content: "",
				truncated: true,
				hasReadableText: false,
			});
		});

		it("does not transfer or assemble an oversized captured conversation", async () => {
			await parent({ type: "INTEGRATION", extractionStatus: "PENDING" });
			await bundle(
				"bundle-huge",
				"x".repeat(1024 * 1024),
				"2026-11-02T00:00:00Z",
			);
			await expect(
				readContextQualitySourceBody({ ...scope, maxBytes: 96 * 1024 }),
			).resolves.toEqual({
				content: "",
				truncated: true,
				hasReadableText: false,
			});
		});

		it("falls back to stored inline integration content only when no nonempty bundles exist", async () => {
			await parent({
				type: "INTEGRATION",
				content: "stored integration text",
			});
			await bundle("bundle-empty", "", "2026-11-02T00:00:00Z");
			await expect(
				readContextQualitySourceBody({ ...scope, maxBytes: 100 }),
			).resolves.toEqual({
				content: "stored integration text",
				truncated: false,
				hasReadableText: true,
			});
		});

		it("does not expose another organization/project's addressed source", async () => {
			await parent({ content: "protected text" });
			for (const changed of [
				{ organizationId: "example-other-org" },
				{ projectId: "example-other-project" },
			]) {
				await expect(
					getContextQualitySourceMetadata({ ...scope, ...changed }),
				).resolves.toBeNull();
				await expect(
					readContextQualitySourceBody({
						...scope,
						...changed,
						maxBytes: 100,
					}),
				).resolves.toEqual({
					content: "",
					truncated: false,
					hasReadableText: false,
				});
			}
		});
	},
);
