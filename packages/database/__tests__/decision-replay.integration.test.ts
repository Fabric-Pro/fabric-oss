import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { db, Prisma } from "../prisma/client";
import { PrismaClient } from "../prisma/generated/client";
import {
	getDecisionReplayProposalTimeline,
	getDecisionReplaySummary,
	listDecisionReplayNeedsReview,
} from "../prisma/queries/decision-replay";
import { disposableTarget } from "../scripts/prisma-disposable.mjs";

const changeFixture = JSON.parse(
	readFileSync(
		new URL(
			"../../../scripts/__tests__/fixtures/decision-replay-changes.json",
			import.meta.url,
		),
		"utf8",
	),
) as {
	now: string;
	cases: Array<{
		name: string;
		proposalId: string;
		partlyApplied: number;
		coveredChangeCount: number;
		periods?: {
			current: Partial<
				import("../prisma/queries/decision-replay").DecisionReplayPeriod
			>;
			previous: Partial<
				import("../prisma/queries/decision-replay").DecisionReplayPeriod
			>;
		};
		changeOutcomes: Record<string, number>;
		changeAcceptance: {
			accepted: number;
			decided: number;
			rate: number | null;
		};
		events: Array<{
			id: string;
			occurred_at: string;
			subject_type: string;
			subject_id: string;
			event_type: string;
			to_state: string | null;
			related_subject_id: string | null;
			payload: object;
			actor_kind: string;
		}>;
	}>;
};
let admin: PrismaClient;
let readerProvisioned = false;
let exportReowned = false;
const originalUrl = process.env.DATABASE_URL;
const org = randomUUID();
const otherOrg = randomUUID();
const project = randomUUID();
const otherProject = randomUUID();
const user = randomUUID();
const outsider = randomUUID();
const scope = { organizationId: org, projectId: project };
const now = Date.now();
const ago = (days: number, seconds = 0) =>
	new Date(now - days * 86400_000 + seconds * 1000);
const proposal = async (
	status = "PENDING",
	days = 1,
	organizationId: string | null = org,
	projectId = project,
) => {
	const id = randomUUID();
	await admin.$executeRaw(
		Prisma.sql`INSERT INTO pending_backlog_proposal (id,"projectId","organizationId",source,proposal,summary,"changeCount",status,"createdAt") VALUES (${id},${projectId},${organizationId},'TEAMS_CHANNEL','{}','Example summary',2,${status}::"PendingBacklogProposalStatus",${ago(days)})`,
	);
	return id;
};
async function event(
	id: string,
	type: string,
	days: number,
	opts: {
		state?: string;
		actor?: string;
		actorId?: string;
		related?: string;
		subjectType?: string;
		org?: string;
		project?: string;
		payload?: object;
		seconds?: number;
	} = {},
) {
	const eventId = randomUUID();
	await admin.$executeRaw(
		Prisma.sql`INSERT INTO lakehouse_export.decision_event (id,occurred_at,organization_id,project_id,subject_type,subject_id,event_type,to_state,actor_kind,actor_id,related_subject_id,payload) VALUES (${eventId},${ago(days, opts.seconds)},${opts.org ?? org},${opts.project ?? project},${opts.subjectType ?? "backlog_proposal"},${id},${type},${opts.state ?? null},${opts.actor ?? "system"},${opts.actorId ?? null},${opts.related ?? null},${JSON.stringify(opts.payload ?? { source: "TEAMS_CHANNEL" })}::jsonb)`,
	);
	return eventId;
}
const summary = () => getDecisionReplaySummary({ ...scope, range: "30d" });
describe.skipIf(process.env.RUN_DB_INTEGRATION !== "1")(
	"Decision Replay native outcomes",
	() => {
		beforeAll(async () => {
			const target = disposableTarget("reset", {
				DIRECT_URL: originalUrl,
			});
			admin = new PrismaClient({
				adapter: new PrismaPg({ connectionString: target }),
			});
			const [owner] = await admin.$queryRaw<{ owner: string }[]>(
				Prisma.sql`SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='lakehouse_export.decision_event'::regclass`,
			);
			expect(owner.owner).toBe("postgres");
			await admin.$executeRaw(
				Prisma.sql`CREATE ROLE example_dr_reader LOGIN PASSWORD 'example_password' NOSUPERUSER NOBYPASSRLS`,
			);
			readerProvisioned = true;
			// Public source reads emulate the hosted app's broad read privileges;
			// the export itself is read under its owner exemption, without FORCE RLS.
			await admin.$executeRaw(
				Prisma.sql`CREATE POLICY example_dr_reader_select ON project FOR SELECT TO example_dr_reader USING (true)`,
			);
			await admin.$executeRaw(
				Prisma.sql`CREATE POLICY example_dr_reader_select ON pending_backlog_proposal FOR SELECT TO example_dr_reader USING (true)`,
			);
			await admin.$executeRaw(
				Prisma.sql`CREATE POLICY example_dr_reader_select ON member FOR SELECT TO example_dr_reader USING (true)`,
			);
			await admin.$executeRaw(
				Prisma.sql`CREATE POLICY example_dr_reader_select ON "user" FOR SELECT TO example_dr_reader USING (true)`,
			);
			await admin.$executeRaw(
				Prisma.sql`GRANT SELECT ON project,pending_backlog_proposal,member,"user" TO example_dr_reader`,
			);
			await admin.$executeRaw(
				Prisma.sql`GRANT USAGE ON SCHEMA lakehouse_export TO example_dr_reader`,
			);
			for (const table of [
				"pending_backlog_proposal_review",
				"pending_backlog_proposal_review_entry",
			]) {
				await admin.$executeRawUnsafe(
					`CREATE POLICY example_dr_reader_select ON "${table}" FOR SELECT TO example_dr_reader USING (true)`,
				);
				await admin.$executeRawUnsafe(
					`GRANT SELECT ON "${table}" TO example_dr_reader`,
				);
			}

			await admin.$executeRaw(
				Prisma.sql`ALTER TABLE lakehouse_export.decision_event OWNER TO example_dr_reader`,
			);
			exportReowned = true;
			const readerUrl = new URL(target);
			readerUrl.username = "example_dr_reader";
			readerUrl.password = "example_password";
			process.env.DATABASE_URL = readerUrl.toString();
		});
		beforeEach(async () => {
			for (const id of [org, otherOrg]) {
				await admin.$executeRaw(
					Prisma.sql`INSERT INTO organization(id,name,"createdAt") VALUES (${id},'Example organization',now())`,
				);
			}
			for (const id of [user, outsider]) {
				await admin.$executeRaw(
					Prisma.sql`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES (${id},'Example actor',${`${id}@example.com`},false,now(),now())`,
				);
			}
			for (const [id, organizationId] of [
				[project, org],
				[otherProject, otherOrg],
			]) {
				await admin.$executeRaw(
					Prisma.sql`INSERT INTO project(id,name,"userId","organizationId","updatedAt") VALUES (${id},'Example project',${user},${organizationId},now())`,
				);
			}
			await admin.$executeRaw(
				Prisma.sql`INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES (${randomUUID()},${org},${user},'member',now())`,
			);
			await admin.$executeRaw(
				Prisma.sql`INSERT INTO organization_feature_flag_override(key,"organizationId",enabled,"updatedBy","updatedAt") VALUES ('DECISION_REPLAY',${org},true,${user},now())`,
			);
		});
		afterEach(async () => {
			await admin.$executeRaw(
				Prisma.sql`DELETE FROM organization WHERE id IN (${org},${otherOrg})`,
			);
			await admin.$executeRaw(
				Prisma.sql`DELETE FROM "user" WHERE id IN (${user},${outsider})`,
			);
		});
		afterAll(async () => {
			await db.$disconnect();
			process.env.DATABASE_URL = originalUrl;
			if (admin) {
				if (exportReowned) {
					await admin.$executeRaw(
						Prisma.sql`ALTER TABLE lakehouse_export.decision_event OWNER TO postgres`,
					);
				}
				if (readerProvisioned) {
					await admin.$executeRaw(
						Prisma.sql`DROP POLICY IF EXISTS example_dr_reader_select ON project`,
					);
					await admin.$executeRaw(
						Prisma.sql`DROP POLICY IF EXISTS example_dr_reader_select ON pending_backlog_proposal`,
					);
					await admin.$executeRaw(
						Prisma.sql`DROP POLICY IF EXISTS example_dr_reader_select ON member`,
					);
					await admin.$executeRaw(
						Prisma.sql`DROP POLICY IF EXISTS example_dr_reader_select ON "user"`,
					);
					await admin.$executeRaw(
						Prisma.sql`DROP OWNED BY example_dr_reader`,
					);
					await admin.$executeRaw(
						Prisma.sql`DROP ROLE example_dr_reader`,
					);
				}
				await admin.$disconnect();
			}
		});
		it.each(changeFixture.cases)(
			"shared change rules: $name",
			async (fixture) => {
				await admin.$executeRaw(
					Prisma.sql`UPDATE organization_feature_flag_override SET enabled=false WHERE key='DECISION_REPLAY' AND "organizationId"=${org}`,
				);
				const last = fixture.events
					.filter(
						(e) =>
							e.subject_id === fixture.proposalId &&
							e.subject_type === "backlog_proposal",
					)
					.sort(
						(a, b) =>
							a.occurred_at.localeCompare(b.occurred_at) ||
							a.id.localeCompare(b.id),
					)
					.at(-1);
				if (!last) {
					throw new Error("Fixture requires a proposal status");
				}
				await admin.$executeRaw(
					Prisma.sql`INSERT INTO pending_backlog_proposal (id,"projectId","organizationId",source,proposal,summary,"changeCount",status,"createdAt") VALUES (${fixture.proposalId},${project},${org},${(last.payload as { source: string }).source}::"PendingBacklogProposalSource",'{}','Example proposal',${(last.payload as { changeCount: number }).changeCount},${last.to_state}::"PendingBacklogProposalStatus",${new Date(fixture.events[0].occurred_at)})`,
				);
				for (const e of fixture.events) {
					await admin.$executeRaw(
						Prisma.sql`INSERT INTO lakehouse_export.decision_event (id,occurred_at,organization_id,project_id,subject_type,subject_id,event_type,to_state,actor_kind,related_subject_id,payload) VALUES (${e.id},${new Date(e.occurred_at)},${org},${project},${e.subject_type},${e.subject_id},${e.event_type},${e.to_state},${e.actor_kind},${e.related_subject_id},${JSON.stringify(e.payload)}::jsonb)`,
					);
				}
				vi.useFakeTimers({ toFake: ["Date"] });
				vi.setSystemTime(new Date(changeFixture.now));
				try {
					const result = await getDecisionReplaySummary({
						...scope,
						range: "all",
					});
					// Each fixture has one nonempty proposal; coverage anchors offer zero changes.
					expect(
						Object.values(result.current.changeOutcomes).reduce(
							(n, v) => n + v,
							0,
						),
						"one outcome per covered offered change",
					).toBe(fixture.coveredChangeCount);
					if (fixture.periods) {
						const rolling = await getDecisionReplaySummary({
							...scope,
							range: "30d",
						});
						expect(rolling.current).toMatchObject(
							fixture.periods.current,
						);
						expect(rolling.previous).toMatchObject(
							fixture.periods.previous,
						);
					}
					expect(result.current.changeOutcomes).toEqual(
						fixture.changeOutcomes,
					);
					expect(result.current.changeAcceptance).toEqual(
						fixture.changeAcceptance,
					);
					expect(result.current.partlyApplied).toBe(
						fixture.partlyApplied,
					);
				} finally {
					vi.useRealTimers();
				}
			},
		);
		it("evaluates previous change outcomes before retries and excludes foreign or future resolutions", async () => {
			const id = randomUUID();
			await event(id, "proposed", 50, {
				state: "PENDING",
				payload: { source: "TEAMS_CHANNEL", changeCount: 2 },
			});
			for (const [days, selectedCount] of [
				[40, 1],
				[5, 2],
			]) {
				const review = randomUUID();
				await event(review, "proposal_reviewed", days, {
					related: id,
					subjectType: "backlog_proposal_review",
					payload: {
						source: "TEAMS_CHANNEL",
						offeredCount: 2,
						selectedCount,
						offeredListComplete: true,
					},
				});
				for (let i = 0; i < 2; i++) {
					await event(randomUUID(), "change_reviewed", days, {
						related: id,
						subjectType: "backlog_proposal_review_entry",
						payload: {
							reviewId: review,
							offeredIndex: i,
							changeIndex: i,
							selected: i < selectedCount,
						},
					});
				}
			}
			await event(id, "status_changed", 39, {
				state: "FAILED",
				payload: { source: "TEAMS_CHANNEL", changeCount: 2 },
			});
			await event(id, "status_changed", 3, {
				state: "APPLYING",
				payload: { source: "TEAMS_CHANNEL", changeCount: 2 },
			});
			await event(randomUUID(), "change_applied", 4, {
				subjectType: "backlog_proposal_application",
				related: id,
				payload: { changeIndex: 0 },
			});
			await event(randomUUID(), "change_applied", 2, {
				subjectType: "backlog_proposal_application",
				related: id,
				org: otherOrg,
				payload: { changeIndex: 1 },
			});
			await event(randomUUID(), "change_deduplicated", 2, {
				subjectType: "backlog_proposal_duplicate_resolution",
				related: id,
				project: otherProject,
				payload: { changeIndex: 1 },
			});
			await event(randomUUID(), "change_applied", -1, {
				subjectType: "backlog_proposal_application",
				related: id,
				payload: { changeIndex: 1 },
			});
			const s = await summary();
			expect(s.current.changeOutcomes).toEqual({
				applied: 1,
				alreadyOnRoadmap: 0,
				notSelected: 0,
				failed: 0,
				inProgress: 1,
				rejected: 0,
				superseded: 0,
				pending: 0,
			});
			expect(s.previous?.changeOutcomes).toEqual({
				applied: 0,
				alreadyOnRoadmap: 0,
				notSelected: 1,
				failed: 1,
				inProgress: 0,
				rejected: 0,
				superseded: 0,
				pending: 0,
			});
			expect(s.current.changeAcceptance).toEqual({
				accepted: 2,
				decided: 2,
				rate: 1,
			});
			expect(s.previous?.changeAcceptance).toEqual({
				accepted: 1,
				decided: 2,
				rate: 0.5,
			});
		});
		it("executes owner-bypass reads with a restricted non-superuser role", async () => {
			const [role] = await db.$queryRaw<
				{ rolsuper: boolean; rolbypassrls: boolean; owner: boolean }[]
			>(
				Prisma.sql`SELECT r.rolsuper,r.rolbypassrls,c.relowner=r.oid AS owner FROM pg_roles r CROSS JOIN pg_class c WHERE r.rolname=current_user AND c.oid='lakehouse_export.decision_event'::regclass`,
			);
			expect(role).toEqual({
				rolsuper: false,
				rolbypassrls: false,
				owner: true,
			});
			await event(randomUUID(), "status_changed", 1, {
				org: otherOrg,
				state: "REJECTED",
			});
			const [raw] = await db.$queryRaw<{ count: number }[]>(
				Prisma.sql`SELECT count(*)::int AS count FROM lakehouse_export.decision_event WHERE project_id=${project}`,
			);
			expect(raw.count).toBe(1);
			expect((await summary()).current.acceptance.decided).toBe(0);
		});
		it.each(["7d", "90d"] as const)(
			"uses equal rolling periods for %s",
			async (range) => {
				const days = range === "7d" ? 7 : 90;
				await event(randomUUID(), "status_changed", days - 1, {
					state: "REJECTED",
				});
				await event(randomUUID(), "status_changed", days + 1, {
					state: "APPROVED",
					actor: "human",
				});
				await event(randomUUID(), "status_changed", days * 2 + 1, {
					state: "REJECTED",
				});
				const s = await getDecisionReplaySummary({ ...scope, range });
				expect(s.current.acceptance).toEqual({
					accepted: 0,
					decided: 1,
					rate: 0,
				});
				expect(s.previous?.acceptance).toEqual({
					accepted: 1,
					decided: 1,
					rate: 1,
				});
			},
		);
		it("keeps UTC period, now and maturity bounds in a New York session", async () => {
			await db.$disconnect();
			await admin.$executeRaw(
				Prisma.sql`ALTER ROLE example_dr_reader SET timezone = 'America/New_York'`,
			);
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(now);
			try {
				const [session] = await db.$queryRaw<{ zone: string }[]>(
					Prisma.sql`SELECT current_setting('TimeZone') AS zone`,
				);
				expect(session.zone).toBe("America/New_York");
				await event(randomUUID(), "status_changed", 30, {
					seconds: 1,
					state: "REJECTED",
				});
				await event(randomUUID(), "status_changed", 60, {
					seconds: 1,
					state: "REJECTED",
				});
				await event(randomUUID(), "status_changed", 0, {
					seconds: 1,
					state: "REJECTED",
				});
				await event(randomUUID(), "status_changed", 7, {
					seconds: -1,
					state: "APPLIED",
				});
				await event(randomUUID(), "status_changed", 7, {
					seconds: 1,
					state: "APPLIED",
				});
				const result = await summary();
				expect(result.current.acceptance.decided).toBe(1);
				expect(result.previous?.acceptance.decided).toBe(1);
				expect(result.current.keptAsApplied.mature).toBe(1);
				// The all-time period still excludes future decisions.
				expect(
					(await getDecisionReplaySummary({ ...scope, range: "all" }))
						.current.acceptance.decided,
				).toBe(2);
			} finally {
				vi.useRealTimers();
				await db.$disconnect();
				await admin.$executeRaw(
					Prisma.sql`ALTER ROLE example_dr_reader RESET timezone`,
				);
			}
		});
		it("returns the latest 200 timeline events oldest first and signals truncation", async () => {
			const id = randomUUID();
			const ids: string[] = [];
			for (let index = 0; index < 200; index++) {
				ids.push(
					await event(id, "status_changed", 1, {
						state: `EXAMPLE_${index}`,
					}),
				);
			}
			expect(
				(
					await getDecisionReplayProposalTimeline({
						...scope,
						proposalId: id,
					})
				).truncated,
			).toBe(false);
			ids.push(
				await event(id, "status_changed", 1, {
					state: "EXAMPLE_200",
					seconds: 1,
				}),
			);

			const expected = ids
				.map((id, index) => ({ id, index }))
				.sort(
					(a, b) =>
						Number(a.index === 200) - Number(b.index === 200) ||
						(a.id < b.id ? -1 : 1),
				);
			const result = await getDecisionReplayProposalTimeline({
				...scope,
				proposalId: id,
			});
			expect(result).toMatchObject({ truncated: true });
			expect(result.events).toHaveLength(200);
			expect(result.events.map((event) => event.toState)).toEqual(
				expected.slice(1).map((event) => `EXAMPLE_${event.index}`),
			);
		});

		it("keeps foreign source/review/edit events out of review and retention metrics", async () => {
			const id = randomUUID();
			await event(id, "proposed", 20);
			await event(id, "status_changed", 19, {
				state: "APPROVED",
				actor: "human",
			});
			await event(id, "status_changed", 15, { state: "APPLIED" });
			await event(id, "proposed", 25, {
				org: otherOrg,
				payload: { source: "AI_UPDATE_SIDEBAR" },
			});
			await event(id, "status_changed", 22, {
				org: otherOrg,
				actor: "human",
			});
			await event(randomUUID(), "story_edited", 14, {
				org: otherOrg,
				subjectType: "story",
				related: id,
			});
			await event(randomUUID(), "story_edited", 14, {
				project: otherProject,
				subjectType: "story",
				related: id,
			});
			const s = await summary();
			expect(s.current.medianReviewSeconds).toBe(86400);
			expect(s.current.keptAsApplied).toEqual({
				kept: 1,
				mature: 1,
				rate: 1,
			});
		});
		it("treats SQL-shaped ids as data and orders tied timeline events by id", async () => {
			const id = randomUUID();
			const first = await event(id, "status_changed", 1, {
				state: "APPROVED",
				actor: "human",
			});
			const second = await event(id, "status_changed", 1, {
				state: "REJECTED",
			});
			expect(
				(
					await getDecisionReplayProposalTimeline({
						...scope,
						proposalId: id,
					})
				).events.map((e) => e.toState),
			).toEqual(
				first < second
					? ["APPROVED", "REJECTED"]
					: ["REJECTED", "APPROVED"],
			);
			expect(
				await getDecisionReplayProposalTimeline({
					...scope,
					proposalId: "example_' OR 1=1 --",
				}),
			).toEqual({ events: [], truncated: false });
			expect(
				(
					await getDecisionReplaySummary({
						organizationId: org,
						projectId: "example_' OR 1=1 --",
						range: "all",
					})
				).current.acceptance.decided,
			).toBe(0);
		});

		it("returns null rates and medians for empty periods and no previous for all", async () => {
			const s = await summary();
			expect(s.waiting).toBe(0);
			expect(s.oldestWaitingAt).toBeNull();
			expect(s.changeCoverageStartedAt).toBeNull();
			for (const period of [s.current, s.previous]) {
				expect(period).toMatchObject({
					acceptance: { accepted: 0, decided: 0, rate: null },
					changeAcceptance: { accepted: 0, decided: 0, rate: null },
					changeOutcomes: {
						applied: 0,
						alreadyOnRoadmap: 0,
						notSelected: 0,
						failed: 0,
						inProgress: 0,
						rejected: 0,
						superseded: 0,
						pending: 0,
					},
					partlyApplied: 0,
					medianReviewSeconds: null,
					keptAsApplied: { kept: 0, mature: 0, rate: null },
					outcomes: { applied: 0, rejected: 0, pending: 0, other: 0 },
				});
			}
			expect(
				(await getDecisionReplaySummary({ ...scope, range: "all" }))
					.previous,
			).toBeNull();
		});
		it("lists only scoped live PENDING proposals oldest first with total independent of limit", async () => {
			const oldest = await proposal("PENDING", 80, null);
			await proposal("PENDING", 2);
			await proposal("PENDING", 1);
			await proposal("BACKLOG", 90);
			await proposal("PENDING", 100, otherOrg);
			await proposal("PENDING", 100, otherOrg, otherProject);
			const s = await summary();
			expect(s.waiting).toBe(3);
			expect(s.oldestWaitingAt).toEqual(ago(80));
			const list = await listDecisionReplayNeedsReview({
				...scope,
				limit: 1,
			});
			expect(list.total).toBe(3);
			expect(list.items).toEqual([
				{
					id: oldest,
					summary: "Example summary",
					source: "TEAMS_CHANNEL",
					changeCount: 2,
					createdAt: ago(80),
				},
			]);
			expect(
				(await listDecisionReplayNeedsReview(scope)).items,
			).toHaveLength(3);
		});
		it("counts latest qualifying decisions once per proposal separately in equal periods", async () => {
			const a = randomUUID();
			const b = randomUUID();
			const c = randomUUID();
			await event(a, "status_changed", 45, {
				state: "APPROVED",
				actor: "human",
			});
			await event(a, "status_changed", 5, {
				state: "APPROVED",
				actor: "human",
			});
			await event(a, "status_changed", 4, { state: "BACKLOG" });
			await event(b, "status_changed", 3, { state: "REJECTED" });
			await event(b, "status_changed", 2, {
				state: "APPLYING",
				actor: "human",
			});
			await event(b, "status_changed", 1, { state: "APPLIED" });
			await event(c, "status_changed", 1, { state: "APPLIED" });
			const s = await summary();
			expect(s.current.acceptance).toEqual({
				accepted: 1,
				decided: 2,
				rate: 0.5,
			});
			expect(s.previous?.acceptance).toEqual({
				accepted: 1,
				decided: 1,
				rate: 1,
			});
		});
		it("uses event id to break tied latest decisions", async () => {
			const id = randomUUID();
			const first = await event(id, "status_changed", 3, {
				state: "APPROVED",
				actor: "human",
			});
			const second = await event(id, "status_changed", 3, {
				state: "REJECTED",
			});
			expect((await summary()).current.acceptance.accepted).toBe(
				first > second ? 1 : 0,
			);
		});
		it("takes the exact median of first human reviews in their review period, excluding sidebar and missing proposals", async () => {
			for (const seconds of [10, 30, 100, 200]) {
				const id = randomUUID();
				await event(id, "proposed", 31);
				await event(id, "status_changed", 31, {
					actor: "human",
					state: "APPROVED",
					seconds: 86400 * 2 + seconds,
				});
				await event(id, "status_changed", 1, {
					actor: "human",
					state: "REJECTED",
				});
			}
			const sidebar = randomUUID();
			await event(sidebar, "proposed", 1, {
				payload: { source: "AI_UPDATE_SIDEBAR" },
			});
			await event(sidebar, "status_changed", 1, {
				actor: "human",
				state: "APPLIED",
				seconds: 1,
				payload: { source: "AI_UPDATE_SIDEBAR" },
			});
			await event(randomUUID(), "status_changed", 1, {
				actor: "human",
				state: "REJECTED",
			});
			const previous = randomUUID();
			await event(previous, "proposed", 50);
			await event(previous, "status_changed", 50, {
				actor: "human",
				seconds: 20,
			});
			await event(previous, "status_changed", 1, { actor: "human" });
			const s = await summary();
			expect(s.current.medianReviewSeconds).toBe(172865);
			expect(s.previous?.medianReviewSeconds).toBe(20);
		});
		it("counts only mature first-APPLIED cohorts and includes edits at the seventh-day boundary", async () => {
			for (const [days, editOffset] of [
				[15, null],
				[15, 7],
				[15, 7.001],
				[6, null],
				[45, null],
			] as const) {
				const id = randomUUID();
				await event(id, "status_changed", days, { state: "APPLIED" });
				await event(id, "status_changed", 1, { state: "APPLIED" });
				if (editOffset !== null) {
					await event(
						randomUUID(),
						"story_edited",
						days - editOffset,
						{ subjectType: "story", related: id },
					);
				}
			}
			const s = await summary();
			expect(s.current.keptAsApplied).toEqual({
				kept: 2,
				mature: 3,
				rate: 2 / 3,
			});
			expect(s.previous?.keptAsApplied).toEqual({
				kept: 1,
				mature: 1,
				rate: 1,
			});
		});
		it("groups live statuses by proposal creation cohort", async () => {
			for (const status of [
				"APPLIED",
				"REJECTED",
				"BACKLOG",
				"PENDING",
				"FAILED",
				"SUPERSEDED",
				"APPLYING",
				"APPROVED",
			]) {
				await proposal(status);
			}
			await proposal("APPLIED", 45);
			await proposal("APPLIED", 70);
			const s = await summary();
			expect(s.current.outcomes).toEqual({
				applied: 1,
				rejected: 2,
				pending: 1,
				other: 4,
			});
			expect(s.previous?.outcomes).toEqual({
				applied: 1,
				rejected: 0,
				pending: 0,
				other: 0,
			});
		});
		it("filters foreign organizations even with the same project id, foreign projects, and spoofed scope", async () => {
			const id = randomUUID();
			await event(id, "status_changed", 1, {
				state: "REJECTED",
				org: otherOrg,
			});
			await event(id, "status_changed", 1, {
				state: "APPROVED",
				actor: "human",
				project: otherProject,
			});
			await event(id, "proposed", 2, { org: otherOrg });
			await event(id, "status_changed", 1, {
				actor: "human",
				org: otherOrg,
			});
			await proposal("APPLIED", 1, otherOrg);
			expect((await summary()).current.acceptance.decided).toBe(0);
			expect((await summary()).current.outcomes.applied).toBe(0);
			const spoof = { organizationId: otherOrg, projectId: project };
			expect(
				(await getDecisionReplaySummary({ ...spoof, range: "all" }))
					.current.acceptance.decided,
			).toBe(0);
			expect(await listDecisionReplayNeedsReview(spoof)).toEqual({
				items: [],
				total: 0,
			});
			expect(
				await getDecisionReplayProposalTimeline({
					...spoof,
					proposalId: id,
				}),
			).toEqual({ events: [], truncated: false });
		});

		it.each(
			[
				"TEAMS_CHANNEL",
				"SLACK_CHANNEL",
				"SCOPE_DOCUMENT",
				"AI_UPDATE_SIDEBAR",
			].flatMap((source) => [8, 300].map((count) => ({ source, count }))),
		)(
			"summarizes $source with $count real writer entries before the event limit",
			async ({ source, count }) => {
				await admin.$executeRaw(
					Prisma.sql`UPDATE organization_feature_flag_override SET enabled=false WHERE key='DECISION_REPLAY' AND "organizationId"=${org}`,
				);
				const id = await proposal();
				const sidebar = source === "AI_UPDATE_SIDEBAR";
				await admin.pendingBacklogProposal.update({
					where: { id },
					data: {
						source: source as
							| "TEAMS_CHANNEL"
							| "SLACK_CHANNEL"
							| "SCOPE_DOCUMENT"
							| "AI_UPDATE_SIDEBAR",
						proposal: {
							changes: Array.from({ length: count }, (_, i) => ({
								action: "create",
								type: "feature",
								title: {
									to: sidebar
										? `Stored sidebar change ${i}`
										: `Example change ${i}`,
								},
							})),
						},
					},
				});
				const reviewId = randomUUID();
				await admin.pendingBacklogProposalReview.create({
					data: {
						id: reviewId,
						proposalId: id,
						reviewedBy: user,
						offeredCount: count,
						selectedCount: 5,
						offeredListComplete: true,
						syncToPM: false,
					},
				});
				await admin.pendingBacklogProposalReviewEntry.createMany({
					data: Array.from({ length: count }, (_, i) => ({
						id: randomUUID(),
						reviewId,
						proposalId: id,
						offeredIndex: i,
						changeIndex: sidebar && i >= 5 ? null : i,
						selected: i < 5,
						// Mirror buildProposalReviewEntries and buildSidebarReviewEntries.
						...(i < 5
							? {
									change: {
										action: "create",
										type: "feature",
										title: { to: `Example change ${i}` },
									},
								}
							: sidebar
								? {
										change: {
											action: "create",
											type: "feature",
											title: `Example change ${i}`,
										},
									}
								: {}),
					})),
				});
				await event(id, "proposed", 5);
				await event(reviewId, "proposal_reviewed", 4, {
					related: id,
					subjectType: "backlog_proposal_review",
					actor: "human",
					actorId: user,
					payload: {
						source,
						offeredCount: count,
						selectedCount: 5,
						offeredListComplete: true,
					},
				});
				const foreignProposal = await proposal(
					"PENDING",
					1,
					otherOrg,
					otherProject,
				);
				await admin.pendingBacklogProposalReviewEntry.create({
					data: {
						id: randomUUID(),
						reviewId,
						proposalId: foreignProposal,
						offeredIndex: count,
						selected: false,
						change: { title: { to: "Example foreign title" } },
					},
				});
				// A large raw export review must not consume the native timeline budget.
				for (let i = 0; i < count; i++) {
					await event(randomUUID(), "change_reviewed", 4, {
						related: id,
						subjectType: "backlog_proposal_review_entry",
						payload: {
							reviewId,
							offeredIndex: i,
							changeIndex: i,
							selected: i < 5,
						},
					});
				}
				await event(randomUUID(), "change_deduplicated", 3, {
					related: id,
					subjectType: "backlog_proposal_duplicate_resolution",
					payload: { changeIndex: 7, existingEntityType: "story" },
				});
				const result = await getDecisionReplayProposalTimeline({
					...scope,
					proposalId: id,
				});
				expect(result.truncated).toBe(false);
				expect(result.events.map((e) => e.eventType)).toEqual([
					"proposed",
					"proposal_reviewed",
					"change_deduplicated",
				]);
				expect(result.events[1]).toMatchObject({
					offeredCount: count,
					selectedCount: 5,
					offeredListComplete: true,
					notSelectedTitles: Array.from(
						{ length: Math.min(count - 5, 20) },
						(_, i) => `Example change ${i + 5}`,
					),
				});
				expect(result.events[2]?.changeIndex).toBe(7);
				expect(
					(
						await getDecisionReplayProposalTimeline({
							organizationId: otherOrg,
							projectId: project,
							proposalId: id,
						})
					).events,
				).toEqual([]);
			},
		);
		it("omits missing and non-string fallback titles", async () => {
			await admin.$executeRaw(
				Prisma.sql`UPDATE organization_feature_flag_override SET enabled=false WHERE key='DECISION_REPLAY' AND "organizationId"=${org}`,
			);
			const id = await proposal();
			const reviewId = randomUUID();
			await admin.pendingBacklogProposal.update({
				where: { id },
				data: {
					proposal: {
						changes: [
							{ title: { to: "Example fallback" } },
							{ title: { to: 123 } },
							{ title: {} },
							{},
						],
					},
				},
			});
			await admin.pendingBacklogProposalReview.create({
				data: {
					id: reviewId,
					proposalId: id,
					reviewedBy: user,
					offeredCount: 4,
					selectedCount: 0,
					offeredListComplete: true,
					syncToPM: false,
				},
			});
			await admin.pendingBacklogProposalReviewEntry.createMany({
				data: Array.from({ length: 4 }, (_, i) => ({
					id: randomUUID(),
					reviewId,
					proposalId: id,
					offeredIndex: i,
					changeIndex: i,
					selected: false,
				})),
			});
			await event(reviewId, "proposal_reviewed", 1, {
				related: id,
				subjectType: "backlog_proposal_review",
				actor: "human",
				payload: {
					source: "TEAMS_CHANNEL",
					offeredCount: 4,
					selectedCount: 0,
					offeredListComplete: true,
				},
			});
			const result = await getDecisionReplayProposalTimeline({
				...scope,
				proposalId: id,
			});
			expect(result.events).toHaveLength(1);
			expect(result.events[0]?.notSelectedTitles).toEqual([
				"Example fallback",
			]);
		});

		it("returns only safe ordered timeline fields and current member names", async () => {
			const id = randomUUID();
			await event(id, "proposed", 5);
			await event(id, "status_changed", 4, {
				state: "APPROVED",
				actor: "human",
				actorId: user,
			});
			await event(randomUUID(), "change_applied", 3, {
				subjectType: "backlog_proposal_application",
				related: id,
				payload: {
					changeIndex: 2,
					action: "create",
					createdEntityType: "story",
				},
				actorId: outsider,
			});
			await event(randomUUID(), "story_edited", 2, {
				subjectType: "story",
				related: id,
				actorId: outsider,
			});
			await event(id, "status_changed", 1, { org: otherOrg });
			await event(randomUUID(), "proposed", 1);
			const { events: rows, truncated } =
				await getDecisionReplayProposalTimeline({
					...scope,
					proposalId: id,
				});
			expect(truncated).toBe(false);
			expect(rows).toHaveLength(4);
			expect(rows.map((r) => r.eventType)).toEqual([
				"proposed",
				"status_changed",
				"change_applied",
				"story_edited",
			]);
			expect(rows[1].actorName).toBe("Example actor");
			expect(rows[2]).toMatchObject({
				actorName: null,
				changeIndex: 2,
				action: "create",
				createdEntityType: "story",
			});
			expect(Object.keys(rows[0]).sort()).toEqual(
				[
					"occurredAt",
					"eventType",
					"fromState",
					"toState",
					"actorKind",
					"actorName",
					"subjectType",
					"changeIndex",
					"action",
					"createdEntityType",
					"offeredCount",
					"selectedCount",
					"offeredListComplete",
					"notSelectedTitles",
				].sort(),
			);
			await admin.$executeRaw(
				Prisma.sql`DELETE FROM member WHERE "organizationId"=${org} AND "userId"=${user}`,
			);
			expect(
				(
					await getDecisionReplayProposalTimeline({
						...scope,
						proposalId: id,
					})
				).events[1].actorName,
			).toBeNull();
		});
		it("reads capture-generated proposed events for enabled organizations", async () => {
			const id = await proposal();
			const { events: rows, truncated } =
				await getDecisionReplayProposalTimeline({
					...scope,
					proposalId: id,
				});
			expect(truncated).toBe(false);
			expect(rows).toHaveLength(1);
			expect(rows[0].eventType).toBe("proposed");
		});
	},
);
