import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { db } from "../prisma/client";
import { getOrgFlagStateUncached } from "../prisma/queries/feature-flags";
import { disposableTarget } from "../scripts/prisma-disposable.mjs";

// Use a disposable migrated database: setup applies the real RLS deployment
// script, and cases alter constraints, roles and triggers
// transactionally. RUN_DB_INTEGRATION is an explicit opt-in, including in CI.
describe.skipIf(process.env.RUN_DB_INTEGRATION !== "1")(
	"Decision Replay capture",
	() => {
		let client: Client;
		let startedAt: string;
		let fixtureRoles: string[] = [];
		const provisionedRoles: string[] = [];
		beforeAll(async () => {
			let target: string;
			try {
				// Pure URL validation; importing the helper does not run its reset CLI.
				target = disposableTarget("reset", {
					DIRECT_URL: process.env.DATABASE_URL,
				});
			} catch {
				throw new Error(
					"Decision Replay capture setup refused: DATABASE_URL must target a disposable loopback PostgreSQL database named example_* with no URL parameters.",
				);
			}
			client = new Client({ connectionString: target });
			await client.connect();
			for (const role of ["fabric_app", "fabric_worker"]) {
				if (
					(
						await client.query(
							"SELECT 1 FROM pg_roles WHERE rolname=$1",
							[role],
						)
					).rowCount === 0
				) {
					await client.query(
						`CREATE ROLE ${role} NOSUPERUSER NOBYPASSRLS`,
					);
					provisionedRoles.push(role);
				}
			}
			execFileSync(
				"pnpm",
				["exec", "tsx", "scripts/apply-rls-direct.ts"],
				{
					cwd: resolve(__dirname, ".."),
					env: {
						...process.env,
						APP_RLS_BYPASS: "true",
						WORKER_RLS_MODE: "policy",
						WORKER_ROLE_PREPROVISIONED: "true",
					},
					stdio: "pipe",
				},
			);
		}, 30000);
		afterAll(async () => {
			if (!client) {
				return;
			}
			for (const role of provisionedRoles) {
				await client.query(`DROP OWNED BY ${role}`);
				await client.query(`DROP ROLE ${role}`);
			}
			await client?.end();
			await db.$disconnect();
		});
		beforeEach(async ({ task }) => {
			fixtureRoles = [];
			await client.query("BEGIN");
			startedAt = (
				await client.query("SELECT clock_timestamp()::text AS at")
			).rows[0].at;
			await client.query(
				`INSERT INTO organization (id, name, "createdAt") VALUES ('c000000000000000000000001', 'Example', now())`,
			);
			await client.query(
				`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('c000000000000000000000003', 'Example', 'dev@example.com', false, now(), now())`,
			);
			await client.query(
				`INSERT INTO project (id, name, "userId", "organizationId", "updatedAt") VALUES ('c000000000000000000000002', 'Example', 'c000000000000000000000003', 'c000000000000000000000001', now())`,
			);
			await client.query(
				`INSERT INTO project_story_status (id, "projectId", name, color, "order", "updatedAt") VALUES ('c000000000000000000000004', 'c000000000000000000000002', 'Example', '#000000', 0, now())`,
			);
			// Empty-table erasure cases must start without ever enabling capture.
			if (!task.name.includes("flag never configured")) {
				await client.query(
					`INSERT INTO organization_feature_flag_override (key, "organizationId", enabled, "updatedBy", "updatedAt") VALUES ('DECISION_REPLAY', 'c000000000000000000000001', true, 'c000000000000000000000003', now())`,
				);
			}
			await client.query(
				`INSERT INTO ai_model (id,"canonicalName","displayName",family,vendor,"contextWindow","updatedAt") VALUES ('c000000000000000000000010','example-model','Example','example','example',4096,now())`,
			);
			await client.query(
				`INSERT INTO prompt (id,key,name,scope,"createdBy","updatedAt") VALUES ('c000000000000000000000011','example-prompt','Example','SYSTEM','c000000000000000000000003',now())`,
			);
			await client.query(
				`INSERT INTO prompt_version (id,"promptId",version,content,"createdBy") VALUES ('c00000000000000000000000f','c000000000000000000000011',1,'Example','c000000000000000000000003')`,
			);
		});
		afterEach(async () => {
			await client.query("ROLLBACK");
			if (fixtureRoles.length > 0) {
				expect(
					(
						await client.query(
							"SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])",
							[fixtureRoles],
						)
					).rows,
				).toEqual([]);
			}
		});
		const proposal = async (
			org: string | null = "c000000000000000000000001",
			id = "c000000000000000000000005",
		) =>
			client.query(
				`INSERT INTO pending_backlog_proposal (id, "projectId", source, proposal, summary, "organizationId", "changeCount") VALUES ($2, 'c000000000000000000000002', 'AI_UPDATE_SIDEBAR', '{"private":"example content"}', 'example content', $1, 2)`,
				[org, id],
			);
		const story = async (
			id = "c000000000000000000000006",
			origin: string | null = "c000000000000000000000005",
		) =>
			client.query(
				`INSERT INTO user_story (id, "projectId", "statusId", identifier, title, "createdById", "createdFromProposalId", "updatedAt") VALUES ($1, 'c000000000000000000000002', 'c000000000000000000000004', $1, 'Example', 'c000000000000000000000003', $2, now())`,
				[id, origin],
			);
		const rating = async (
			org: string | null = "c000000000000000000000001",
		) =>
			client.query(
				`INSERT INTO ai_outcome_event (id, "featureKey", outcome, "subjectType", "subjectId", "userId", "organizationId", "projectId", "modelCanonicalName", "promptVersionId", comment, "updatedAt") VALUES ('c000000000000000000000009', 'maturation', 'RATED_UP', 'story', 'c000000000000000000000006', 'c000000000000000000000003', $1, 'c000000000000000000000002', 'example-model', 'c00000000000000000000000f', 'example content', now())`,
				[org],
			);
		const events = async () =>
			(
				await client.query(
					"SELECT * FROM lakehouse_export.decision_event WHERE occurred_at >= $1::timestamptz ORDER BY occurred_at, id",
					[startedAt],
				)
			).rows;
		const preflightTables = [
			"project",
			"prompt_version",
			"user",
			"organization",
			"ai_model",
			"pending_backlog_proposal",
		];
		const sourceTables = [
			...preflightTables,
			"feature_flag_override",
			"organization_feature_flag_override",
		];
		const keys = (payload: unknown) =>
			Object.keys((payload ?? {}) as object).sort();

		const review = async () => {
			await client.query(
				`INSERT INTO pending_backlog_proposal_review (id,"proposalId","reviewedBy","offeredCount","selectedCount","offeredListComplete","syncToPM","pmConfig") VALUES ('c000000000000000000000020','c000000000000000000000005','c000000000000000000000003',8,5,true,false,'{"private":"example secret"}')`,
			);
		};
		const entries = async () =>
			client.query(
				`INSERT INTO pending_backlog_proposal_review_entry (id,"reviewId","proposalId","offeredIndex","changeIndex",selected,change,"pmSyncOverride") VALUES ('c000000000000000000000021','c000000000000000000000020','c000000000000000000000005',0,2,true,'{"title":{"to":"example private title"}}','{"private":"example secret"}'),('c000000000000000000000022','c000000000000000000000020','c000000000000000000000005',1,NULL,false,'{"title":{"to":"example omitted title"}}',NULL)`,
			);
		const duplicate = async () =>
			client.query(
				`INSERT INTO pending_backlog_proposal_duplicate_resolution (id,"proposalId","changeIndex","existingEntityType","existingEntityId") VALUES ('c000000000000000000000023','c000000000000000000000005',4,'story','example private target')`,
			);
		const outcome = async (kind: string) => {
			if (kind === "duplicate") {
				await duplicate();
			} else {
				await review();
				if (kind === "entries") {
					await entries();
				}
			}
		};
		it("captures review, bulk entries and duplicate resolution with exact safe payloads", async () => {
			await proposal(null);
			await review();
			await entries();
			await duplicate();
			const rows = (await events()).filter(
				(r) => r.event_type !== "proposed",
			);
			expect(rows).toHaveLength(4);
			for (const row of rows) {
				expect(row).toMatchObject({
					organization_id: "c000000000000000000000001",
					project_id: "c000000000000000000000002",
					related_subject_id: "c000000000000000000000005",
				});
			}
			expect(
				rows.find((r) => r.event_type === "proposal_reviewed"),
			).toMatchObject({
				subject_type: "backlog_proposal_review",
				subject_id: "c000000000000000000000020",
				actor_kind: "human",
				actor_id: "c000000000000000000000003",
				payload: {
					source: "AI_UPDATE_SIDEBAR",
					offeredCount: 8,
					selectedCount: 5,
					offeredListComplete: true,
				},
			});
			const reviewed = rows
				.filter((r) => r.event_type === "change_reviewed")
				.sort(
					(a, b) => a.payload.offeredIndex - b.payload.offeredIndex,
				);
			expect(reviewed.map((r) => r.payload)).toEqual([
				{
					reviewId: "c000000000000000000000020",
					offeredIndex: 0,
					changeIndex: 2,
					selected: true,
				},
				{
					reviewId: "c000000000000000000000020",
					offeredIndex: 1,
					changeIndex: null,
					selected: false,
				},
			]);
			for (const row of reviewed) {
				expect(row).toMatchObject({
					subject_type: "backlog_proposal_review_entry",
					actor_kind: "human",
					actor_id: "c000000000000000000000003",
				});
			}
			expect(
				rows.find((r) => r.event_type === "change_deduplicated"),
			).toMatchObject({
				subject_type: "backlog_proposal_duplicate_resolution",
				actor_kind: "system",
				actor_id: null,
				payload: { changeIndex: 4, existingEntityType: "story" },
			});
			expect(JSON.stringify(rows)).not.toMatch(
				/example private|example omitted|example secret|pmConfig|pmSyncOverride|title/,
			);
		});
		it("does not export an entry whose proposal differs from its review parent", async () => {
			await proposal();
			await review();
			await proposal(null, "c000000000000000000000024");
			await client.query(
				`INSERT INTO pending_backlog_proposal_review_entry (id,"reviewId","proposalId","offeredIndex",selected) VALUES ('c000000000000000000000021','c000000000000000000000020','c000000000000000000000024',0,false)`,
			);
			expect(
				(await events()).filter(
					(r) => r.event_type === "change_reviewed",
				),
			).toEqual([]);
		});

		it("uses one statement trigger with a transition table and guarded bulk capture", async () => {
			const result = await client.query(
				`SELECT tgtype::int, tgnewtable, pg_get_functiondef(tgfoid) AS body FROM pg_trigger WHERE tgname='decision_event_review_entries'`,
			);
			expect(result.rows).toHaveLength(1);
			expect(result.rows[0].tgtype & 1).toBe(0);
			expect(result.rows[0].tgnewtable).toBe("inserted_entries");
			expect(result.rows[0].body).toContain("IF pg_trigger_depth() > 1");
			expect(result.rows[0].body).toContain("AS MATERIALIZED");
			for (const name of [
				"capture_review",
				"capture_duplicate_resolution",
			]) {
				const result = await client.query(
					`SELECT pg_get_functiondef(oid) AS body FROM pg_proc WHERE pronamespace='lakehouse_export'::regnamespace AND proname=$1`,
					[name],
				);
				expect(result.rows[0].body).toContain(
					"IF pg_trigger_depth() > 1",
				);
			}
		});
		it.each(["review", "entries", "duplicate"])(
			"skips %s capture when disabled",
			async (kind) => {
				await proposal();
				await client.query(
					`UPDATE organization_feature_flag_override SET enabled=false WHERE key='DECISION_REPLAY'`,
				);
				await outcome(kind);
				expect((await events()).map((r) => r.event_type)).toEqual([
					"proposed",
				]);
			},
		);
		it.each(["review", "entries", "duplicate"])(
			"skips %s capture for cross-org proposal mismatch",
			async (kind) => {
				await client.query(
					`INSERT INTO organization (id,name,"createdAt") VALUES ('c00000000000000000000000b','Example',now())`,
				);
				await proposal("c00000000000000000000000b");
				await outcome(kind);
				expect(await events()).toEqual([]);
			},
		);
		it.each(["review", "entries", "duplicate"])(
			"fails open on %s export insert failure",
			async (kind) => {
				await proposal();
				await client.query(
					`ALTER TABLE lakehouse_export.decision_event ADD CONSTRAINT example_block_new_capture CHECK(event_type NOT IN ('proposal_reviewed','change_reviewed','change_deduplicated'))`,
				);
				await outcome(kind);
				expect((await events()).map((r) => r.event_type)).toEqual([
					"proposed",
				]);
				const table =
					kind === "duplicate"
						? "pending_backlog_proposal_duplicate_resolution"
						: kind === "entries"
							? "pending_backlog_proposal_review_entry"
							: "pending_backlog_proposal_review";
				const count = await client.query(
					`SELECT count(*)::int AS n FROM ${table}`,
				);
				expect(count.rows[0].n).toBeGreaterThan(0);
			},
		);
		it("skips review, entry and duplicate captures invoked by a nested source trigger", async () => {
			await client.query(`CREATE FUNCTION pg_temp.example_nested_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   INSERT INTO public.pending_backlog_proposal_review (id,"proposalId","reviewedBy","offeredCount","selectedCount","offeredListComplete","syncToPM") VALUES ('c000000000000000000000020',NEW.id,'c000000000000000000000003',1,0,true,false);
   INSERT INTO public.pending_backlog_proposal_review_entry (id,"proposalId","reviewId","offeredIndex",selected) VALUES ('c000000000000000000000021',NEW.id,'c000000000000000000000020',0,false);
   INSERT INTO public.pending_backlog_proposal_duplicate_resolution (id,"proposalId","changeIndex") VALUES ('c000000000000000000000023',NEW.id,0);
   RETURN NULL; END $$`);
			await client.query(
				"CREATE TRIGGER example_nested_review AFTER INSERT ON public.pending_backlog_proposal FOR EACH ROW EXECUTE FUNCTION pg_temp.example_nested_review()",
			);
			await proposal();
			expect((await events()).map((r) => r.event_type)).toEqual([
				"proposed",
			]);
			expect(
				(
					await client.query(
						"SELECT count(*)::int AS n FROM pending_backlog_proposal_review_entry",
					)
				).rows[0].n,
			).toBe(1);
		});

		it.each(["TEAMS_CHANNEL", "SLACK_CHANNEL"])(
			"captures inline %s create application once on repeated record",
			async (source) => {
				await proposal();
				await client.query(
					`UPDATE pending_backlog_proposal SET source=$1::"PendingBacklogProposalSource" WHERE id='c000000000000000000000005'`,
					[source],
				);
				await story();
				for (let i = 0; i < 2; i++) {
					await client.query(
						`INSERT INTO pending_backlog_proposal_application (id,"proposalId","changeIndex",action,"createdEntityType","createdEntityId") VALUES ($1,'c000000000000000000000005',0,'create','story','c000000000000000000000006') ON CONFLICT ("proposalId","changeIndex") DO NOTHING`,
						[randomUUID()],
					);
				}
				const rows = (await events()).filter(
					(r) => r.event_type === "change_applied",
				);
				expect(rows).toHaveLength(1);
				expect(rows[0].payload).toEqual({
					changeIndex: 0,
					action: "create",
					createdEntityType: "story",
					createdEntityId: "c000000000000000000000006",
				});
			},
		);
		it.each([
			[
				"proposal_reviewed",
				{
					source: "example free text",
					offeredCount: -10,
					selectedCount: 1e30,
					offeredListComplete: "true",
					title: "example secret",
				},
				{
					source: "unknown",
					offeredCount: 0,
					selectedCount: 2147483647,
					offeredListComplete: null,
				},
			],
			[
				"change_reviewed",
				{
					reviewId: "dev@example.com",
					offeredIndex: -10,
					changeIndex: 1e30,
					selected: "false",
					change: { title: "example secret" },
				},
				{
					reviewId: null,
					offeredIndex: 0,
					changeIndex: 2147483647,
					selected: null,
				},
			],
			[
				"change_reviewed",
				{
					reviewId: "c000000000000000000000020",
					offeredIndex: "5",
					changeIndex: null,
					selected: false,
				},
				{
					reviewId: "c000000000000000000000020",
					offeredIndex: null,
					changeIndex: null,
					selected: false,
				},
			],
			[
				"change_deduplicated",
				{
					changeIndex: -1,
					existingEntityType: "example secret",
					existingEntityId: "example private",
				},
				{ changeIndex: 0, existingEntityType: "unknown" },
			],
		])("sanitizes hostile %s payload %j", async (type, payload, want) => {
			await client.query(
				`INSERT INTO lakehouse_export.decision_event (organization_id,project_id,subject_type,event_type,actor_kind,payload) VALUES ('c000000000000000000000001','c000000000000000000000002','backlog_proposal_review',$1,'system',$2::jsonb)`,
				[type, JSON.stringify(payload)],
			);
			expect((await events())[0].payload).toEqual(want);
		});

		it("captures proposal insert, review, system transition and parent-org fallback with approved payload only", async () => {
			await proposal(null);
			await client.query(
				`UPDATE pending_backlog_proposal SET status = 'APPROVED', "reviewedAt" = now(), "reviewedBy" = 'c000000000000000000000003' WHERE id = 'c000000000000000000000005'`,
			);
			await client.query(
				`UPDATE pending_backlog_proposal SET status = 'FAILED', "errorClass" = 'TimedOut', "applyError" = 'example content' WHERE id = 'c000000000000000000000005'`,
			);
			await client.query(
				`UPDATE pending_backlog_proposal SET summary = 'example changed content', status = status WHERE id = 'c000000000000000000000005'`,
			);
			const rows = await events();
			expect(rows).toHaveLength(3);
			expect(
				rows.map((r) => [
					r.event_type,
					r.from_state,
					r.to_state,
					r.actor_kind,
					r.actor_id,
				]),
			).toEqual([
				["proposed", null, "PENDING", "system", null],
				[
					"status_changed",
					"PENDING",
					"APPROVED",
					"human",
					"c000000000000000000000003",
				],
				["status_changed", "APPROVED", "FAILED", "system", null],
			]);
			for (const row of rows) {
				expect(row.organization_id).toBe("c000000000000000000000001");
				expect(keys(row.payload)).toEqual([
					"changeCount",
					"errorClass",
					"source",
				]);
			}
			expect(rows[2].payload).toEqual({
				source: "AI_UPDATE_SIDEBAR",
				changeCount: 2,
				errorClass: "TimedOut",
			});
		});

		it.each([
			[
				"64 lowercase hex",
				`backlog-apply-op-${"0123456789abcdef".repeat(4)}`,
				true,
			],
			["63 hex", `backlog-apply-op-${"a".repeat(63)}`, false],
			["65 hex", `backlog-apply-op-${"a".repeat(65)}`, false],
			["uppercase hex", `backlog-apply-op-${"A".repeat(64)}`, false],
			["suffix", `backlog-apply-op-${"a".repeat(64)}-suffix`, false],
			["free text", "backlog-apply-op-example text with spaces", false],
		] as const)(
			"sanitizes direct-apply proposal ids with %s across the captured lifecycle",
			async (_label, proposalId, preserved) => {
				await proposal("c000000000000000000000001", proposalId);
				await client.query(
					`UPDATE pending_backlog_proposal SET status = 'APPLIED' WHERE id = $1`,
					[proposalId],
				);
				await client.query(
					`INSERT INTO pending_backlog_proposal_application (id, "proposalId", "changeIndex", action, "createdEntityType", "createdEntityId") VALUES ('c000000000000000000000008', $1, 0, 'create', 'story', 'c000000000000000000000006')`,
					[proposalId],
				);
				await story("c000000000000000000000006", proposalId);
				await client.query(
					`UPDATE user_story SET "lastEditedAt" = clock_timestamp(), "lastEditedSource" = 'MANUAL' WHERE id = 'c000000000000000000000006'`,
				);
				const expectedId = preserved ? proposalId : null;
				expect(
					(await events()).map((row) => [
						row.event_type,
						row.subject_id,
						row.related_subject_id,
					]),
				).toEqual([
					["proposed", expectedId, null],
					["status_changed", expectedId, null],
					["change_applied", "c000000000000000000000008", expectedId],
					["story_edited", "c000000000000000000000006", expectedId],
				]);
			},
		);

		it.each(["story", "bug", "epic", "feature"])(
			"captures applied %s changes through their parent with approved payload only",
			async (entityType) => {
				await proposal();
				await client.query(
					`INSERT INTO pending_backlog_proposal_application (id, "proposalId", "changeIndex", action, "createdEntityType", "createdEntityId") VALUES ('c000000000000000000000008', 'c000000000000000000000005', 0, 'create', $1, 'c000000000000000000000006')`,
					[entityType],
				);
				const row = (await events())[1];
				expect(row).toMatchObject({
					event_type: "change_applied",
					subject_id: "c000000000000000000000008",
					related_subject_id: "c000000000000000000000005",
					organization_id: "c000000000000000000000001",
					project_id: "c000000000000000000000002",
					actor_kind: "system",
				});
				expect(row.payload).toEqual({
					changeIndex: 0,
					action: "create",
					createdEntityType: entityType,
					createdEntityId: "c000000000000000000000006",
				});
				expect(keys(row.payload)).toEqual([
					"action",
					"changeIndex",
					"createdEntityId",
					"createdEntityType",
				]);
			},
		);

		it("captures rating, changed outcome and clearing, excluding comment-only and no-op writes", async () => {
			await rating();
			await client.query(
				`UPDATE ai_outcome_event SET comment = 'example changed content', outcome = outcome WHERE id = 'c000000000000000000000009'`,
			);
			await client.query(
				`UPDATE ai_outcome_event SET outcome = 'RATED_DOWN' WHERE id = 'c000000000000000000000009'`,
			);
			await client.query(
				`DELETE FROM ai_outcome_event WHERE id = 'c000000000000000000000009'`,
			);
			const rows = await events();
			expect(
				rows.map((r) => [r.event_type, r.from_state, r.to_state]),
			).toEqual([
				["rated", null, "RATED_UP"],
				["re_rated", "RATED_UP", "RATED_DOWN"],
				["rating_cleared", "RATED_DOWN", null],
			]);
			for (const row of rows) {
				expect(row).toMatchObject({
					feature_key: "maturation",
					model: "example-model",
					prompt_version_id: "c00000000000000000000000f",
					actor_kind: "human",
					actor_id: "c000000000000000000000003",
				});
				expect(keys(row.payload)).toEqual([]);
			}
		});

		it("captures duplicate status transitions with resolver provenance, excluding unrelated writes", async () => {
			await story();
			await story("c000000000000000000000007");
			await client.query(
				`INSERT INTO story_duplicate_link (id, "projectId", "storyAId", "storyBId", similarity, confidence, "updatedAt") VALUES ('example-link', 'c000000000000000000000002', 'c000000000000000000000006', 'c000000000000000000000007', 0.9, 0.9, now())`,
			);
			await client.query(
				`UPDATE story_duplicate_link SET reasoning = 'example content', status = status WHERE id = 'example-link'`,
			);
			await client.query(
				`UPDATE story_duplicate_link SET status = 'DISMISSED', "resolvedById" = 'c000000000000000000000003' WHERE id = 'example-link'`,
			);
			await client.query(
				`UPDATE story_duplicate_link SET status = 'PENDING', "resolvedById" = NULL WHERE id = 'example-link'`,
			);
			const rows = await events();
			expect(
				rows.map((r) => [
					r.event_type,
					r.from_state,
					r.to_state,
					r.actor_kind,
					r.actor_id,
				]),
			).toEqual([
				["duplicate_detected", null, "PENDING", "ai", null],
				[
					"duplicate_dismissed",
					"PENDING",
					"DISMISSED",
					"human",
					"c000000000000000000000003",
				],
				[
					"duplicate_status_changed",
					"DISMISSED",
					"PENDING",
					"system",
					null,
				],
			]);
			for (const row of rows) {
				expect(row.organization_id).toBe("c000000000000000000000001");
				expect(keys(row.payload)).toEqual(
					row.event_type === "duplicate_detected"
						? ["confidence", "linkType", "similarity"]
						: [],
				);
			}
		});

		it.each([
			["MANUAL", "human"],
			["CONFLICT_RESOLUTION", "human"],
			["AI_BACKLOG_UPDATE", "ai"],
			["AI_MATURATION", "ai"],
			["PM_PULL", "system"],
			[null, "unknown"],
		])(
			"captures semantic story edits from %s without exporting names",
			async (source, kind) => {
				await story();
				await story("c00000000000000000000000c", null);
				await client.query(
					`UPDATE user_story SET "lastEditedAt" = clock_timestamp(), "lastEditedSource" = $1::"LastEditSource", "lastEditedByName" = 'Example' WHERE "projectId" = 'c000000000000000000000002'`,
					[source],
				);
				await client.query(
					`UPDATE user_story SET "summaryDigest" = 'example content', "lastSummaryHash" = 'example-hash', "updatedAt" = clock_timestamp(), "lastEditedAt" = "lastEditedAt" WHERE "projectId" = 'c000000000000000000000002'`,
				);
				const rows = await events();
				expect(rows).toHaveLength(1);
				expect(rows[0]).toMatchObject({
					event_type: "story_edited",
					subject_id: "c000000000000000000000006",
					related_subject_id: "c000000000000000000000005",
					actor_kind: kind,
					actor_id: null,
				});
				expect(keys(rows[0].payload)).toEqual([]);
			},
		);

		it.each(["disabled", "absent", "unresolved"])(
			"skips all trigger paths for %s organizations",
			async (mode) => {
				await client.query(
					`DELETE FROM feature_flag_override WHERE key = 'DECISION_REPLAY'`,
				);
				if (mode === "disabled") {
					await client.query(
						`UPDATE organization_feature_flag_override SET enabled = false WHERE key = 'DECISION_REPLAY' AND "organizationId" = 'c000000000000000000000001'`,
					);
				}
				if (mode === "absent") {
					await client.query(
						`DELETE FROM organization_feature_flag_override WHERE key = 'DECISION_REPLAY'`,
					);
				}
				if (mode === "unresolved") {
					await client.query(
						`UPDATE project SET "organizationId" = NULL WHERE id = 'c000000000000000000000002'`,
					);
					await client.query(
						`INSERT INTO feature_flag_override (key, enabled, "updatedBy", "updatedAt") VALUES ('DECISION_REPLAY', true, 'c000000000000000000000003', now())`,
					);
				}
				await proposal(
					mode === "unresolved" ? null : "c000000000000000000000001",
				);
				await client.query(
					`UPDATE pending_backlog_proposal SET status = 'APPROVED' WHERE id = 'c000000000000000000000005'`,
				);
				await client.query(
					`INSERT INTO pending_backlog_proposal_application (id, "proposalId", "changeIndex", action) VALUES ('c000000000000000000000008', 'c000000000000000000000005', 0, 'update')`,
				);
				await rating(
					mode === "unresolved" ? null : "c000000000000000000000001",
				);
				await client.query(
					`UPDATE ai_outcome_event SET outcome = 'RATED_DOWN', "organizationId" = ${mode === "unresolved" ? "NULL" : '"organizationId"'} WHERE id = 'c000000000000000000000009'`,
				);
				await client.query(
					`DELETE FROM ai_outcome_event WHERE id = 'c000000000000000000000009'`,
				);
				await story();
				await story("c000000000000000000000007");
				await client.query(
					`UPDATE user_story SET "lastEditedAt" = clock_timestamp(), "lastEditedSource" = 'MANUAL' WHERE "projectId" = 'c000000000000000000000002'`,
				);
				await client.query(
					`INSERT INTO story_duplicate_link (id, "projectId", "storyAId", "storyBId", similarity, confidence, "updatedAt") VALUES ('example-link', 'c000000000000000000000002', 'c000000000000000000000006', 'c000000000000000000000007', 0.9, 0.9, now())`,
				);
				await client.query(
					`UPDATE story_duplicate_link SET status = 'DISMISSED' WHERE id = 'example-link'`,
				);
				expect(await events()).toEqual([]);
			},
		);

		it.each(
			[true, false, undefined].flatMap((org) =>
				[true, false, undefined].map((global) => ({ org, global })),
			),
		)(
			"matches the app resolver for org=$org global=$global",
			async ({ org, global }) => {
				// These committed rows are visible to the app resolver's separate pool.
				const orgId = `example-org-${randomUUID()}`;
				const previous = await db.featureFlagOverride.findUnique({
					where: { key: "DECISION_REPLAY" },
				});
				await db.organization.create({
					data: { id: orgId, name: "Example", createdAt: new Date() },
				});
				try {
					await db.featureFlagOverride.deleteMany({
						where: { key: "DECISION_REPLAY" },
					});
					if (global !== undefined) {
						await db.featureFlagOverride.create({
							data: {
								key: "DECISION_REPLAY",
								enabled: global,
								updatedBy: "c000000000000000000000003",
							},
						});
					}
					if (org !== undefined) {
						await db.organizationFeatureFlagOverride.create({
							data: {
								key: "DECISION_REPLAY",
								organizationId: orgId,
								enabled: org,
								updatedBy: "c000000000000000000000003",
							},
						});
					}
					const sql = await client.query(
						"SELECT lakehouse_export.capture_enabled($1) AS enabled",
						[orgId],
					);
					const app = await getOrgFlagStateUncached(
						"DECISION_REPLAY",
						orgId,
					);
					expect(sql.rows[0].enabled).toBe(org ?? global ?? false);
					expect(sql.rows[0].enabled).toBe(app.enabled);
					expect(
						(
							await client.query(
								"SELECT lakehouse_export.capture_enabled(NULL) AS enabled",
							)
						).rows[0].enabled,
					).toBe(false);
				} finally {
					await db.organization.delete({ where: { id: orgId } });
					await db.featureFlagOverride.deleteMany({
						where: { key: "DECISION_REPLAY" },
					});
					if (previous) {
						await db.featureFlagOverride.create({ data: previous });
					}
				}
			},
		);

		it("commits the business update when the event insert fails, without leaking error text in warnings", async () => {
			// Discard the shared transactional fixtures before this case commits.
			await client.query("ROLLBACK");
			await client.query("BEGIN");
			// Every identifier and constraint is unique even if cleanup fails.
			const [orgId, userId, projectId, proposalId] = Array.from(
				{ length: 4 },
				() => randomUUID(),
			);
			const constraint = `example_capture_${randomUUID().replaceAll("-", "")}`;
			const warnings: string[] = [];
			const notice = (n: { message?: string }) =>
				warnings.push(n.message ?? "");
			client.on("notice", notice);
			try {
				await client.query(
					`INSERT INTO organization (id,name,"createdAt") VALUES ($1,'Example',now())`,
					[orgId],
				);
				await client.query(
					`INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Example',$2,false,now(),now())`,
					[userId, `${userId}@example.com`],
				);
				await client.query(
					`INSERT INTO project (id,name,"userId","organizationId","updatedAt") VALUES ($1,'Example',$2,$3,now())`,
					[projectId, userId, orgId],
				);
				await client.query(
					`INSERT INTO organization_feature_flag_override (key,"organizationId",enabled,"updatedBy","updatedAt") VALUES ('DECISION_REPLAY',$1,true,$2,now())`,
					[orgId, userId],
				);
				await client.query(
					`INSERT INTO pending_backlog_proposal (id,"projectId",source,proposal,summary,"organizationId") VALUES ($1,$2,'AI_UPDATE_SIDEBAR','{}','Example',$3)`,
					[proposalId, projectId, orgId],
				);
				await client.query(
					`ALTER TABLE lakehouse_export.decision_event ADD CONSTRAINT ${constraint} CHECK (subject_id <> '${proposalId}' OR event_type <> 'status_changed')`,
				);
				await client.query(
					`UPDATE pending_backlog_proposal SET status='APPROVED' WHERE id=$1`,
					[proposalId],
				);
				await client.query("COMMIT");
				expect(
					(
						await client.query(
							"SELECT status FROM pending_backlog_proposal WHERE id=$1",
							[proposalId],
						)
					).rows,
				).toEqual([{ status: "APPROVED" }]);
				expect(
					(
						await client.query(
							"SELECT event_type FROM lakehouse_export.decision_event WHERE organization_id=$1",
							[orgId],
						)
					).rows,
				).toEqual([{ event_type: "proposed" }]);
				expect(warnings).toEqual([
					"decision_event capture failed (proposal), SQLSTATE 23514",
				]);
			} finally {
				client.off("notice", notice);
				await client.query("ROLLBACK");
				await client.query(
					`ALTER TABLE lakehouse_export.decision_event DROP CONSTRAINT IF EXISTS ${constraint}`,
				);
				await client.query("DELETE FROM organization WHERE id=$1", [
					orgId,
				]);
				await client.query(`DELETE FROM "user" WHERE id=$1`, [userId]);
			}
		});

		it("uses FULL replica identity only in the export schema and has no array columns", async () => {
			expect(
				(
					await client.query(
						`SELECT relreplident FROM pg_class WHERE oid = 'lakehouse_export.decision_event'::regclass`,
					)
				).rows,
			).toEqual([{ relreplident: "f" }]);
			expect(
				(
					await client.query(
						`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relreplident = 'f'`,
					)
				).rows,
			).toEqual([]);
			expect(
				(
					await client.query(
						`SELECT column_name FROM information_schema.columns WHERE table_schema = 'lakehouse_export' AND table_name = 'decision_event' AND data_type = 'ARRAY'`,
					)
				).rows,
			).toEqual([]);
		});

		it.each([
			"UPDATE lakehouse_export.decision_event SET to_state = to_state",
			"DELETE FROM lakehouse_export.decision_event",
			"TRUNCATE lakehouse_export.decision_event",
		])("rejects mutation even for the owner: %s", async (sql) => {
			await proposal();
			await expect(client.query(sql)).rejects.toMatchObject({
				code: "55000",
			});
		});

		it("enforces non-owner organization isolation with enabled RLS and denies anonymous function execution", async () => {
			const readerRole = `example_replay_reader_${randomUUID().replaceAll("-", "")}`;
			fixtureRoles.push(readerRole);
			await proposal();
			await client.query(
				`CREATE ROLE ${readerRole} NOSUPERUSER NOBYPASSRLS`,
			);
			await client.query(
				`GRANT USAGE ON SCHEMA lakehouse_export TO ${readerRole}`,
			);
			await client.query(
				`GRANT SELECT ON lakehouse_export.decision_event TO ${readerRole}`,
			);
			const rls = await client.query(
				`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'lakehouse_export.decision_event'::regclass`,
			);
			expect(rls.rows).toEqual([
				{ relrowsecurity: true, relforcerowsecurity: false },
			]);
			await client.query(`SET LOCAL ROLE ${readerRole}`);
			expect(await events()).toEqual([]);
			await client.query(
				`SELECT set_config('app.tenant_type', 'organization', true), set_config('app.tenant_id', 'c000000000000000000000001', true)`,
			);
			expect(await events()).toHaveLength(1);
			await client.query(
				`SELECT set_config('app.tenant_id', 'c00000000000000000000000b', true)`,
			);
			expect(await events()).toEqual([]);
			await expect(
				client.query(
					`SELECT lakehouse_export.capture_enabled('c000000000000000000000001')`,
				),
			).rejects.toMatchObject({ code: "42501" });
		});

		it.each([false, true])(
			"preflight reports source visibility under real policies with app bypass=%s",
			async (bypass) => {
				await proposal();
				await restrictedDeletionOwner(bypass);
				await client.query(
					"GRANT CREATE ON SCHEMA public TO fabric_app",
				);
				for (const table of ["project", "prompt_version"]) {
					await client.query(
						`ALTER TABLE public.${table} OWNER TO fabric_app`,
					);
				}
				// These are the production app_bypass policies installed by deploy:rls.
				// The restricted host removes them; no test-only owner read policy exists.

				for (const table of ["project", "prompt_version"]) {
					expect(
						(
							await client.query(
								"SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass",
								[`public.${table}`],
							)
						).rows,
					).toEqual([
						{ relrowsecurity: true, relforcerowsecurity: true },
					]);
				}
				// restrictedDeletionOwner left a valid tenant context: preflight must refuse it.
				await client.query("SET LOCAL ROLE fabric_app");
				await client.query(
					"SAVEPOINT example_preflight_tenant_context",
				);
				await expect(
					client.query(
						"SELECT * FROM lakehouse_export.capture_preflight()",
					),
				).rejects.toMatchObject({ code: "55000" });
				await client.query(
					"ROLLBACK TO SAVEPOINT example_preflight_tenant_context",
				);
				await client.query(
					`SELECT set_config('app.tenant_type','none',true),set_config('app.tenant_id','',true),set_config('app.user_id','',true)`,
				);
				// Empty override tables are normal and must not block preflight.
				// Restore them before verifying capture still uses its enabled flag.
				await client.query("SAVEPOINT example_preflight_empty_flags");
				await client.query("DELETE FROM feature_flag_override");
				await client.query(
					"DELETE FROM organization_feature_flag_override",
				);
				const rows = (
					await client.query(
						"SELECT * FROM lakehouse_export.capture_preflight() ORDER BY table_name",
					)
				).rows;
				expect(rows.map((r) => r.table_name)).toEqual(
					preflightTables.map((t) => `public.${t}`).sort(),
				);
				for (const row of rows) {
					expect(row.passed, row.table_name).toBe(
						bypass ||
							![
								"public.project",
								"public.prompt_version",
								"public.pending_backlog_proposal",
							].includes(row.table_name),
					);
				}
				expect(
					rows.find((r) => r.table_name === "public.project"),
				).toEqual({
					table_name: "public.project",
					owner_sees_rows: bypass,
					passed: bypass,
				});
				expect(
					rows.find((r) => r.table_name === "public.prompt_version"),
				).toEqual({
					table_name: "public.prompt_version",
					owner_sees_rows: bypass,
					passed: bypass,
				});
				await client.query(
					"ROLLBACK TO SAVEPOINT example_preflight_empty_flags",
				);
				await client.query(
					"RELEASE SAVEPOINT example_preflight_empty_flags",
				);
				await client.query("RESET ROLE");
				await client.query(
					`SELECT set_config('app.tenant_type','',true),set_config('app.tenant_id','',true),set_config('app.user_id','',true)`,
				);
				await client.query(
					`UPDATE pending_backlog_proposal SET status='APPROVED' WHERE id='c000000000000000000000005'`,
				);
				expect((await events()).map((r) => r.event_type)).toEqual(
					bypass ? ["proposed", "status_changed"] : ["proposed"],
				);
			},
		);

		it("preflight rejects empty source tables even for an unrestricted owner", async () => {
			const rows = (
				await client.query(
					"SELECT * FROM lakehouse_export.capture_preflight()",
				)
			).rows;
			expect(rows.every((row) => row.passed)).toBe(false);
			expect(
				rows.find(
					(row) =>
						row.table_name === "public.pending_backlog_proposal",
				),
			).toEqual({
				table_name: "public.pending_backlog_proposal",
				owner_sees_rows: false,
				passed: false,
			});
		});

		it("keeps capture function privileges, search paths and trigger WHEN guards", async () => {
			const functions =
				await client.query(`SELECT p.proname, p.prosecdef, p.proconfig,
   p.proowner = (SELECT relowner FROM pg_class WHERE oid = 'lakehouse_export.decision_event'::regclass) AS owner_matches_table,
   EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute
   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'lakehouse_export'`);
			expect(functions.rows).toHaveLength(15);
			for (const fn of functions.rows) {
				expect(fn.prosecdef).toBe(true);
				expect(fn.owner_matches_table).toBe(true);
				// No app.* SET clauses: the non-superuser migration role cannot create them.
				expect(fn.proconfig).toEqual([
					"search_path=pg_catalog, public",
				]);
				expect(fn.public_execute).toBe(false);
			}
			const guards = await client.query(
				`SELECT tgname FROM pg_trigger WHERE tgname IN ('decision_event_proposal_status','decision_event_outcome_update','decision_event_duplicate','decision_event_story_edit') AND tgqual IS NOT NULL AND tgenabled = 'O'`,
			);
			expect(guards.rows).toHaveLength(4);
		});

		it("maps unapproved free-text classifications to unknown", async () => {
			await proposal();
			await client.query(
				`UPDATE pending_backlog_proposal SET status = 'FAILED', "errorClass" = 'example arbitrary error content' WHERE id = 'c000000000000000000000005'`,
			);
			await client.query(
				`INSERT INTO pending_backlog_proposal_application (id, "proposalId", "changeIndex", action, "createdEntityType") VALUES ('c000000000000000000000008', 'c000000000000000000000005', 0, 'example arbitrary action', 'example arbitrary type')`,
			);
			const rows = await events();
			expect(rows[1].payload.errorClass).toBe("unknown");
			expect(rows[2].payload).toEqual({
				changeIndex: 0,
				action: "unknown",
				createdEntityType: "unknown",
				createdEntityId: null,
			});
		});

		const actor = async () =>
			client.query(
				`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ('c00000000000000000000000a', 'Example', 'actor@example.com', false, now(), now())`,
			);
		const probe = async () => {
			await client.query(
				"CREATE TEMP TABLE example_capture_probe (event_type text, source_depth integer) ON COMMIT DROP",
			);
			await client.query(
				"CREATE FUNCTION pg_temp.example_capture_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO pg_temp.example_capture_probe VALUES (NEW.event_type, pg_trigger_depth() - 1); RETURN NULL; END $$",
			);
			await client.query(
				"CREATE TRIGGER example_capture_probe AFTER INSERT ON lakehouse_export.decision_event FOR EACH ROW EXECUTE FUNCTION pg_temp.example_capture_probe()",
			);
		};
		it.each(["organization", "project"])(
			"erases %s events and resets purge permission before the next statement",
			async (parent) => {
				await proposal();
				await client.query(
					`DELETE FROM public.${parent} WHERE id = $1`,
					[
						parent === "organization"
							? "c000000000000000000000001"
							: "c000000000000000000000002",
					],
				);
				expect(await events()).toEqual([]);
				expect(
					(
						await client.query(
							`SELECT current_setting('lakehouse_export.purge', true) AS setting`,
						)
					).rows[0].setting,
				).not.toBe("on");
				await expect(
					client.query("DELETE FROM lakehouse_export.decision_event"),
				).rejects.toMatchObject({ code: "55000" });
			},
		);
		it("redacts a deleted actor while preserving the organization's review history", async () => {
			await actor();
			await proposal();
			await client.query(
				`UPDATE pending_backlog_proposal SET status='APPROVED', "reviewedAt"=now(), "reviewedBy"='c00000000000000000000000a' WHERE id='c000000000000000000000005'`,
			);
			await client.query(
				`DELETE FROM public."user" WHERE id='c00000000000000000000000a'`,
			);
			const rows = await events();
			expect(rows.map((r) => r.event_type)).toEqual([
				"proposed",
				"status_changed",
			]);
			expect(rows.every((r) => r.actor_id === null)).toBe(true);
			await expect(
				client.query(
					"UPDATE lakehouse_export.decision_event SET actor_id=NULL",
				),
			).rejects.toMatchObject({ code: "55000" });
		});
		it.each(["organization", "project", "user"])(
			"does not capture a rating deletion cascading from %s",
			async (parent) => {
				await actor();
				await rating();
				await client.query(
					`UPDATE ai_outcome_event SET "userId"='c00000000000000000000000a' WHERE id='c000000000000000000000009'`,
				);
				await probe();
				await client.query(
					`DELETE FROM public."${parent}" WHERE id=$1`,
					[
						parent === "organization"
							? "c000000000000000000000001"
							: parent === "project"
								? "c000000000000000000000002"
								: "c00000000000000000000000a",
					],
				);
				expect(
					(
						await client.query(
							"SELECT * FROM pg_temp.example_capture_probe",
						)
					).rows,
				).toEqual([]);
			},
		);
		it("distinguishes a direct rating deletion at source trigger depth one", async () => {
			await rating();
			await probe();
			await client.query(
				`DELETE FROM ai_outcome_event WHERE id='c000000000000000000000009'`,
			);
			expect(
				(
					await client.query(
						"SELECT * FROM pg_temp.example_capture_probe",
					)
				).rows,
			).toEqual([{ event_type: "rating_cleared", source_depth: 1 }]);
		});
		it.each(["proposal", "application", "rating"])(
			"skips %s events with a row/project organization mismatch",
			async (kind) => {
				await client.query(
					`INSERT INTO organization (id,name,"createdAt") VALUES ('c00000000000000000000000b','Example',now())`,
				);
				await client.query(
					`INSERT INTO organization_feature_flag_override (key,"organizationId",enabled,"updatedBy","updatedAt") VALUES ('DECISION_REPLAY','c00000000000000000000000b',true,'c000000000000000000000003',now())`,
				);
				// Both flags are enabled: only the ownership mismatch can skip capture.
				if (kind === "rating") {
					await rating("c00000000000000000000000b");
				} else {
					await proposal("c00000000000000000000000b");
					if (kind === "application") {
						await client.query(
							`INSERT INTO pending_backlog_proposal_application (id,"proposalId","changeIndex",action) VALUES ('c000000000000000000000008','c000000000000000000000005',0,'create')`,
						);
					}
				}
				expect(await events()).toEqual([]);
			},
		);
		it.each([
			"dev@example.com",
			"example sentence with spaces",
			"192.0.2.1",
			"2001:db8::1",
		])(
			"sanitizes client-controlled rating columns containing %s",
			async (value) => {
				await rating();
				await client.query(
					`UPDATE ai_outcome_event SET "subjectType"=$1,"subjectId"=$1,"featureKey"=$1,"modelCanonicalName"=$1,"promptVersionId"=$1,outcome='RATED_DOWN' WHERE id='c000000000000000000000009'`,
					[value],
				);
				const row = (await events())[1];
				expect(row).toMatchObject({
					subject_type: "unknown",
					subject_id: null,
					feature_key: "unknown",
					model: "unknown",
					prompt_version_id: null,
				});
				expect(JSON.stringify(row)).not.toContain(value);
			},
		);
		it.each([
			"dev@example.com",
			"example sentence with spaces",
			"jane-doe",
			"jane.doe",
			"5551234567",
		])(
			"sanitizes proposal/application/duplicate/story identifiers containing %s",
			async (value) => {
				await proposal();
				await client.query(
					`UPDATE pending_backlog_proposal SET id=$1 WHERE id='c000000000000000000000005'`,
					[value],
				);
				await client.query(
					`INSERT INTO pending_backlog_proposal_application (id,"proposalId","changeIndex",action,"createdEntityId") VALUES ($1,$1,0,'create',$1)`,
					[value],
				);
				await story("c000000000000000000000006", value);
				await story("c000000000000000000000007");
				await client.query(
					`UPDATE user_story SET "lastEditedAt"=clock_timestamp(),"lastEditedSource"='MANUAL' WHERE id='c000000000000000000000006'`,
				);
				await client.query(
					`INSERT INTO story_duplicate_link (id,"projectId","storyAId","storyBId",similarity,confidence,"updatedAt") VALUES ($1,'c000000000000000000000002','c000000000000000000000006','c000000000000000000000007',0.123456,0.987654,now())`,
					[value],
				);
				await client.query(
					`UPDATE story_duplicate_link SET status='DISMISSED',"resolvedById"=$1 WHERE id=$1`,
					[value],
				);
				const rows = (await events()).slice(1);
				expect(rows.length).toBe(4);
				expect(JSON.stringify(rows)).not.toContain(value);
				expect(rows[0]).toMatchObject({
					subject_id: null,
					related_subject_id: null,
					payload: { createdEntityId: null },
				});
				expect(rows[1].related_subject_id).toBeNull();
				expect(rows[3].actor_id).toBeNull();
			},
		);
		it("captures duplicate detection with rounded scores and no reasoning", async () => {
			await story();
			await story("c000000000000000000000007");
			await client.query(
				`INSERT INTO story_duplicate_link (id,"projectId","storyAId","storyBId",similarity,confidence,reasoning,"updatedAt") VALUES ('example-link','c000000000000000000000002','c000000000000000000000006','c000000000000000000000007',0.123456,0.987654,'example private sentence',now())`,
			);
			const rows = await events();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				event_type: "duplicate_detected",
				actor_kind: "ai",
				payload: {
					similarity: 0.1235,
					confidence: 0.9877,
					linkType: "DUPLICATE",
				},
			});
			expect(keys(rows[0].payload)).toEqual([
				"confidence",
				"linkType",
				"similarity",
			]);
		});
		it.each([
			"UPDATE lakehouse_export.decision_event SET actor_id=NULL",
			"DELETE FROM lakehouse_export.decision_event",
			"TRUNCATE lakehouse_export.decision_event",
		])(
			"does not accept a caller-set purge flag for direct SQL: %s",
			async (sql) => {
				await proposal();
				await client.query(
					`SELECT set_config('lakehouse_export.purge','on',true)`,
				);
				await expect(client.query(sql)).rejects.toMatchObject({
					code: "55000",
				});
			},
		);
		it("fails the parent deletion when event erasure fails", async () => {
			await proposal();
			await client.query(
				`CREATE FUNCTION pg_temp.example_reject_purge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'example purge failure'; END $$`,
			);
			await client.query(
				"CREATE TRIGGER example_reject_purge BEFORE DELETE ON lakehouse_export.decision_event FOR EACH ROW EXECUTE FUNCTION pg_temp.example_reject_purge()",
			);
			await client.query("SAVEPOINT example_before_delete");
			await expect(
				client.query(
					`DELETE FROM project WHERE id='c000000000000000000000002'`,
				),
			).rejects.toMatchObject({ message: "example purge failure" });
			await client.query("ROLLBACK TO SAVEPOINT example_before_delete");
			expect(
				(
					await client.query(
						`SELECT id FROM project WHERE id='c000000000000000000000002'`,
					)
				).rows,
			).toHaveLength(1);
			expect(await events()).toHaveLength(1);
		});

		it("skips a client rating with no session organization even when its project resolves", async () => {
			await rating(null);
			expect(await events()).toEqual([]);
		});
		it.each(["dev@example.com", "example sentence with spaces"])(
			"bounds every text column even for a direct export insert: %s",
			async (value) => {
				await client.query(
					`INSERT INTO lakehouse_export.decision_event (id,organization_id,project_id,subject_type,subject_id,event_type,from_state,to_state,actor_kind,actor_id,related_subject_id,feature_key,model,prompt_version_id,payload) VALUES ($1,'c000000000000000000000001','c000000000000000000000002',$1,$1,$1,$1,$1,$1,$1,$1,$1,$1,$1,jsonb_build_object('private',$1::text))`,
					[value],
				);
				const rows = await events();
				expect(rows).toHaveLength(1);
				expect(JSON.stringify(rows)).not.toContain(value);
				expect(rows[0]).toMatchObject({
					subject_type: "unknown",
					subject_id: null,
					event_type: "unknown",
					from_state: "unknown",
					to_state: "unknown",
					actor_kind: "unknown",
					actor_id: null,
					related_subject_id: null,
					feature_key: "unknown",
					model: "unknown",
					prompt_version_id: null,
					payload: null,
				});
			},
		);
		it.each(["organization_id", "project_id"])(
			"skips capture rather than losing erasure scope for a malformed %s",
			async (column) => {
				await client.query(
					`INSERT INTO lakehouse_export.decision_event (organization_id,project_id,subject_type,subject_id,event_type,actor_kind) VALUES ($1,$2,'story','c000000000000000000000006','rated','unknown')`,
					[
						column === "organization_id"
							? "dev@example.com"
							: "c000000000000000000000001",
						column === "project_id"
							? "example sentence with spaces"
							: "c000000000000000000000002",
					],
				);
				expect(await events()).toEqual([]);
			},
		);
		it.each([
			"organization",
			"project",
			"user",
			"pending_backlog_proposal",
			"user_story",
			"project_story_status",
		])(
			"does not record FK identifier cascades from %s as edits",
			async (parent) => {
				await actor();
				await proposal();
				await story();
				await story("c000000000000000000000007");
				await rating();
				await client.query(
					`UPDATE pending_backlog_proposal SET "reviewedBy"='c00000000000000000000000a' WHERE id='c000000000000000000000005'`,
				);
				await client.query(
					`UPDATE ai_outcome_event SET "userId"='c00000000000000000000000a' WHERE id='c000000000000000000000009'`,
				);
				await client.query(
					`INSERT INTO pending_backlog_proposal_application (id,"proposalId","changeIndex",action) VALUES ('c000000000000000000000008','c000000000000000000000005',0,'create')`,
				);
				await client.query(
					`INSERT INTO story_duplicate_link (id,"projectId","storyAId","storyBId",similarity,confidence,"updatedAt") VALUES ('example-link','c000000000000000000000002','c000000000000000000000006','c000000000000000000000007',0.1,0.2,now())`,
				);
				const before = await events();
				const id =
					parent === "organization"
						? "c000000000000000000000001"
						: parent === "project"
							? "c000000000000000000000002"
							: parent === "user"
								? "c00000000000000000000000a"
								: parent === "pending_backlog_proposal"
									? "c000000000000000000000005"
									: parent === "user_story"
										? "c000000000000000000000006"
										: "c000000000000000000000004";
				await client.query(
					`UPDATE public."${parent}" SET id=$1 WHERE id=$2`,
					[`${id}-renamed`, id],
				);
				expect(await events()).toEqual(before);
			},
		);
		it("does not record a transcript SetNull cascade as a semantic edit", async () => {
			await client.query(
				`INSERT INTO project_linked_meeting (id,"projectId","joinUrl") VALUES ('c00000000000000000000000d','c000000000000000000000002','https://example.com/meeting')`,
			);
			await client.query(
				`INSERT INTO project_meeting_transcript (id,"projectId","linkedMeetingId","meetingId","transcriptId") VALUES ('c00000000000000000000000e','c000000000000000000000002','c00000000000000000000000d','c00000000000000000000000d','c00000000000000000000000e')`,
			);
			await story();
			await client.query(
				`UPDATE user_story SET "sourceMeetingTranscriptId"='c00000000000000000000000e' WHERE id='c000000000000000000000006'`,
			);
			await client.query(
				`DELETE FROM project_meeting_transcript WHERE id='c00000000000000000000000e'`,
			);
			expect(
				(
					await client.query(
						`SELECT "sourceMeetingTranscriptId" FROM user_story WHERE id='c000000000000000000000006'`,
					)
				).rows,
			).toEqual([{ sourceMeetingTranscriptId: null }]);
			expect(await events()).toEqual([]);
		});
		const restrictedDeletionOwner = async (sourceBypass = false) => {
			if (!sourceBypass) {
				for (const table of sourceTables) {
					await client.query(
						`DROP POLICY IF EXISTS app_bypass ON public."${table}"`,
					);
				}
			}
			for (const name of ["fabric_app", "fabric_worker"]) {
				if (
					(
						await client.query(
							"SELECT 1 FROM pg_roles WHERE rolname=$1",
							[name],
						)
					).rowCount === 0
				) {
					await client.query(
						`CREATE ROLE ${name} NOSUPERUSER NOBYPASSRLS`,
					);
					fixtureRoles.push(name);
				}
				// Exercise the restricted setup even if local roles already exist;
				// afterEach rolls these attribute changes back with the fixture.
				await client.query(
					`ALTER ROLE ${name} NOSUPERUSER NOBYPASSRLS`,
				);
			}
			await client.query(
				"GRANT USAGE,CREATE ON SCHEMA lakehouse_export TO fabric_app",
			);
			await client.query(
				"GRANT USAGE ON SCHEMA lakehouse_export,public TO fabric_app,fabric_worker",
			);
			await client.query(
				'GRANT SELECT ON public.project,public."user",public.organization,public.feature_flag_override,public.organization_feature_flag_override TO fabric_app',
			);
			await client.query(
				"GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO fabric_app,fabric_worker",
			);
			await client.query(
				"ALTER TABLE lakehouse_export.decision_event OWNER TO fabric_app",
			);
			const functions = await client.query(
				`SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='lakehouse_export'`,
			);
			for (const fn of functions.rows) {
				await client.query(
					`ALTER FUNCTION ${fn.signature} OWNER TO fabric_app`,
				);
			}
			await client.query(
				"DROP POLICY IF EXISTS app_bypass ON lakehouse_export.decision_event",
			);
			await client.query(
				"DROP POLICY IF EXISTS worker_bypass ON lakehouse_export.decision_event",
			);
			await client.query(
				"GRANT SELECT,UPDATE,DELETE,TRUNCATE ON lakehouse_export.decision_event TO fabric_app,fabric_worker",
			);
			// Use the actual tenant policies for deletion, without an owner read policy.
			await client.query(
				`SELECT set_config('app.tenant_type','organization',true),set_config('app.tenant_id','c000000000000000000000001',true),set_config('app.user_id','c000000000000000000000003',true)`,
			);
			expect(
				(
					await client.query(
						`SELECT r.rolsuper,r.rolbypassrls,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='lakehouse_export.decision_event'::regclass`,
					)
				).rows,
			).toEqual([
				{
					rolsuper: false,
					rolbypassrls: false,
					relrowsecurity: true,
					relforcerowsecurity: false,
				},
			]);
			expect(
				(
					await client.query(
						`SELECT polname FROM pg_policy WHERE polrelid='lakehouse_export.decision_event'::regclass AND polname IN ('app_bypass','worker_bypass')`,
					)
				).rows,
			).toEqual([]);
		};

		it.each(
			["fabric_app", "fabric_worker"].flatMap((role) =>
				["organization", "project", "user"].map((parent) => ({
					role,
					parent,
				})),
			),
		)(
			"erases $parent through $role with the restricted table owner and no export bypass",
			async ({ role, parent }) => {
				await actor();
				await proposal();
				await client.query(
					`UPDATE pending_backlog_proposal SET status='APPROVED',"reviewedAt"=now(),"reviewedBy"='c00000000000000000000000a' WHERE id='c000000000000000000000005'`,
				);
				await restrictedDeletionOwner();
				await client.query(`SET LOCAL ROLE ${role}`);
				expect(
					(
						await client.query(
							"SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
						)
					).rows,
				).toEqual([{ rolsuper: false, rolbypassrls: false }]);
				const deleted = await client.query(
					`DELETE FROM public."${parent}" WHERE id=$1`,
					[
						parent === "organization"
							? "c000000000000000000000001"
							: parent === "project"
								? "c000000000000000000000002"
								: "c00000000000000000000000a",
					],
				);
				expect(deleted.rowCount).toBe(1);
				await client.query("RESET ROLE");
				const rows = await events();
				expect(
					parent === "user"
						? rows.filter((r) => r.actor_id !== null)
						: rows,
				).toEqual([]);
				if (parent === "user") {
					expect(rows).toHaveLength(2);
				}
				await client.query(`SET LOCAL ROLE ${role}`);
				await expect(
					client.query("DELETE FROM lakehouse_export.decision_event"),
				).rejects.toMatchObject({ code: "55000" });
			},
		);

		it("fails user deletion if actor redaction cannot satisfy an event constraint", async () => {
			await actor();
			await proposal();
			await client.query(
				`UPDATE pending_backlog_proposal SET status='APPROVED',"reviewedAt"=now(),"reviewedBy"='c00000000000000000000000a' WHERE id='c000000000000000000000005'`,
			);
			await client.query(
				`ALTER TABLE lakehouse_export.decision_event ADD CONSTRAINT example_block_redaction CHECK (event_type<>'status_changed' OR actor_id IS NOT NULL)`,
			);
			await client.query("SAVEPOINT example_before_erasure");
			await expect(
				client.query(
					`DELETE FROM public."user" WHERE id='c00000000000000000000000a'`,
				),
			).rejects.toMatchObject({ code: "23514" });
			await client.query("ROLLBACK TO SAVEPOINT example_before_erasure");
			expect(
				(
					await client.query(
						`SELECT id FROM public."user" WHERE id='c00000000000000000000000a'`,
					)
				).rows,
			).toHaveLength(1);
			expect(
				(await events()).filter(
					(r) => r.actor_id === "c00000000000000000000000a",
				),
			).toHaveLength(1);
			expect(
				(
					await client.query(
						`SELECT current_setting('lakehouse_export.purge',true) AS flag`,
					)
				).rows[0].flag,
			).not.toBe("on");
		});
		it("permits the restricted table owner's unfiltered reads without a tenant context", async () => {
			await proposal();
			await restrictedDeletionOwner();
			await client.query(
				`SELECT set_config('app.tenant_type','none',true),set_config('app.tenant_id','',true),set_config('app.user_id','',true)`,
			);
			await client.query("SET LOCAL ROLE fabric_app");
			expect(await events()).toHaveLength(1);
		});
		it.each(
			["fabric_app", "fabric_worker"].flatMap((role) =>
				["organization", "project", "user"].map((parent) => ({
					role,
					parent,
				})),
			),
		)(
			"deletes $parent through $role with restricted owner and flag never configured",
			async ({ role, parent }) => {
				await actor();
				await restrictedDeletionOwner();
				expect(await events()).toEqual([]);
				expect(
					(
						await client.query(
							`SELECT key FROM organization_feature_flag_override WHERE key='DECISION_REPLAY'`,
						)
					).rows,
				).toEqual([]);
				expect(
					(
						await client.query(
							`SELECT key FROM feature_flag_override WHERE key='DECISION_REPLAY'`,
						)
					).rows,
				).toEqual([]);
				await client.query(`SET LOCAL ROLE ${role}`);
				const deleted = await client.query(
					`DELETE FROM public."${parent}" WHERE id=$1`,
					[
						parent === "organization"
							? "c000000000000000000000001"
							: parent === "project"
								? "c000000000000000000000002"
								: "c00000000000000000000000a",
					],
				);
				expect(deleted.rowCount).toBe(1);
				await client.query("RESET ROLE");
				expect(await events()).toEqual([]);
			},
		);
		it("does not call a distinct-verdict cache insert a duplicate detection", async () => {
			await story();
			await story("c000000000000000000000007");
			await client.query(
				`INSERT INTO story_duplicate_link (id,"projectId","storyAId","storyBId",similarity,confidence,status,"updatedAt") VALUES ('c000000000000000000000012','c000000000000000000000002','c000000000000000000000006','c000000000000000000000007',0.1,0.2,'NOT_DUPLICATE',now())`,
			);
			expect(await events()).toEqual([]);
		});
		it.each(["jane-doe", "jane.doe", "5551234567"])(
			"keeps the event but rejects shape-only client metadata: %s",
			async (value) => {
				await rating();
				await client.query(
					`UPDATE ai_outcome_event SET "subjectType"=$1,"subjectId"=$1,"featureKey"=$1,"modelCanonicalName"=$1,"promptVersionId"=$1,outcome='RATED_DOWN' WHERE id='c000000000000000000000009'`,
					[value],
				);
				const row = (await events())[1];
				expect(row).toMatchObject({
					subject_type: "unknown",
					subject_id: null,
					feature_key: "unknown",
					model: "unknown",
					prompt_version_id: null,
				});
			},
		);
		it("rejects a plausible unregistered model and prompt id but keeps the rating", async () => {
			await rating();
			await client.query(
				`UPDATE ai_outcome_event SET "modelCanonicalName"='example-unregistered-model',"promptVersionId"='c000000000000000000000099',outcome='RATED_DOWN' WHERE id='c000000000000000000000009'`,
			);
			expect((await events())[1]).toMatchObject({
				event_type: "re_rated",
				model: "unknown",
				prompt_version_id: null,
			});
		});
		it("keeps UUID-shaped subject identifiers", async () => {
			await rating();
			await client.query(
				`UPDATE ai_outcome_event SET "subjectId"='00000000-0000-4000-8000-000000000001',outcome='RATED_DOWN' WHERE id='c000000000000000000000009'`,
			);
			expect((await events())[1].subject_id).toBe(
				"00000000-0000-4000-8000-000000000001",
			);
		});
		// Each expectation is a literal cell; these do not call the SQL rule to compute an oracle.
		const org = "c000000000000000000000001";
		const otherOrg = "c00000000000000000000000b";
		const projectId = "c000000000000000000000002";
		const unknownProject = "c000000000000000000000099";
		const attributionCells = [
			// row org, project, server result, client result
			[null, null, null, null],
			[null, projectId, org, null],
			[null, unknownProject, null, null],
			[org, null, null, org],
			[org, projectId, org, org],
			[org, unknownProject, null, null],
			[otherOrg, null, null, otherOrg],
			[otherOrg, projectId, null, null],
			[otherOrg, unknownProject, null, null],
		] as const;
		it.each(
			[
				"pending_backlog_proposal",
				"pending_backlog_proposal_application",
				"pending_backlog_proposal_review",
				"pending_backlog_proposal_review_entry",
				"pending_backlog_proposal_duplicate_resolution",
				"story_duplicate_link",
				"user_story",
				"ai_outcome_event",
			].flatMap((source) =>
				attributionCells.map(
					([rowOrg, project, serverWant, clientWant]) => ({
						source,
						rowOrg,
						project,
						want:
							source === "ai_outcome_event"
								? clientWant
								: serverWant,
					}),
				),
			),
		)(
			"attribution $source row=$rowOrg project=$project => $want",
			async ({ source, rowOrg, project, want }) => {
				expect(
					(
						await client.query(
							"SELECT lakehouse_export.resolve_event_org($1,$2,$3) AS org",
							[source, rowOrg, project],
						)
					).rows,
				).toEqual([{ org: want }]);
			},
		);
		it.each([
			"pending_backlog_proposal",
			"pending_backlog_proposal_application",
			"pending_backlog_proposal_review",
			"pending_backlog_proposal_review_entry",
			"pending_backlog_proposal_duplicate_resolution",
			"story_duplicate_link",
			"user_story",
			"ai_outcome_event",
		])(
			"attribution refuses a project without an organization for %s",
			async (source) => {
				await client.query(
					`UPDATE project SET "organizationId"=NULL WHERE id=$1`,
					[projectId],
				);
				expect(
					(
						await client.query(
							"SELECT lakehouse_export.resolve_event_org($1,$2,$3) AS org",
							[source, org, projectId],
						)
					).rows,
				).toEqual([{ org: null }]);
			},
		);
		it("evaluates the flag for the resolved project organization only", async () => {
			await client.query(
				`INSERT INTO organization (id,name,"createdAt") VALUES ($1,'Example',now())`,
				[otherOrg],
			);
			await client.query(
				`INSERT INTO organization_feature_flag_override (key,"organizationId",enabled,"updatedBy","updatedAt") VALUES ('DECISION_REPLAY',$1,false,'c000000000000000000000003',now())`,
				[otherOrg],
			);
			await client.query(
				`UPDATE project SET "organizationId"=$1 WHERE id=$2`,
				[otherOrg, projectId],
			);
			await proposal(null);
			expect(await events()).toEqual([]);
		});
		const enumValues = (name: string) => {
			const schema = readFileSync(
				resolve(__dirname, "../prisma/schema.prisma"),
				"utf8",
			);
			return [
				...(
					schema.match(new RegExp(`enum ${name} {([^}]+)}`))?.[1] ??
					""
				).matchAll(/^\s*([A-Z][A-Z_]*)\s*(?:\/\/.*)?$/gm),
			].map((m) => m[1]);
		};
		const duplicateStates = [
			"PENDING",
			"DISMISSED",
			"RESOLVED",
			"NOT_DUPLICATE",
		];
		const proposalStates = [
			"PENDING",
			"APPROVED",
			"APPLYING",
			"APPLIED",
			"REJECTED",
			"FAILED",
			"SUPERSEDED",
			"BACKLOG",
		];
		it("covers every status in both source enums", () => {
			expect(enumValues("DuplicateLinkStatus")).toEqual(duplicateStates);
			expect(enumValues("PendingBacklogProposalStatus")).toEqual(
				proposalStates,
			);
		});
		// Rows/columns: PENDING, DISMISSED, RESOLVED, NOT_DUPLICATE.
		const duplicateUpdates = [
			[
				null,
				"duplicate_dismissed",
				"duplicate_resolved",
				"duplicate_status_changed",
			],
			[
				"duplicate_status_changed",
				null,
				"duplicate_status_changed",
				"duplicate_status_changed",
			],
			[
				"duplicate_status_changed",
				"duplicate_status_changed",
				null,
				"duplicate_status_changed",
			],
			[
				"duplicate_detected",
				"duplicate_status_changed",
				"duplicate_status_changed",
				null,
			],
		];
		const duplicateCases = [
			...duplicateStates.map((to) => ({
				op: "INSERT",
				from: null as string | null,
				to,
				event: to === "PENDING" ? "duplicate_detected" : null,
			})),
			...duplicateStates.flatMap((from, i) =>
				duplicateStates.map((to, j) => ({
					op: "UPDATE",
					from,
					to,
					event: duplicateUpdates[i][j],
				})),
			),
			...duplicateStates.map((from) => ({
				op: "DELETE",
				from,
				to: null as string | null,
				event: null,
			})),
		];
		it.each(duplicateCases)(
			"duplicate transition $op $from -> $to = $event",
			async ({ op, from, to, event }) => {
				await story();
				await story("c000000000000000000000007");
				// Baseline is inserted before the observation window, with a retained resolver
				// to prove system/AI transitions do not inherit human provenance.
				if (op !== "INSERT") {
					await client.query(
						`INSERT INTO story_duplicate_link (id,"projectId","storyAId","storyBId",similarity,confidence,status,"resolvedById","updatedAt") VALUES ('c000000000000000000000012',$1,'c000000000000000000000006','c000000000000000000000007',0.123456,0.987654,$2,'c000000000000000000000003',now())`,
						[projectId, from],
					);
				}
				const count = (await events()).length;
				if (op === "INSERT") {
					await client.query(
						`INSERT INTO story_duplicate_link (id,"projectId","storyAId","storyBId",similarity,confidence,status,"resolvedById","updatedAt") VALUES ('c000000000000000000000012',$1,'c000000000000000000000006','c000000000000000000000007',0.123456,0.987654,$2,'c000000000000000000000003',now())`,
						[projectId, to],
					);
				} else if (op === "UPDATE") {
					await client.query(
						`UPDATE story_duplicate_link SET status=$1 WHERE id='c000000000000000000000012'`,
						[to],
					);
				} else {
					await client.query(
						`DELETE FROM story_duplicate_link WHERE id='c000000000000000000000012'`,
					);
				}
				const rows = (await events()).slice(count);
				const actor =
					event === "duplicate_detected"
						? "ai"
						: [
									"duplicate_dismissed",
									"duplicate_resolved",
								].includes(event ?? "")
							? "human"
							: "system";
				expect(
					rows.map((r) => [
						r.event_type,
						r.actor_kind,
						r.actor_id,
						r.from_state,
						r.to_state,
					]),
				).toEqual(
					event
						? [
								[
									event,
									actor,
									actor === "human"
										? "c000000000000000000000003"
										: null,
									from,
									to,
								],
							]
						: [],
				);
				if (event === "duplicate_detected") {
					expect(rows[0].payload).toEqual({
						similarity: 0.1235,
						confidence: 0.9877,
						linkType: "DUPLICATE",
					});
				}
			},
		);
		const proposalCases = [
			...proposalStates.map((to) => ({
				op: "INSERT",
				from: null as string | null,
				to,
			})),
			...proposalStates.flatMap((from) =>
				proposalStates.map((to) => ({ op: "UPDATE", from, to })),
			),
			...proposalStates.map((from) => ({
				op: "DELETE",
				from,
				to: null as string | null,
			})),
		];
		it.each(
			proposalCases.flatMap((c) =>
				[
					"absent",
					"retained",
					"changed",
					"changed-without-reviewer",
				].map((review) => ({ ...c, review })),
			),
		)(
			"proposal transition $op $from -> $to review=$review",
			async ({ op, from, to, review }) => {
				const reviewedAt =
					review === "absent" ? null : "2026-01-01T00:00:00Z";
				if (op !== "INSERT") {
					await client.query(
						`INSERT INTO pending_backlog_proposal (id,"projectId",source,proposal,summary,"organizationId",status,"reviewedAt","reviewedBy") VALUES ('c000000000000000000000005',$1,'AI_UPDATE_SIDEBAR','{}','Example',$2,$3,$4,'c000000000000000000000003')`,
						[projectId, org, from, reviewedAt],
					);
				}
				const count = (await events()).length;
				const nextReview = review.startsWith("changed")
					? "2026-01-02T00:00:00Z"
					: reviewedAt;
				const reviewer =
					review === "changed-without-reviewer"
						? null
						: "c000000000000000000000003";
				if (op === "INSERT") {
					await client.query(
						`INSERT INTO pending_backlog_proposal (id,"projectId",source,proposal,summary,"organizationId",status,"reviewedAt","reviewedBy") VALUES ('c000000000000000000000005',$1,'AI_UPDATE_SIDEBAR','{}','Example',$2,$3,$4,$5)`,
						[projectId, org, to, nextReview, reviewer],
					);
				} else if (op === "UPDATE") {
					await client.query(
						`UPDATE pending_backlog_proposal SET status=$1,"reviewedAt"=$2,"reviewedBy"=$3 WHERE id='c000000000000000000000005'`,
						[to, nextReview, reviewer],
					);
				} else {
					await client.query(
						`DELETE FROM pending_backlog_proposal WHERE id='c000000000000000000000005'`,
					);
				}
				const event =
					op === "INSERT"
						? "proposed"
						: op === "UPDATE" && from !== to
							? "status_changed"
							: null;
				const actor =
					op === "UPDATE" && review === "changed"
						? "human"
						: "system";
				expect(
					(await events())
						.slice(count)
						.map((r) => [
							r.event_type,
							r.actor_kind,
							r.actor_id,
							r.from_state,
							r.to_state,
						]),
				).toEqual(
					event
						? [
								[
									event,
									actor,
									actor === "human" ? reviewer : null,
									from,
									to,
								],
							]
						: [],
				);
			},
		);
		it.each([null, "example-model", "example-unregistered-model"])(
			"preserves model null versus catalog unknown: %s",
			async (model) => {
				await rating();
				await client.query(
					`UPDATE ai_outcome_event SET "modelCanonicalName"=$1,outcome='RATED_DOWN' WHERE id='c000000000000000000000009'`,
					[model],
				);
				expect((await events())[1].model).toBe(
					model === "example-unregistered-model" ? "unknown" : model,
				);
			},
		);
	},
);
