import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildProjectKnowledgeSearchQuery,
	type KnowledgeSearchPosition,
} from "../prisma/queries/projects/knowledge-search";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

// Synthetic temporary tables shadow production tables only on this connection.
// The entire fixture is rolled back, including all DDL. Never touches real rows.
describe.skipIf(!hasReachableDatabaseUrl())(
	"knowledge search PostgreSQL execution",
	() => {
		let client: Client;
		const base = {
			projectId: "example-project",
			organizationId: "example-org",
			query: "needle",
			limit: 50,
		};
		const search = async (args = base) => {
			const sql = buildProjectKnowledgeSearchQuery(args);
			return (await client.query(sql.text, sql.values)).rows;
		};
		beforeAll(async () => {
			const databaseUrl = process.env.DATABASE_URL;
			if (!databaseUrl) {
				throw new Error("DATABASE_URL is required");
			}
			const url = new URL(databaseUrl);
			if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
				throw new Error(
					"Use a local database for the temporary fixture",
				);
			}
			client = new Client({ connectionString: url.toString() });
			await client.connect();
			await client.query("BEGIN");
			await client.query("SET LOCAL statement_timeout = '5s'");
			await client.query(`
   CREATE TEMP TABLE user_story (id text, "projectId" text, "organizationId" text, title text, description text, identifier text, kind text);
   CREATE TEMP TABLE project_document (id text, "projectId" text, "organizationId" text, title text, content text, type text);
   CREATE TEMP TABLE project_context (id text, "projectId" text, "organizationId" text, type text, content text, "sourceTitle" text, "originalFilename" text, "sourceUrl" text, "urlScope" text, metadata jsonb);
   CREATE TEMP TABLE project_context_url_page (id text, "parentContextId" text, "projectId" text, "organizationId" text, "pageTitle" text, "pageUrl" text, content text);
   CREATE TEMP TABLE project_context_conversation_bundle (id text, "parentContextId" text, "projectId" text, "organizationId" text, content text);
   INSERT INTO user_story SELECT 'feature-' || lpad(i::text,4,'0'),'example-project','example-org','Feature','body needle','F-' || i,'FEATURE' FROM generate_series(1,1100) i;
   INSERT INTO project_document VALUES ('doc-exact','example-project','example-org','needle','text needle','PRD'), ('doc-body','example-project','example-org','Document','needle inside body','GENERAL'), ('doc-title','example-project','example-org','needle overview','unrelated prose','GENERAL'), ('foreign-project','other-project','example-org','needle','needle','PRD'), ('foreign-tenant','example-project','other-org','needle','needle','PRD');
   INSERT INTO project_context VALUES ('ctx-direct','example-project','example-org','TEXT','direct needle','Notes',NULL,NULL,NULL,NULL), ('ctx-link','example-project','example-org','LINK','','Site',NULL,'https://example.com','PATH_PREFIX',NULL), ('ctx-chat','example-project','example-org','INTEGRATION','','Channel',NULL,NULL,NULL,NULL), ('ctx-code','example-project','example-org','CODE_FILE','needle','Code',NULL,NULL,NULL,NULL), ('ctx-empty','example-project','example-org','FILE','   ','needle unavailable',NULL,NULL,NULL,NULL), ('ctx-metadata','example-project','example-org','TEXT','unrelated',NULL,NULL,NULL,NULL,'{"title":{"needle":true},"filename":"Notes"}');
   INSERT INTO project_context_url_page VALUES ('page','ctx-link','example-project','example-org','Page','https://example.com/page','page needle'), ('foreign-page','ctx-link','example-project','other-org','needle','https://example.com/foreign','needle');
   INSERT INTO project_context_conversation_bundle VALUES ('bundle','ctx-chat','example-project','example-org','captured needle'), ('foreign-bundle','ctx-chat','other-project','example-org','needle');
  `);
			await client.query(
				"INSERT INTO user_story VALUES ($1,$2,$3,$4,$5,$6,$7)",
				[
					"tiptap",
					base.projectId,
					base.organizationId,
					"Formatted",
					JSON.stringify({
						type: "doc",
						content: [
							{
								type: "paragraph",
								attrs: { text: "structural-only" },
								content: [
									{
										text: 'needle 😀 quoted " text',
										marks: [
											{
												type: "bold",
												attrs: {
													text: "structural-only",
												},
											},
										],
										type: "text",
									},
								],
							},
						],
					}).replace("😀", "\\uD83D\\uDE00"),
					"F-9999",
					"FEATURE",
				],
			);
			await client.query(
				"INSERT INTO user_story VALUES ($1,$2,$3,$4,$5,$6,$7)",
				[
					"malformed",
					base.projectId,
					base.organizationId,
					"Malformed",
					'{"type":"doc","content":[{"type":"text","text":"bad\\uD800"}]}',
					"F-9998",
					"FEATURE",
				],
			);
		}, 30000);
		afterAll(async () => {
			if (client) {
				await client.query("ROLLBACK");
				await client.end();
			}
		});
		it("ranks before limiting and continues through more than 1000 entries without repeats", async () => {
			const first = await search();
			expect(first[1]).toMatchObject({ sourceId: "doc-title", rank: 2 });
			expect(first[2]).toMatchObject({ sourceId: "ctx-direct", rank: 1 });
			expect(first[0]).toMatchObject({ sourceId: "doc-exact", rank: 3 });
			const seen = new Set<string>();
			let after: KnowledgeSearchPosition | undefined;
			for (;;) {
				const sql = buildProjectKnowledgeSearchQuery({
					...base,
					after,
				});
				const rows = (await client.query(sql.text, sql.values)).rows;
				const page = rows.slice(0, base.limit);
				for (const row of page) {
					const key = `${row.sourceKind}:${row.sourceId}`;
					expect(seen.has(key)).toBe(false);
					seen.add(key);
				}
				if (rows.length <= base.limit) {
					break;
				}
				const last = page.at(-1);
				if (!last) {
					throw new Error("Continuation requires an emitted row");
				}
				after = {
					rank: last.rank,
					sourceKind: last.sourceKind,
					sourceId: last.sourceId,
				};
			}
			expect(seen.size).toBe(1107);
			expect(seen).toContain("context_page:page");
			expect(seen).toContain("context_bundle:bundle");
			expect([...seen].join(" ")).not.toMatch(
				/foreign|ctx-code|ctx-empty|malformed/,
			);
		});
		it("searches readable TipTap text rather than structural JSON attributes", async () => {
			const rows = await search({ ...base, query: 'quoted " text' });
			expect(rows).toHaveLength(1);
			expect(rows[0].excerpt).toContain('needle 😀 quoted " text');
			expect(rows[0].excerpt).not.toContain('"type"');
			expect(await search({ ...base, query: "structural-only" })).toEqual(
				[],
			);
		});
		it("centers a title-only excerpt around a match beyond the displayed title", async () => {
			await client.query(
				"INSERT INTO project_document VALUES ($1,$2,$3,$4,$5,$6)",
				[
					"late-title",
					base.projectId,
					base.organizationId,
					`${"x".repeat(1000)}late-title-needle`,
					"unrelated body",
					"GENERAL",
				],
			);
			const rows = await search({ ...base, query: "late-title-needle" });
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				titleTruncated: true,
				excerptField: "title",
				excerptTruncated: true,
			});
			expect(rows[0].excerpt).toContain("late-title-needle");
		});
		it("treats wildcard punctuation literally and bounds excerpts around a late match", async () => {
			await client.query(
				"INSERT INTO project_document VALUES ($1,$2,$3,$4,$5,$6)",
				[
					"late",
					base.projectId,
					base.organizationId,
					"Late",
					`${"x".repeat(10000)}needle %_\\ emoji 😀`,
					"GENERAL",
				],
			);
			const rows = await search({ ...base, query: "%_\\" });
			expect(rows).toHaveLength(1);
			expect(rows[0].excerpt).toContain("needle %_\\ emoji 😀");
			expect(Array.from(rows[0].excerpt).length).toBeLessThanOrEqual(480);
			expect(rows[0].excerptTruncated).toBe(true);
		});
		it("preserves visible phrases and words across inline marks while separating paragraphs", async () => {
			await client.query(
				"INSERT INTO user_story VALUES ($1,$2,$3,$4,$5,$6,$7)",
				[
					"inline-marks",
					base.projectId,
					base.organizationId,
					"Formatted phrases",
					JSON.stringify({
						type: "doc",
						content: [
							{
								type: "paragraph",
								attrs: { text: "hidden-inline-metadata" },
								content: [
									{ type: "text", text: "Deploy " },
									{
										type: "text",
										text: "safely",
										marks: [
											{
												type: "bold",
												attrs: {
													text: "hidden-inline-metadata",
												},
											},
										],
									},
								],
							},
							{
								// Field order does not determine the object's type.
								content: [
									{ text: "auth", type: "text" },
									{
										marks: [{ type: "italic" }],
										text: "entication",
										type: "text",
									},
								],
								type: "paragraph",
							},
							{
								type: "paragraph",
								content: [{ type: "text", text: "boundary" }],
							},
						],
					}),
					"F-9980",
					"FEATURE",
				],
			);
			const phrase = await search({ ...base, query: "Deploy safely" });
			expect(phrase).toHaveLength(1);
			expect(phrase[0].excerpt).toBe(
				"Deploy safely\nauthentication\nboundary\n",
			);
			expect(
				await search({ ...base, query: "authentication" }),
			).toHaveLength(1);
			expect(
				await search({ ...base, query: "authenticationboundary" }),
			).toEqual([]);
			expect(
				await search({ ...base, query: "hidden-inline-metadata" }),
			).toEqual([]);
		});
		it("searches 3000 formatted paragraphs with headroom under the execution deadline", async () => {
			const description = JSON.stringify({
				type: "doc",
				content: Array.from({ length: 3000 }, (_, i) => ({
					type: "paragraph",
					content: [
						{ type: "text", text: `volume-target paragraph ${i}` },
					],
				})),
			});
			await client.query("SAVEPOINT volume_fixture");
			try {
				await client.query(
					"INSERT INTO user_story VALUES ($1,$2,$3,$4,$5,$6,$7)",
					[
						"volume",
						base.projectId,
						base.organizationId,
						"Volume",
						description,
						"F-9970",
						"FEATURE",
					],
				);
				const started = performance.now();
				const rows = await search({ ...base, query: "volume-target" });
				const elapsedMs = performance.now() - started;
				console.info(
					`TipTap search: 3000 paragraphs, ${Buffer.byteLength(description)} UTF-8 bytes, ${elapsedMs.toFixed(1)}ms`,
				);
				expect(rows).toHaveLength(1);
				expect(rows[0].sourceId).toBe("volume");
				expect(elapsedMs).toBeLessThan(2000);
			} finally {
				await client.query("ROLLBACK TO SAVEPOINT volume_fixture");
			}
		}, 15000);
	},
);
