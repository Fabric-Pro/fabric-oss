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

const m = vi.hoisted(() => ({
	access: vi.fn(),
	member: vi.fn(),
	query: vi.fn(),
}));
vi.mock("../prisma/client", async () => ({
	Prisma: (await import("../prisma/generated/client")).Prisma,
	db: { member: { findFirst: m.member } },
}));
vi.mock("../prisma/queries/workspaces/workspaces", () => ({
	getWorkspaceAccessContext: m.access,
}));
vi.mock("../src/tenant-db", () => ({
	withRLSContext: (_db: unknown, callback: (tx: unknown) => unknown) =>
		callback({ $queryRaw: m.query }),
}));

import { readWorkspaceDocumentContent } from "../prisma/queries/workspaces/document-content";

const configuredUrl =
	process.env.WORKSPACE_CONTENT_SQL_TEST_URL ??
	(process.env.RUN_DB_INTEGRATION === "1"
		? process.env.DATABASE_URL
		: undefined);
const actor = { userId: "example-user", organizationId: "example-org" };
const input = {
	workspaceId: "example-workspace",
	documentId: "example-document",
};
const content = "A😀éBC";
/**
 * Actual production SQL against session-local PostgreSQL TEMP tables. Tests
 * parameterization, tenant predicates, UTF-8 hashes, Unicode pages and extraction
 * state, not application-role RLS. No public fixtures/schema are written.
 */
describe.skipIf(!configuredUrl)("Workspace content SQL on PostgreSQL", () => {
	let client: Client;
	beforeAll(async () => {
		if (
			!configuredUrl ||
			!["localhost", "127.0.0.1", "[::1]"].includes(
				new URL(configuredUrl).hostname,
			)
		)
			throw new Error(
				"Workspace content SQL tests require an explicitly configured loopback database.",
			);
		client = new Client({ connectionString: configuredUrl });
		await client.connect();
		await client.query(`
			CREATE TEMP TABLE organization (id text PRIMARY KEY, "deletedAt" timestamptz);
			CREATE TEMP TABLE workspace (id text PRIMARY KEY, "organizationId" text NOT NULL);
			CREATE TEMP TABLE workspace_document (id text PRIMARY KEY, "workspaceId" text NOT NULL, "originalFilename" text NOT NULL, "mimeType" text NOT NULL, status text NOT NULL, "extractedText" text);
		`);
	});
	afterAll(async () => {
		await client?.end();
	});
	beforeEach(async () => {
		vi.resetAllMocks();
		m.access.mockResolvedValue({ organizationId: actor.organizationId });
		m.member.mockResolvedValue({ role: "member" });
		m.query.mockImplementation(
			async (sql: { text: string; values: unknown[] }) =>
				(await client.query(sql.text, sql.values)).rows,
		);
		await client.query(
			"TRUNCATE pg_temp.organization, pg_temp.workspace, pg_temp.workspace_document",
		);
		await client.query(
			"INSERT INTO pg_temp.organization (id) VALUES ($1), ($2)",
			[actor.organizationId, "example-other-org"],
		);
		await client.query(
			'INSERT INTO pg_temp.workspace (id, "organizationId") VALUES ($1,$2), ($3,$4)',
			[
				input.workspaceId,
				actor.organizationId,
				"example-other-workspace",
				"example-other-org",
			],
		);
		await client.query(
			'INSERT INTO pg_temp.workspace_document (id, "workspaceId", "originalFilename", "mimeType", status, "extractedText") VALUES ($1,$2,$3,$4,$5,$6)',
			[
				input.documentId,
				input.workspaceId,
				"example.txt",
				"text/plain",
				"READY",
				content,
			],
		);
	});
	it("returns intact Unicode pages and a hash matching Node SHA256 of exact UTF-8", async () => {
		const first = await readWorkspaceDocumentContent(actor, {
			...input,
			limit: 2,
		});
		expect(first).toMatchObject({
			text: "A😀",
			totalCharacters: 5,
			totalBytes: 9,
			nextOffset: 2,
			revision: createHash("sha256").update(content).digest("hex"),
		});
		const last = await readWorkspaceDocumentContent(actor, {
			...input,
			offset: first.nextOffset,
			limit: 3,
			expectedRevision: first.revision,
		});
		expect(last).toMatchObject({
			text: "éBC",
			nextOffset: null,
			revision: first.revision,
		});
		expect(first.text + last.text).toBe(content);
	});
	it("blocks a content change between continuation pages", async () => {
		const first = await readWorkspaceDocumentContent(actor, {
			...input,
			limit: 2,
		});
		await client.query(
			'UPDATE pg_temp.workspace_document SET "extractedText" = $1 WHERE id = $2',
			["Changed context", input.documentId],
		);
		await expect(
			readWorkspaceDocumentContent(actor, {
				...input,
				offset: 2,
				expectedRevision: first.revision,
			}),
		).rejects.toMatchObject({ code: "STALE_REVISION", status: 409 });
	});
	it("applies tenant and workspace/document predicates in SQL even if a mocked access gate claims a grant", async () => {
		m.access.mockResolvedValue({ organizationId: "example-other-org" });
		await expect(
			readWorkspaceDocumentContent(
				{ ...actor, organizationId: "example-other-org" },
				input,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		m.access.mockResolvedValue({ organizationId: actor.organizationId });
		await expect(
			readWorkspaceDocumentContent(actor, {
				...input,
				workspaceId: "example-other-workspace",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("does not return retained old text during failed/restarted extraction", async () => {
		await client.query(
			"UPDATE pg_temp.workspace_document SET status = 'PROCESSING'",
		);
		await expect(
			readWorkspaceDocumentContent(actor, input),
		).rejects.toMatchObject({ code: "NOT_READY" });
		const sqlRow = await m.query.mock.results.at(-1)?.value;
		expect(sqlRow?.[0]).toMatchObject({ text: null, revision: null });
	});
	it("excludes a soft-deleted organization", async () => {
		await client.query(
			'UPDATE pg_temp.organization SET "deletedAt" = now() WHERE id = $1',
			[actor.organizationId],
		);
		await expect(
			readWorkspaceDocumentContent(actor, input),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("bounds transfer to 20,000 code points even for large multibyte documents", async () => {
		await client.query(
			'UPDATE pg_temp.workspace_document SET "extractedText" = $1',
			["😀".repeat(30000)],
		);
		const page = await readWorkspaceDocumentContent(actor, {
			...input,
			limit: 20000,
		});
		expect(Array.from(page.text)).toHaveLength(20000);
		expect(Buffer.byteLength(page.text)).toBe(80000);
		expect(page).toMatchObject({
			totalCharacters: 30000,
			totalBytes: 120000,
			nextOffset: 20000,
		});
	});
	it("handles a valid empty READY extraction and literal SQL metacharacters safely", async () => {
		await client.query(
			'UPDATE pg_temp.workspace_document SET "extractedText" = $1',
			[""],
		);
		expect(await readWorkspaceDocumentContent(actor, input)).toMatchObject({
			text: "",
			totalCharacters: 0,
			totalBytes: 0,
			nextOffset: null,
		});
		await expect(
			readWorkspaceDocumentContent(actor, {
				...input,
				documentId: "' OR TRUE --",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
