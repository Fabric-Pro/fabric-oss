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

const m = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../prisma/client", async () => ({
	Prisma: (await import("../prisma/generated/client")).Prisma,
	db: {},
}));
vi.mock("../src/tenant-db", () => ({
	withRLSContext: (_db: unknown, callback: (tx: unknown) => unknown) =>
		callback({ $queryRaw: m.query }),
}));

import { listContextManifestMetadata } from "../prisma/queries/projects/context-manifest";

const scope = {
	userId: "example-user",
	organizationId: "example-org",
	projectId: "example-project",
	limit: 20,
	offset: 0,
	includeCodeContexts: false,
};
const configuredUrl =
	process.env.CONTEXT_MANIFEST_SQL_TEST_URL ??
	(process.env.RUN_DB_INTEGRATION === "1"
		? process.env.DATABASE_URL
		: undefined);

describe("context manifest metadata admission", () => {
	beforeEach(() => m.query.mockReset());
	it.each([
		{ limit: 51 },
		{ limit: 0 },
		{ offset: -1 },
		{ offset: 1.5 },
		{ organizationId: "" },
	])("fails closed before SQL on invalid scope/page %j", async (change) => {
		await expect(
			listContextManifestMetadata({ ...scope, ...change }),
		).rejects.toThrow("Invalid context manifest");
		expect(m.query).not.toHaveBeenCalled();
	});
});
/** Production parameterized SQL on session-local TEMP tables; not a production-role RLS certification. */
describe.skipIf(!configuredUrl)(
	"Context manifest metadata SQL on PostgreSQL",
	() => {
		let client: Client;
		beforeAll(async () => {
			if (
				!configuredUrl ||
				!["localhost", "127.0.0.1", "[::1]"].includes(
					new URL(configuredUrl).hostname,
				)
			)
				throw new Error(
					"Context manifest SQL tests require explicit loopback PostgreSQL.",
				);
			client = new Client({ connectionString: configuredUrl });
			await client.connect();
			await client.query(`
			CREATE TEMP TABLE project_context (id text PRIMARY KEY, "projectId" text, "organizationId" text, type text DEFAULT 'TEXT', content text DEFAULT '', "sourceTitle" text, "originalFilename" text, "extractionStatus" text DEFAULT 'COMPLETED', "indexingExcluded" boolean DEFAULT false, "urlScope" text, metadata jsonb, "createdAt" timestamptz DEFAULT '2026-01-01', "updatedAt" timestamptz DEFAULT '2026-01-01');
			CREATE TEMP TABLE project_context_url_page (id text, "parentContextId" text, "projectId" text, "organizationId" text, content text);
			CREATE TEMP TABLE project_context_conversation_bundle (id text, "parentContextId" text, "projectId" text, "organizationId" text, content text);
		`);
		});
		afterAll(async () => {
			await client?.end();
		});
		beforeEach(async () => {
			m.query.mockImplementation(
				async (sql: { text: string; values: unknown[] }) =>
					(await client.query(sql.text, sql.values)).rows,
			);
			await client.query(
				"TRUNCATE pg_temp.project_context, pg_temp.project_context_url_page, pg_temp.project_context_conversation_bundle",
			);
		});
		async function insert(
			id: string,
			content = "Exact 😀\n",
			fields: {
				type?: string;
				organizationId?: string;
				status?: string;
				metadata?: unknown;
				urlScope?: string;
				indexingExcluded?: boolean;
			} = {},
		) {
			await client.query(
				'INSERT INTO pg_temp.project_context (id,"projectId","organizationId",type,content,"sourceTitle","extractionStatus",metadata,"urlScope","indexingExcluded") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
				[
					id,
					scope.projectId,
					fields.organizationId ?? scope.organizationId,
					fields.type ?? "TEXT",
					content,
					"Example source",
					fields.status ?? "COMPLETED",
					fields.metadata ?? null,
					fields.urlScope ?? null,
					fields.indexingExcluded ?? false,
				],
			);
		}
		it("returns exact inline UTF-8 hashes/bytes, bounded titles and no body/provider/storage bytes", async () => {
			const text = "Exact 😀\n";
			await insert("source-a", text, {
				metadata: { token: "private-example-token" },
				indexingExcluded: true,
			});
			await client.query(
				'UPDATE pg_temp.project_context SET "sourceTitle" = $1',
				["x".repeat(500)],
			);
			const result = await listContextManifestMetadata(scope);
			expect(result.rows[0]).toMatchObject({
				sourceId: "source-a",
				revision: createHash("sha256").update(text).digest("hex"),
				byteLength: Buffer.byteLength(text),
				hasText: true,
				indexingExcluded: true,
				hasLifecycle: true,
			});
			expect(result.rows[0]?.title).toHaveLength(240);
			expect(result.rows[0]).not.toHaveProperty("content");
			expect(result.rows[0]).not.toHaveProperty("metadata");
			expect(JSON.stringify(result)).not.toContain(text);
			expect(JSON.stringify(result)).not.toContain("private-example");
		});
		it("uses deterministic unique ordering and bounded continuation; code-index omission is explicit", async () => {
			await insert("source-a");
			await insert("source-b");
			await insert("source-code", "Indexed source", {
				type: "CODE_FILE",
			});
			const first = await listContextManifestMetadata({
				...scope,
				limit: 1,
			});
			const second = await listContextManifestMetadata({
				...scope,
				limit: 1,
				offset: 1,
			});
			expect(first).toMatchObject({
				total: 2,
				excludedCodeContexts: 1,
				hasMore: true,
			});
			expect(first.rows.map((row) => row.sourceId)).toEqual(["source-b"]);
			expect(second.rows.map((row) => row.sourceId)).toEqual([
				"source-a",
			]);
			expect(
				(
					await listContextManifestMetadata({
						...scope,
						type: "CODE_FILE",
					})
				).rows.map((row) => row.sourceId),
			).toEqual(["source-code"]);
		});
		it("does not hash partial, oversized or whitespace-only inline bodies; NULL LINK scope stays inline", async () => {
			await insert("source-pending", "Retained old content", {
				status: "PENDING",
			});
			await insert("source-big", "x".repeat(98305));
			await insert("source-big-space", " ".repeat(98305));
			await insert("source-empty", "\u00a0\uFEFF\n\t");
			await insert("source-link", "Single-page text", { type: "LINK" });
			const result = await listContextManifestMetadata(scope);
			for (const id of [
				"source-pending",
				"source-big",
				"source-big-space",
				"source-empty",
			])
				expect(
					result.rows.find((row) => row.sourceId === id)?.revision,
				).toBeNull();
			// Oversized text is deferred to canonical inspection without trimming it.
			expect(
				result.rows.find((row) => row.sourceId === "source-big-space"),
			).toMatchObject({
				hasText: true,
				byteLength: 98305,
				revision: null,
			});
			expect(
				result.rows.find((row) => row.sourceId === "source-empty")
					?.hasText,
			).toBe(false);
			expect(
				result.rows.find((row) => row.sourceId === "source-link"),
			).toMatchObject({
				bodyKind: "inline",
				revision: createHash("sha256")
					.update("Single-page text")
					.digest("hex"),
			});
		});
		it("never uses parent hashes for child-backed sources and scopes children to exact tenant/project", async () => {
			await insert("source-bundle", "Parent fallback", {
				type: "INTEGRATION",
				status: "PENDING",
			});
			await client.query(
				"INSERT INTO pg_temp.project_context_conversation_bundle VALUES ($1,$2,$3,$4,$5)",
				[
					"bundle-example",
					"source-bundle",
					scope.projectId,
					scope.organizationId,
					"Captured source",
				],
			);
			await insert("source-crawl", "Parent should be ignored", {
				type: "LINK",
				urlScope: "PATH_PREFIX",
			});
			await client.query(
				"INSERT INTO pg_temp.project_context_url_page VALUES ($1,$2,$3,$4,$5)",
				[
					"page-example",
					"source-crawl",
					scope.projectId,
					"other-org",
					"Wrong tenant page",
				],
			);
			const result = await listContextManifestMetadata(scope);
			expect(
				result.rows.find((row) => row.sourceId === "source-bundle"),
			).toMatchObject({
				bodyKind: "composite",
				hasText: true,
				revision: null,
				byteLength: null,
				hasLifecycle: false,
			});
			expect(
				result.rows.find((row) => row.sourceId === "source-crawl"),
			).toMatchObject({
				bodyKind: "composite",
				hasText: false,
				revision: null,
			});
		});
		it("recognizes private conversation omission and lifecycle-less pointers without copying chat IDs", async () => {
			await insert("source-private", "", {
				type: "INTEGRATION",
				status: "PENDING",
				metadata: { provider: "slack", chatId: "private-example-chat" },
			});
			await insert("source-channel", "", {
				type: "INTEGRATION",
				status: "PENDING",
				metadata: {
					provider: "SLACK",
					channelId: "private-example-channel",
					chatId: "private-example-chat",
					chatType: "channel",
				},
			});
			const result = await listContextManifestMetadata(scope);
			expect(
				result.rows.find((row) => row.sourceId === "source-private"),
			).toMatchObject({ privateConversation: true, hasLifecycle: false });
			expect(
				result.rows.find((row) => row.sourceId === "source-channel")
					?.privateConversation,
			).toBe(false);
			expect(JSON.stringify(result)).not.toContain("private-example");
		});
		it("applies tenant isolation in SQL and treats hostile type input as data", async () => {
			await insert("source-other", "Wrong tenant", {
				organizationId: "other-org",
			});
			expect(await listContextManifestMetadata(scope)).toMatchObject({
				rows: [],
				total: 0,
			});
			expect(
				await listContextManifestMetadata({
					...scope,
					type: "' OR TRUE --",
				}),
			).toMatchObject({ rows: [], total: 0 });
		});
	},
);
