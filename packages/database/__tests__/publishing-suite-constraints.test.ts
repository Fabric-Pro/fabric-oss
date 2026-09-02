import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { db } from "../index"; // package root barrel (what consumers import as @repo/database)
// INTERNAL by design (absent from the queries barrel), so it is imported by
// path. This is the one place its answer can be proved: the error shape it
// reads is produced by Postgres and the driver adapter, not by Prisma types.
import {
	saveWorkingDraft,
	startTopicDraftAttempt,
} from "../prisma/queries/projects/publishing-drafts";
import { uniqueViolationConstraint } from "../prisma/queries/projects/publishing-tenant-lock";

// REAL-DB integration test proving the Publishing Suite CHECK constraints (Codex F1 tenant-XOR +
// F2 GENERATING-liveness-deadline). Gated on RUN_DB_INTEGRATION like publishing-suite-schema.test.ts,
// so the no-Postgres unit run SKIPS it; it runs only in the db-integration CI job.
const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";
const createdProjectIds: string[] = [];
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

async function makeUser() {
	const user = await db.user.create({
		data: {
			id: `pub-ck-${randomUUID()}`,
			name: "pub-suite-constraints",
			email: `pub-ck-${randomUUID()}@test.local`,
			emailVerified: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	createdUserIds.push(user.id);
	return user;
}

async function makePersonalProject(userId: string) {
	const project = await db.project.create({
		data: { name: "pub-ck", userId, techStack: [], features: [], tags: [] },
	});
	createdProjectIds.push(project.id);
	return project;
}

it.skipIf(!RUN_DB)(
	"F1: rejects a cycle with NEITHER tenant column set (both NULL breaks XOR)",
	async () => {
		const user = await makeUser();
		const project = await makePersonalProject(user.id);
		// Otherwise fully valid; ONLY the tenant tuple is invalid (both NULL).
		await expect(
			db.publishingSuggestionCycle.create({
				data: {
					projectId: project.id,
					// organizationId + userId both omitted -> both NULL
					status: "GENERATING",
					actorUserId: user.id,
					coveredThrough: new Date(),
					executionTimeoutAt: new Date(Date.now() + 3_600_000),
				},
			}),
		).rejects.toThrow(/tenant_xor/);
	},
);

it.skipIf(!RUN_DB)(
	"F1: rejects a cycle with BOTH tenant columns set (the H1 non-XOR tuple)",
	async () => {
		const user = await makeUser();
		const org = await db.organization.create({
			data: { name: `pub-ck-org-${randomUUID()}`, createdAt: new Date() },
		});
		createdOrgIds.push(org.id);
		const project = await db.project.create({
			data: {
				name: "pub-ck-org",
				userId: user.id,
				organizationId: org.id,
				techStack: [],
				features: [],
				tags: [],
			},
		});
		createdProjectIds.push(project.id);
		await expect(
			db.publishingSuggestionCycle.create({
				data: {
					projectId: project.id,
					organizationId: org.id,
					userId: user.id, // BOTH set -> violates XOR
					status: "GENERATING",
					actorUserId: user.id,
					coveredThrough: new Date(),
					executionTimeoutAt: new Date(Date.now() + 3_600_000),
				},
			}),
		).rejects.toThrow(/tenant_xor/);
	},
);

it.skipIf(!RUN_DB)(
	"F1: rejects a topic with BOTH tenant columns set",
	async () => {
		const user = await makeUser();
		const org = await db.organization.create({
			data: { name: `pub-ck-org-${randomUUID()}`, createdAt: new Date() },
		});
		createdOrgIds.push(org.id);
		const project = await db.project.create({
			data: {
				name: "pub-ck-org-t",
				userId: user.id,
				organizationId: org.id,
				techStack: [],
				features: [],
				tags: [],
			},
		});
		createdProjectIds.push(project.id);
		await expect(
			db.publishingTopic.create({
				data: {
					projectId: project.id,
					organizationId: org.id,
					userId: user.id, // BOTH set -> violates XOR
					title: "t",
					status: "SUGGESTION",
					origin: "MANUAL",
					dedupeKey: `ck:${randomUUID()}`,
				},
			}),
		).rejects.toThrow(/tenant_xor/);
	},
);

it.skipIf(!RUN_DB)(
	"F2: rejects a GENERATING cycle with NULL executionTimeoutAt",
	async () => {
		const user = await makeUser();
		const project = await makePersonalProject(user.id);
		await expect(
			db.publishingSuggestionCycle.create({
				data: {
					projectId: project.id,
					userId: user.id, // valid XOR (personal)
					status: "GENERATING",
					actorUserId: user.id,
					coveredThrough: new Date(),
					// executionTimeoutAt omitted -> NULL, but status is GENERATING
				},
			}),
		).rejects.toThrow(/generating_timeout/);
	},
);

it.skipIf(!RUN_DB)(
	"accepts a valid personal GENERATING cycle (XOR ok + timeout set)",
	async () => {
		const user = await makeUser();
		const project = await makePersonalProject(user.id);
		const cycle = await db.publishingSuggestionCycle.create({
			data: {
				projectId: project.id,
				userId: user.id,
				status: "GENERATING",
				actorUserId: user.id,
				coveredThrough: new Date(),
				executionTimeoutAt: new Date(Date.now() + 3_600_000),
			},
		});
		expect(cycle.status).toBe("GENERATING");
	},
);

it.skipIf(!RUN_DB)(
	"F2: accepts a terminal (FAILED) cycle with NULL executionTimeoutAt",
	async () => {
		const user = await makeUser();
		const project = await makePersonalProject(user.id);
		// GENERATING requires a timeout; terminal states do not. Create GENERATING with a
		// timeout, then terminalize and clear the timeout — must be allowed.
		const cycle = await db.publishingSuggestionCycle.create({
			data: {
				projectId: project.id,
				userId: user.id,
				status: "GENERATING",
				actorUserId: user.id,
				coveredThrough: new Date(),
				executionTimeoutAt: new Date(Date.now() + 3_600_000),
			},
		});
		const updated = await db.publishingSuggestionCycle.update({
			where: { id: cycle.id },
			data: { status: "FAILED", executionTimeoutAt: null },
		});
		expect(updated.status).toBe("FAILED");
		expect(updated.executionTimeoutAt).toBeNull();
	},
);

// ---------------------------------------------------------------------------
// The leased-channel fence (Fizzy #1850). SENDING, DEFERRED and EXPIRED are not
// general delivery states — they are the states of ONE channel's lifecycle, and
// three of the four readers that act on them select rows by status ALONE. These
// cases pin the constraint that lets those readers keep doing so.
// ---------------------------------------------------------------------------

async function makeCycleWithRecipient() {
	const user = await makeUser();
	const project = await makePersonalProject(user.id);
	// The same shape the two accepted-cycle cases above use, for the same reason:
	// it is proven to clear every OTHER constraint on this table, so a rejection
	// in these cases is attributable to the one under test.
	const cycle = await db.publishingSuggestionCycle.create({
		data: {
			projectId: project.id,
			userId: user.id,
			status: "GENERATING",
			actorUserId: user.id,
			coveredThrough: new Date(),
			executionTimeoutAt: new Date(Date.now() + 3_600_000),
		},
	});
	return { cycle, project, user };
}

it.skipIf(!RUN_DB)(
	"rejects a leased status on a channel whose lifecycle the sweep does not implement",
	async () => {
		// ONE CASE PER LEASED STATUS. The constraint is one predicate over three values,
		// and a single-value case would pass just as well against a predicate that named
		// only that value.
		//
		// A FRESH RECIPIENT PER ITERATION, and that is not tidiness. The ledger's unique
		// key is (cycleId, recipientUserId, channel): if the constraint were missing, the
		// first insert would SUCCEED and the second would fail on the unique index — so a
		// shared recipient would still report "rejected" for the wrong reason, in exactly
		// the run where the fence is absent.
		for (const status of ["SENDING", "DEFERRED", "EXPIRED"] as const) {
			const seeded = await makeCycleWithRecipient();
			await expect(
				db.publishingNotificationDelivery.create({
					data: {
						cycleId: seeded.cycle.id,
						projectId: seeded.project.id,
						userId: seeded.user.id,
						recipientUserId: seeded.user.id,
						channel: "CHAT",
						status,
						// A DEFERRED row needs one to clear the deferred-shape CHECK. Supplying it
						// on all three is what keeps this case about the CHANNEL — without it the
						// DEFERRED iteration would be refused by the older constraint and report a
						// pass it did not earn.
						expiresAt: new Date(Date.now() + 60_000),
					},
				}),
			).rejects.toThrow(/leased_channel/);
		}
	},
);

it.skipIf(!RUN_DB)(
	"still admits every status the in-app channel actually reaches",
	async () => {
		// The positive control, and it is load-bearing rather than decorative: a predicate
		// with the status list mistyped rejects nothing, and one written without the status
		// term at all rejects the whole in-app channel. Only asserting both directions tells
		// those two apart from a correct constraint.
		const seeded = await makeCycleWithRecipient();
		for (const status of ["SENT", "FAILED", "SKIPPED"] as const) {
			const row = await db.publishingNotificationDelivery.create({
				data: {
					cycleId: seeded.cycle.id,
					projectId: seeded.project.id,
					userId: seeded.user.id,
					recipientUserId: (await makeUser()).id,
					channel: "IN_APP",
					status,
					deliveredAt: status === "SENT" ? new Date() : null,
				},
			});
			expect(row.status).toBe(status);
		}
	},
);

it.skipIf(!RUN_DB)(
	"holds the same way when the leased status is reached by UPDATE rather than INSERT",
	async () => {
		// A CHECK binds every write, not only inserts, and the transition is the REACHABLE
		// shape: a second channel would not insert a leased row, it would claim an existing
		// one.
		const seeded = await makeCycleWithRecipient();
		const row = await db.publishingNotificationDelivery.create({
			data: {
				cycleId: seeded.cycle.id,
				projectId: seeded.project.id,
				userId: seeded.user.id,
				recipientUserId: seeded.user.id,
				channel: "CHAT",
				status: "FAILED",
			},
		});
		await expect(
			db.publishingNotificationDelivery.update({
				where: { id: row.id },
				data: {
					status: "SENDING",
					claimedAt: new Date(),
					claimToken: "leased-channel-probe",
				},
			}),
		).rejects.toThrow(/leased_channel/);
	},
);

it.skipIf(!RUN_DB)(
	"the leased-channel fence is now VALIDATED, not NOT VALID",
	async () => {
		// This case asserted `false` from 20260818120000 until 20260820120000 validated
		// the constraint, and the flip is the point rather than a maintenance edit: it
		// asserted `false` precisely so that whichever slice discharged the obligation had
		// something to PROVE, not merely a JSON line to delete. Reading the catalog is the
		// only way to tell those two apart. Its `true` siblings for the 1C-2c and 1C-2d-1a
		// constraints are in publishing-notifications.test.ts; this one stays here, beside
		// the cases that exercise the predicate it now covers for every existing row.
		//
		// The entry it discharged named 1C-3 as its validator, on 20260818120000's stated
		// expectation that "the phase's next slice puts a third channel in this same
		// ledger". 1C-3 shipped with a table of its own instead, so the trigger could not
		// fire — see the validating migration's header.
		//
		// SAY WHAT THIS CANNOT CERTIFY, because the gap is easy to miss and easy to cite
		// wrongly later. CI builds its database by applying migrations to an empty schema,
		// so here `true` follows from the migration existing and applying — the scan it
		// asserts had nothing to scan. This proves the repository ships a VALIDATE that
		// runs. It does NOT prove that a populated relation was scanned, and it cannot:
		// the only environment where this statement can fail is one holding real rows, and
		// a database resolved by hand with `migrate resolve --applied` would satisfy this
		// assertion while leaving the constraint NOT VALID. The evidence that the predicate
		// can fail at all is a one-off out-of-band reproduction recorded in the changeset —
		// out-of-band by necessity, since the NOT VALID constraint refuses the very write
		// that would create the fixture.
		//
		// conrelid-scoped, matching the sibling in publishing-notifications.test.ts:
		// pg_constraint.conname is unique per relation, not globally.
		const rows = await db.$queryRaw<{ convalidated: boolean }[]>`
			SELECT convalidated FROM pg_constraint
			WHERE conrelid = 'publishing_notification_delivery'::regclass
			  AND conname = 'publishing_notification_delivery_leased_channel'`;
		expect(rows).toHaveLength(1);
		expect(rows[0].convalidated).toBe(true);
	},
);

// ---------------------------------------------------------------------------
// The broadcast ledger (Fizzy #1850, 1C-3). A separate table from
// publishing_notification_delivery because a broadcast has no recipient to key
// on — see the migration's own header for why the two workarounds were refused.
// `makeCycleWithRecipient` is reused as-is: its name is about the case that
// first needed it, and what it actually provides is a personal project plus a
// cycle proven to clear every other constraint.
// ---------------------------------------------------------------------------

const CHAT_TARGET = {
	platform: "SLACK",
	externalTeamId: "T-example",
	channelId: "C-example",
} as const;

it.skipIf(!RUN_DB)(
	"rejects a chat delivery with NEITHER tenant column set",
	async () => {
		const seeded = await makeCycleWithRecipient();
		await expect(
			db.publishingChatDelivery.create({
				data: {
					cycleId: seeded.cycle.id,
					projectId: seeded.project.id,
					// organizationId + userId both omitted -> both NULL
					...CHAT_TARGET,
					status: "SENDING",
				},
			}),
		).rejects.toThrow(/tenant_xor/);
	},
);

it.skipIf(!RUN_DB)(
	"rejects a chat delivery with BOTH tenant columns set",
	async () => {
		const user = await makeUser();
		const org = await db.organization.create({
			data: { name: `pub-ck-org-${randomUUID()}`, createdAt: new Date() },
		});
		createdOrgIds.push(org.id);
		const project = await db.project.create({
			data: {
				name: "pub-ck-org-chat",
				userId: user.id,
				organizationId: org.id,
				techStack: [],
				features: [],
				tags: [],
			},
		});
		createdProjectIds.push(project.id);
		const cycle = await db.publishingSuggestionCycle.create({
			data: {
				projectId: project.id,
				organizationId: org.id,
				status: "GENERATING",
				actorUserId: user.id,
				coveredThrough: new Date(),
				executionTimeoutAt: new Date(Date.now() + 3_600_000),
			},
		});
		await expect(
			db.publishingChatDelivery.create({
				data: {
					cycleId: cycle.id,
					projectId: project.id,
					organizationId: org.id,
					userId: user.id, // BOTH set -> violates XOR
					...CHAT_TARGET,
					status: "SENDING",
				},
			}),
		).rejects.toThrow(/tenant_xor/);
	},
);

it.skipIf(!RUN_DB)(
	"refuses a status outside the four this ledger's lifecycle defines",
	async () => {
		// DEFERRED is the value chosen deliberately: it is a real status on the
		// SIBLING ledger, so a copy-paste from the email path is the realistic way
		// it would arrive here — and this table has no deferral, no lease reclaim
		// and no drain to discharge it (spec §3.4).
		const seeded = await makeCycleWithRecipient();
		await expect(
			db.publishingChatDelivery.create({
				data: {
					cycleId: seeded.cycle.id,
					projectId: seeded.project.id,
					userId: seeded.user.id,
					...CHAT_TARGET,
					status: "DEFERRED",
				},
			}),
		).rejects.toThrow(/status_check/);
	},
);

it.skipIf(!RUN_DB)(
	"admits every one of the four statuses (positive control)",
	async () => {
		// Load-bearing rather than decorative, for the same reason the leased-channel
		// fence above has one: a predicate with the list mistyped rejects nothing, and
		// one written with the wrong four values rejects a status the sender needs.
		// Only asserting both directions tells those apart from a correct constraint.
		const seeded = await makeCycleWithRecipient();
		for (const status of [
			"SENDING",
			"SENT",
			"FAILED",
			"SKIPPED",
		] as const) {
			const row = await db.publishingChatDelivery.create({
				data: {
					cycleId: seeded.cycle.id,
					projectId: seeded.project.id,
					userId: seeded.user.id,
					platform: "SLACK",
					externalTeamId: "T-example",
					// A distinct channel per iteration: the unique key is on the
					// (cycle, platform, team, channel) triple, so reusing one would
					// fail on the index from the second row onward and report a pass
					// this case did not earn.
					channelId: `C-example-${status}`,
					status,
					deliveredAt: status === "SENT" ? new Date() : null,
				},
			});
			expect(row.status).toBe(status);
		}
	},
);

it.skipIf(!RUN_DB)(
	"refuses a second row for the same channel in the same cycle",
	async () => {
		// THE PROPERTY THE WHOLE NO-DOUBLE-POST GUARANTEE RESTS ON. 1C-3b claims by
		// INSERT and treats a conflict as "already handled, do not post"; if this
		// index were absent or keyed differently, that claim would silently succeed
		// twice and put two identical messages in a shared channel, which cannot be
		// withdrawn.
		const seeded = await makeCycleWithRecipient();
		const base = {
			cycleId: seeded.cycle.id,
			projectId: seeded.project.id,
			userId: seeded.user.id,
			...CHAT_TARGET,
		};
		await db.publishingChatDelivery.create({
			data: { ...base, status: "SENT", deliveredAt: new Date() },
		});
		// ASSERTED ON THE ERROR'S SHAPE, NOT ITS TEXT, and the difference is the
		// ORM rather than a preference. The CHECK cases above match on the
		// constraint NAME because Postgres puts it in the message and Prisma passes
		// that through; a UNIQUE violation is intercepted and re-rendered as P2002
		// with a field list, so the index name never appears and a name regex would
		// be red here for a reason that has nothing to do with the database.
		const error = await db.publishingChatDelivery
			.create({ data: { ...base, status: "SENDING" } })
			.then(() => null)
			.catch(
				(e: unknown) =>
					e as { code?: string; message?: string; meta?: unknown },
			);
		expect(error?.code).toBe("P2002");
		// All four columns of the claim key. Checking the code alone would pass
		// against a unique constraint on any subset — including one that omitted
		// channelId, which would refuse a SECOND channel in the same cycle and
		// break the broadcast rather than protect it.
		//
		// BOTH carriers are searched because Prisma 6.18 uses only one of them and
		// does not document which: on this error `meta.target` comes back empty and
		// the column list is in the message. Reading both keeps the case honest if a
		// later version moves it back.
		const target = `${error?.message ?? ""} ${JSON.stringify(error?.meta ?? {})}`;
		for (const column of [
			"cycleId",
			"platform",
			"externalTeamId",
			"channelId",
		]) {
			expect(target).toContain(column);
		}
	},
);

// ---------------------------------------------------------------------------
// Phase 2B-1 (Fizzy #1853): the two draft tables.
//
// These cases exist because NOTHING ELSE CAN SEE the properties they pin. The
// composite foreign key with its subset delete action, the per-post-type
// partial index and the two CHECK constraints are all invisible to the mocked
// query-shape suite in `publishing-drafts.test.ts`, and a migration that exits
// 0 is not evidence any of them landed.
// ---------------------------------------------------------------------------

/** A personal-context topic with its user and project, all tracked for cleanup. */
async function makeDraftTopic() {
	const user = await makeUser();
	const project = await makePersonalProject(user.id);
	const topic = await db.publishingTopic.create({
		data: {
			projectId: project.id,
			userId: user.id,
			title: "draft fixture",
			status: "SUGGESTION",
			origin: "MANUAL",
			dedupeKey: `draft:${randomUUID()}`,
		},
	});
	return { user, project, topic };
}

it.skipIf(!RUN_DB)(
	"2B-1 A: the draft constraints and indexes actually landed",
	async () => {
		// Read back what the migration PRODUCED, not that it exited 0. A
		// hand-authored migration in this repository has passed thirteen reviews
		// and still been wrong about a Postgres-side name; only the catalog
		// settles it.
		const indexes = await db.$queryRaw<Array<{ indexdef: string }>>`
			SELECT indexdef FROM pg_indexes
			WHERE tablename = 'publishing_topic_draft'
			  AND indexname = 'publishing_topic_draft_active'
		`;
		expect(indexes).toHaveLength(1);
		// The PREDICATE, not merely the index's existence: an index over the
		// same columns without the partial WHERE would forbid a second draft of
		// any status, which is a different and much worse rule.
		expect(indexes[0]?.indexdef).toContain('"topicId", "postType"');
		expect(indexes[0]?.indexdef).toContain("WHERE (status = 'GENERATING'");

		const constraints = await db.$queryRaw<
			Array<{ conname: string; def: string }>
		>`
			SELECT conname::text, pg_get_constraintdef(oid) AS def
			FROM pg_constraint
			WHERE conrelid::regclass::text IN (
				'publishing_topic_draft', 'publishing_topic_working_draft'
			)
		`;
		const byName = new Map(constraints.map((c) => [c.conname, c.def]));

		expect(byName.get("publishing_topic_draft_tenant_xor")).toMatch(
			/organizationId.*IS NULL.*<>.*userId.*IS NULL/s,
		);
		expect(byName.get("publishing_topic_working_draft_tenant_xor")).toMatch(
			/organizationId.*IS NULL.*<>.*userId.*IS NULL/s,
		);
		expect(byName.get("publishing_topic_draft_generating_timeout")).toMatch(
			/executionTimeoutAt.*IS NOT NULL/s,
		);

		// The subset delete action is the whole point. A bare ON DELETE SET NULL
		// nulls every referencing column, including NOT NULL topicId/postType,
		// which makes deleting a candidate FAIL instead of preserving the body.
		const fk = byName.get(
			"publishing_topic_working_draft_source_draft_fkey",
		);
		expect(fk).toContain(
			'FOREIGN KEY ("sourceDraftId", "topicId", "postType")',
		);
		expect(fk).toContain('ON DELETE SET NULL ("sourceDraftId")');
	},
);

it.skipIf(!RUN_DB)(
	"2B-1 B: the in-flight guard is per POST TYPE, not per topic",
	async () => {
		const { user, project, topic } = await makeDraftTopic();
		const base = {
			topicId: topic.id,
			projectId: project.id,
			userId: user.id,
			status: "GENERATING" as const,
			executionTimeoutAt: new Date(Date.now() + 600_000),
		};

		// Two content types generating at once on ONE topic is legitimate and
		// users will do it. The positive half is what separates a per-post-type
		// index from the per-topic one the sibling analysis table uses — a
		// rejection-only case passes against either.
		await db.publishingTopicDraft.create({
			data: { ...base, postType: "TWEET", version: 1 },
		});
		await db.publishingTopicDraft.create({
			data: { ...base, postType: "BLOG_POST", version: 1 },
		});

		await expect(
			db.publishingTopicDraft.create({
				data: { ...base, postType: "TWEET", version: 2 },
			}),
		).rejects.toMatchObject({ code: "P2002" });
	},
);

it.skipIf(!RUN_DB)(
	"2B-1 C: a working draft may only cite a candidate of its own topic and post type",
	async () => {
		const { user, project, topic } = await makeDraftTopic();
		const other = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				userId: user.id,
				title: "other topic",
				status: "SUGGESTION",
				origin: "MANUAL",
				dedupeKey: `draft:${randomUUID()}`,
			},
		});
		const candidate = await db.publishingTopicDraft.create({
			data: {
				topicId: topic.id,
				projectId: project.id,
				userId: user.id,
				postType: "BLOG_POST",
				version: 1,
				status: "READY",
			},
		});
		const working = {
			projectId: project.id,
			userId: user.id,
			body: "draft body",
		};

		// Same topic AND same post type: accepted.
		await db.publishingTopicWorkingDraft.create({
			data: {
				...working,
				topicId: topic.id,
				postType: "BLOG_POST",
				sourceDraftId: candidate.id,
			},
		});

		// Another topic's candidate: refused by the composite key.
		await expect(
			db.publishingTopicWorkingDraft.create({
				data: {
					...working,
					topicId: other.id,
					postType: "BLOG_POST",
					sourceDraftId: candidate.id,
				},
			}),
		).rejects.toThrow(/source_draft_fkey|foreign key/i);

		// Right topic, WRONG post type: also refused. Without this half the
		// case passes against a two-column key on (sourceDraftId, topicId).
		await expect(
			db.publishingTopicWorkingDraft.create({
				data: {
					...working,
					topicId: topic.id,
					postType: "TWEET",
					sourceDraftId: candidate.id,
				},
			}),
		).rejects.toThrow(/source_draft_fkey|foreign key/i);

		// MATCH SIMPLE: a hand-written draft citing nothing is legal.
		await db.publishingTopicWorkingDraft.create({
			data: {
				...working,
				topicId: topic.id,
				postType: "TWEET",
				sourceDraftId: null,
			},
		});
	},
);

it.skipIf(!RUN_DB)(
	"2B-1 D: deleting a candidate keeps the body; deleting the topic removes everything",
	async () => {
		const { user, project, topic } = await makeDraftTopic();
		const candidate = await db.publishingTopicDraft.create({
			data: {
				topicId: topic.id,
				projectId: project.id,
				userId: user.id,
				postType: "BLOG_POST",
				version: 1,
				status: "READY",
			},
		});
		await db.publishingTopicWorkingDraft.create({
			data: {
				topicId: topic.id,
				projectId: project.id,
				userId: user.id,
				postType: "BLOG_POST",
				body: "the body the user owns",
				sourceDraftId: candidate.id,
			},
		});

		// THIS is the case that catches an all-columns SET NULL: with one, the
		// delete raises a not-null violation on topicId/postType and fails here
		// rather than nulling a single column.
		await db.publishingTopicDraft.delete({ where: { id: candidate.id } });

		const survived = await db.publishingTopicWorkingDraft.findFirst({
			where: { topicId: topic.id, postType: "BLOG_POST" },
		});
		expect(survived?.body).toBe("the body the user owns");
		expect(survived?.sourceDraftId).toBeNull();
		// The other two referencing columns must be UNTOUCHED — they are what
		// the row's identity is built from.
		expect(survived?.topicId).toBe(topic.id);
		expect(survived?.postType).toBe("BLOG_POST");

		// The topic, by contrast, takes both tables with it. A working draft
		// outliving its topic would be an orphan no screen can reach.
		await db.publishingTopic.delete({ where: { id: topic.id } });
		expect(
			await db.publishingTopicDraft.count({
				where: { topicId: topic.id },
			}),
		).toBe(0);
		expect(
			await db.publishingTopicWorkingDraft.count({
				where: { topicId: topic.id },
			}),
		).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"2B-1 F: a draft cannot be attached to a topic in a different project",
	async () => {
		// The single-column FKs prove each id names a real row and nothing about
		// the two agreeing. Without the composite key a row pairing topic A with
		// project Y is accepted — and `listTopicDrafts` authorizes the caller on
		// `projectId` and then reads by exactly these two denormalised columns,
		// so a caller authorized on Y would receive topic A's draft metadata.
		const { user, topic } = await makeDraftTopic();
		const otherProject = await makePersonalProject(user.id);

		await expect(
			db.publishingTopicDraft.create({
				data: {
					topicId: topic.id,
					projectId: otherProject.id,
					userId: user.id,
					postType: "TWEET",
					version: 1,
					status: "READY",
				},
			}),
		).rejects.toThrow(/topic_project_fkey|foreign key/i);

		await expect(
			db.publishingTopicWorkingDraft.create({
				data: {
					topicId: topic.id,
					projectId: otherProject.id,
					userId: user.id,
					postType: "TWEET",
					body: "mismatched",
				},
			}),
		).rejects.toThrow(/topic_project_fkey|foreign key/i);
	},
);

it.skipIf(!RUN_DB)(
	"2B-1 E: a draft survives its old organization being deleted after a transfer",
	async () => {
		// The deterministic half of the transfer story. A draft generated under
		// org A whose project then moves to org B keeps A's organizationId until
		// something writes to it; deleting org A would then cascade away content
		// belonging to a project B owns. Once a write has re-homed the tuple,
		// that cascade must no longer reach it.
		const user = await makeUser();
		const orgA = await db.organization.create({
			data: {
				id: `draft-org-a-${randomUUID()}`,
				name: "org-a",
				slug: `draft-org-a-${randomUUID()}`,
				createdAt: new Date(),
			},
		});
		createdOrgIds.push(orgA.id);
		const orgB = await db.organization.create({
			data: {
				id: `draft-org-b-${randomUUID()}`,
				name: "org-b",
				slug: `draft-org-b-${randomUUID()}`,
				createdAt: new Date(),
			},
		});
		createdOrgIds.push(orgB.id);

		const project = await db.project.create({
			data: {
				name: "draft-transfer",
				userId: user.id,
				organizationId: orgA.id,
				techStack: [],
				features: [],
				tags: [],
			},
		});
		createdProjectIds.push(project.id);
		const topic = await db.publishingTopic.create({
			data: {
				projectId: project.id,
				organizationId: orgA.id,
				title: "transferred topic",
				status: "SUGGESTION",
				origin: "MANUAL",
				dedupeKey: `draft:${randomUUID()}`,
			},
		});
		const draft = await db.publishingTopicDraft.create({
			data: {
				topicId: topic.id,
				projectId: project.id,
				organizationId: orgA.id,
				postType: "TWEET",
				version: 1,
				status: "READY",
			},
		});

		// The transfer, and the re-home a subsequent write performs.
		await db.project.update({
			where: { id: project.id },
			data: { organizationId: orgB.id },
		});
		await db.publishingTopic.update({
			where: { id: topic.id },
			data: { organizationId: orgB.id },
		});
		await db.publishingTopicDraft.update({
			where: { id: draft.id },
			data: { organizationId: orgB.id },
		});

		await db.organization.delete({ where: { id: orgA.id } });

		expect(
			await db.publishingTopicDraft.findUnique({
				where: { id: draft.id },
			}),
		).not.toBeNull();
	},
);

// ---------------------------------------------------------------------------
// Phase 2B-2 (Fizzy #1853). The two unique constraints on `publishing_topic_draft`
// must be DISTINGUISHABLE from the error Prisma raises, because
// `startTopicDraftAttempt` answers "a run is already in flight" for one of them
// and RETHROWS for the other. 2A could treat any P2002 as in-flight; this table
// cannot, and a catch-all here would report a version collision as a generation
// that does not exist and will never report.
//
// Only a real server can produce these errors, and this repo's driver adapter
// leaves `meta.target` undefined for P2002 — so a discriminator written against
// the documented field alone matches nothing and sends every conflict down the
// fallback path. That is exactly the bug these two cases exist to catch.
// ---------------------------------------------------------------------------

it.skipIf(!RUN_DB)(
	"2B-2 G: the IN-FLIGHT index is nameable from the error it raises",
	async () => {
		const { user, project, topic } = await makeDraftTopic();
		const base = {
			topicId: topic.id,
			projectId: project.id,
			userId: user.id,
			executionTimeoutAt: new Date(Date.now() + 600_000),
		};

		await db.publishingTopicDraft.create({
			data: {
				...base,
				postType: "TWEET",
				version: 1,
				status: "GENERATING",
			},
		});

		let raised: unknown;
		try {
			// A SECOND generating row for the same content type. Version differs,
			// so only the partial index can fire.
			await db.publishingTopicDraft.create({
				data: {
					...base,
					postType: "TWEET",
					version: 2,
					status: "GENERATING",
				},
			});
		} catch (error) {
			raised = error;
		}

		expect(raised).toBeDefined();
		expect(uniqueViolationConstraint(raised)).toBe(
			"publishing_topic_draft_active",
		);
	},
);

it.skipIf(!RUN_DB)(
	"2B-2 H: the VERSION unique is nameable, and is NOT the in-flight index",
	async () => {
		const { user, project, topic } = await makeDraftTopic();
		const base = {
			topicId: topic.id,
			projectId: project.id,
			userId: user.id,
			// READY, so the partial index does not apply and the only constraint
			// left to violate is the version identity.
			status: "READY" as const,
		};

		await db.publishingTopicDraft.create({
			data: { ...base, postType: "TWEET", version: 1 },
		});

		let raised: unknown;
		try {
			await db.publishingTopicDraft.create({
				data: { ...base, postType: "TWEET", version: 1 },
			});
		} catch (error) {
			raised = error;
		}

		expect(raised).toBeDefined();
		const constraint = uniqueViolationConstraint(raised);
		// The POSITIVE half is what makes this a real test: asserting only
		// "not the in-flight index" would pass against a discriminator that
		// returns null for everything, which is the failure mode that would send
		// this collision down the in-flight path in production.
		expect(constraint).toBe(
			"publishing_topic_draft_topicId_postType_version_key",
		);
		expect(constraint).not.toBe("publishing_topic_draft_active");
	},
);

it.skipIf(!RUN_DB)(
	"2B-2 I: two GENERATING rows of DIFFERENT content types are both nameable",
	async () => {
		// Guards the discriminator against a lucky match: if it were keying on
		// something incidental to the first case's fixture rather than on the
		// constraint, a second content type would answer differently.
		const { user, project, topic } = await makeDraftTopic();
		const base = {
			topicId: topic.id,
			projectId: project.id,
			userId: user.id,
			status: "GENERATING" as const,
			executionTimeoutAt: new Date(Date.now() + 600_000),
		};

		await db.publishingTopicDraft.create({
			data: { ...base, postType: "BLOG_POST", version: 1 },
		});

		let raised: unknown;
		try {
			await db.publishingTopicDraft.create({
				data: { ...base, postType: "BLOG_POST", version: 2 },
			});
		} catch (error) {
			raised = error;
		}

		expect(uniqueViolationConstraint(raised)).toBe(
			"publishing_topic_draft_active",
		);
	},
);

// ---------------------------------------------------------------------------
// The WRITER against a real server. Cases G/H/I above prove the discriminator
// can name each constraint; these prove `startTopicDraftAttempt` composes it
// correctly — that a real partial-index violation comes back as an ANSWER and
// not as a thrown error. Nothing else joins those two halves: the mocked suite
// feeds the writer an error this file's own probe had to discover, and the
// discriminator cases never call the writer.
// ---------------------------------------------------------------------------

/**
 * A draft topic whose project is ACTIVE.
 *
 * `makePersonalProject` leaves the column at its schema default, which is DRAFT
 * — fine for every case above, which inserts rows through Prisma directly and
 * never consults project status. The WRITER does consult it, under its own lock,
 * and refuses anything that is not ACTIVE. Case N below pins that refusal, which
 * is how this helper came to exist: the writer cases failed on it first.
 */
async function makeActiveDraftTopic() {
	const fixture = await makeDraftTopic();
	await db.project.update({
		where: { id: fixture.project.id },
		data: { status: "ACTIVE" },
	});
	return fixture;
}

it.skipIf(!RUN_DB)(
	"2B-2 N: a project that is not ACTIVE cannot start a generation",
	async () => {
		// `makeDraftTopic` leaves the project at the schema default of DRAFT.
		// The refusal is `project_ineligible` and NOT `not_found`: the topic is
		// perfectly fine, and reporting it missing would send a reader looking
		// for something that is not the problem.
		const { user, project, topic } = await makeDraftTopic();

		const result = await startTopicDraftAttempt({
			topicId: topic.id,
			projectId: project.id,
			postType: "TWEET",
			requestedById: user.id,
			guidance: null,
		});

		expect(result).toEqual({ status: "project_ineligible" });
		expect(
			await db.publishingTopicDraft.count({
				where: { topicId: topic.id },
			}),
		).toBe(0);
	},
);

it.skipIf(!RUN_DB)(
	"2B-2 J: a second attempt on a live run answers in_flight rather than throwing",
	async () => {
		const { user, project, topic } = await makeActiveDraftTopic();

		const first = await startTopicDraftAttempt({
			topicId: topic.id,
			projectId: project.id,
			postType: "TWEET",
			requestedById: user.id,
			guidance: null,
		});
		expect(first.status).toBe("started");

		const second = await startTopicDraftAttempt({
			topicId: topic.id,
			projectId: project.id,
			postType: "TWEET",
			requestedById: user.id,
			guidance: null,
		});

		// A double-click is routine. If the discriminator fails to name the
		// partial index the writer rethrows, and this routine action becomes a
		// 500 — which is exactly the bug the first draft of that function had,
		// invisible to every mocked case because the mock encoded the same guess.
		expect(second).toEqual({ status: "in_flight" });
	},
);

it.skipIf(!RUN_DB)(
	"2B-2 K: the row the writer created carries what it claimed to write",
	async () => {
		const { user, project, topic } = await makeActiveDraftTopic();

		const started = await startTopicDraftAttempt({
			topicId: topic.id,
			projectId: project.id,
			postType: "TWEET",
			requestedById: user.id,
			guidance: "  keep it short  ",
		});
		if (started.status !== "started") {
			throw new Error(`expected started, got ${started.status}`);
		}

		// Read the durable row back rather than trusting the return value. The
		// mocked suite asserts the payload handed to Prisma; only this can say
		// the database accepted it — the tenant XOR and the
		// GENERATING-implies-deadline CHECKs both apply to this exact insert.
		const row = await db.publishingTopicDraft.findUniqueOrThrow({
			where: { id: started.draftId },
		});
		expect(row.version).toBe(1);
		expect(row.status).toBe("GENERATING");
		expect(row.postType).toBe("TWEET");
		// Personal project: XOR-normalised to userId, org null.
		expect(row.organizationId).toBeNull();
		expect(row.userId).toBe(user.id);
		// Authorship is a DIFFERENT column from tenancy, which is the whole
		// reason the XOR CHECK does not reject an org project's row.
		expect(row.requestedById).toBe(user.id);
		expect(row.guidance).toBe("  keep it short  ");
		expect(row.executionTimeoutAt).not.toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"2B-2 L: a BLOG POST attempt starts while a short post is still generating",
	async () => {
		// The positive half of the per-content-type index, driven through the
		// WRITER rather than through raw creates. A rejection-only case passes
		// just as well against a writer that refuses everything.
		const { user, project, topic } = await makeActiveDraftTopic();
		const base = {
			topicId: topic.id,
			projectId: project.id,
			requestedById: user.id,
			guidance: null,
		};

		const tweet = await startTopicDraftAttempt({
			...base,
			postType: "TWEET",
		});
		const blog = await startTopicDraftAttempt({
			...base,
			postType: "BLOG_POST",
		});

		expect(tweet.status).toBe("started");
		expect(blog.status).toBe("started");
		// Versions are per content type, so both are 1 rather than 1 and 2.
		expect(tweet).toMatchObject({ version: 1 });
		expect(blog).toMatchObject({ version: 1 });
	},
);

it.skipIf(!RUN_DB)(
	"2B-2 M: a stranded run is reclaimed, and the next attempt gets the next version",
	async () => {
		const { user, project, topic } = await makeActiveDraftTopic();
		const base = {
			topicId: topic.id,
			projectId: project.id,
			postType: "TWEET" as const,
			requestedById: user.id,
			guidance: null,
		};

		const first = await startTopicDraftAttempt(base);
		if (first.status !== "started") {
			throw new Error("expected started");
		}
		// Push the deadline into the past, which is what a worker that died
		// between the insert and its terminal marker leaves behind.
		await db.publishingTopicDraft.update({
			where: { id: first.draftId },
			data: { executionTimeoutAt: new Date(Date.now() - 60_000) },
		});

		const second = await startTopicDraftAttempt(base);

		// Without the reclaim the partial index is a PERMANENT lock on this
		// content type and no user action recovers it.
		expect(second).toMatchObject({ status: "started", version: 2 });
		const reclaimed = await db.publishingTopicDraft.findUniqueOrThrow({
			where: { id: first.draftId },
		});
		expect(reclaimed.status).toBe("FAILED");
		// Cleared, so the reclaimed row stops matching the expiry predicate and
		// does not read as perpetually stranded on the page.
		expect(reclaimed.executionTimeoutAt).toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"2B-2 O: a selected option lands as the working draft, and a stale caller is refused",
	async () => {
		const { user, project, topic } = await makeActiveDraftTopic();
		const candidate = await db.publishingTopicDraft.create({
			data: {
				topicId: topic.id,
				projectId: project.id,
				userId: user.id,
				postType: "TWEET",
				version: 1,
				status: "READY",
			},
		});

		const saved = await saveWorkingDraft({
			topicId: topic.id,
			projectId: project.id,
			postType: "TWEET",
			sourceDraftId: candidate.id,
			sourceOptionLabel: "Direct",
			body: "Builds are faster now.",
			updatedById: user.id,
			expectedUpdatedAt: null,
		});
		expect(saved.status).toBe("saved");

		// Read the durable row back. The composite foreign key, the tenant XOR
		// CHECK and the (topicId, postType) unique all apply to this exact
		// upsert, and only a real server can say they were satisfied.
		const row = await db.publishingTopicWorkingDraft.findUniqueOrThrow({
			where: {
				topicId_postType: { topicId: topic.id, postType: "TWEET" },
			},
		});
		expect(row.body).toBe("Builds are faster now.");
		expect(row.sourceDraftId).toBe(candidate.id);
		expect(row.sourceOptionLabel).toBe("Direct");
		expect(row.organizationId).toBeNull();
		expect(row.userId).toBe(user.id);

		// A caller still believing nothing is saved is now stale. Without this
		// the second of two concurrent selections silently erases the first: the
		// project lock serialises the writes and says nothing about whether the
		// second writer knew what it was overwriting.
		const stale = await saveWorkingDraft({
			topicId: topic.id,
			projectId: project.id,
			postType: "TWEET",
			sourceDraftId: candidate.id,
			sourceOptionLabel: "Story-led",
			body: "A different post.",
			updatedById: user.id,
			// Still believing nothing is saved, which is now untrue.
			expectedUpdatedAt: null,
		});
		expect(stale).toEqual({ status: "stale" });
		// And the refusal wrote nothing.
		expect(
			(
				await db.publishingTopicWorkingDraft.findUniqueOrThrow({
					where: {
						topicId_postType: {
							topicId: topic.id,
							postType: "TWEET",
						},
					},
				})
			).body,
		).toBe("Builds are faster now.");
	},
);

afterAll(async () => {
	await db.project.deleteMany({ where: { id: { in: createdProjectIds } } });
	await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
	await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
});
