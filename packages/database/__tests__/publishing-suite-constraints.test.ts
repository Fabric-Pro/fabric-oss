import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { db } from "../index"; // package root barrel (what consumers import as @repo/database)

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

afterAll(async () => {
	await db.project.deleteMany({ where: { id: { in: createdProjectIds } } });
	await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
	await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
});
