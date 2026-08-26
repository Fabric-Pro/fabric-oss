import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, expect, it } from "vitest";
// The package ROOT barrel — what consumers import as @repo/database, and what
// every sibling suite in this directory imports. Not `../src/client`.
import { db } from "../index";
import {
	claimPublishingChatDelivery,
	listPublishingChatDeliveriesForCycle,
	listPublishingChatDeliveriesForProjectCycle,
	markPublishingChatDelivery,
} from "../prisma/queries/projects/publishing-chat-delivery";

// REAL-DB integration test for the broadcast ledger's writers (Fizzy #1850,
// Phase 1C-3b). Gated on RUN_DB_INTEGRATION like every sibling in this
// directory, so the no-Postgres unit run SKIPS it; it runs in the
// db-integration CI job, which additionally asserts that nothing skipped.
const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";

const createdUserIds: string[] = [];
const createdProjectIds: string[] = [];
const createdCycleIds: string[] = [];

let projectId = "";
let userId = "";
let cycleId = "";

const target = {
	platform: "SLACK" as const,
	externalTeamId: "T-example",
	channelId: "C-example",
};

/** Personal project + a READY cycle, created once and reused across cases. */
async function fixture() {
	if (cycleId) {
		return;
	}
	const user = await db.user.create({
		data: {
			id: `pub-chat-${randomUUID()}`,
			name: "pub-chat-delivery",
			email: `pub-chat-${randomUUID()}@test.local`,
			emailVerified: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	createdUserIds.push(user.id);
	userId = user.id;

	const project = await db.project.create({
		data: {
			name: "pub-chat",
			userId: user.id,
			techStack: [],
			features: [],
			tags: [],
		},
	});
	createdProjectIds.push(project.id);
	projectId = project.id;

	const cycle = await db.publishingSuggestionCycle.create({
		data: {
			projectId: project.id,
			userId: user.id,
			status: "READY",
			actorUserId: user.id,
			coveredThrough: new Date(),
		},
	});
	createdCycleIds.push(cycle.id);
	cycleId = cycle.id;
}

const claim = () =>
	claimPublishingChatDelivery({
		cycleId,
		projectId,
		organizationId: null,
		userId,
		...target,
	});

beforeEach(async () => {
	if (!RUN_DB) {
		return;
	}
	await fixture();
	await db.publishingChatDelivery.deleteMany({ where: { cycleId } });
});

afterAll(async () => {
	if (!RUN_DB) {
		return;
	}
	await db.publishingChatDelivery.deleteMany({
		where: { cycleId: { in: createdCycleIds } },
	});
	await db.publishingSuggestionCycle.deleteMany({
		where: { id: { in: createdCycleIds } },
	});
	await db.project.deleteMany({ where: { id: { in: createdProjectIds } } });
	await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

it.skipIf(!RUN_DB)(
	"claims an unseen channel and writes it SENDING",
	async () => {
		expect(await claim()).toEqual({ claimed: true });
		const rows = await listPublishingChatDeliveriesForCycle(cycleId);
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("SENDING");
	},
);

// FOUR cases, not one. A single-status case passes just as well against a claim
// whose refusal predicate names only that status — and the guarantee being
// pinned is that ANY pre-existing row refuses, a SENDING one included, since
// that is what a crashed attempt leaves behind after the provider already
// accepted the message.
for (const status of ["SENDING", "SENT", "FAILED", "SKIPPED"] as const) {
	it.skipIf(!RUN_DB)(
		`refuses a claim against an existing ${status} row`,
		async () => {
			expect(await claim()).toEqual({ claimed: true });
			if (status !== "SENDING") {
				await markPublishingChatDelivery({
					cycleId,
					...target,
					status,
				});
			}
			expect(await claim()).toEqual({ claimed: false });
			expect(
				await listPublishingChatDeliveriesForCycle(cycleId),
			).toHaveLength(1);
		},
	);
}

it.skipIf(!RUN_DB)("claims a DIFFERENT channel in the same cycle", async () => {
	expect(await claim()).toEqual({ claimed: true });
	expect(
		await claimPublishingChatDelivery({
			cycleId,
			projectId,
			organizationId: null,
			userId,
			platform: "TEAMS",
			externalTeamId: "T-example",
			channelId: "C-example",
		}),
	).toEqual({ claimed: true });
	expect(await listPublishingChatDeliveriesForCycle(cycleId)).toHaveLength(2);
});

it.skipIf(!RUN_DB)(
	"records SENT with the provider message id and a delivery timestamp",
	async () => {
		await claim();
		await markPublishingChatDelivery({
			cycleId,
			...target,
			status: "SENT",
			postedMessageId: "1699999999.000100",
		});
		const [row] = await listPublishingChatDeliveriesForCycle(cycleId);
		expect(row.status).toBe("SENT");
		expect(row.postedMessageId).toBe("1699999999.000100");
		expect(row.deliveredAt).not.toBeNull();
	},
);

// The two columns are not interchangeable and the spec asserts skips on `reason`
// specifically: `reason` is a closed classification an operator can filter on,
// `errorMessage` is free provider text. A writer that put the classification in
// errorMessage would satisfy every count in this suite.
it.skipIf(!RUN_DB)(
	"writes the classification to `reason` and provider text to `errorMessage`",
	async () => {
		await claim();
		await markPublishingChatDelivery({
			cycleId,
			...target,
			status: "FAILED",
			reason: "POST_FAILED",
			errorMessage: "channel_not_found",
		});
		const [row] = await listPublishingChatDeliveriesForCycle(cycleId);
		expect(row.reason).toBe("POST_FAILED");
		expect(row.errorMessage).toBe("channel_not_found");
		expect(row.deliveredAt).toBeNull();
	},
);

// The skip path lands its final status in the claim, in ONE statement. Proven
// against the real status CHECK rather than a mock: the constraint has to admit
// SKIPPED on an INSERT, not only on the UPDATE the settle used to perform.
it.skipIf(!RUN_DB)(
	"claims straight into SKIPPED with a reason, in one statement",
	async () => {
		expect(
			await claimPublishingChatDelivery({
				cycleId,
				projectId,
				organizationId: null,
				userId,
				...target,
				status: "SKIPPED",
				reason: "CHANNEL_NOT_LINKED",
			}),
		).toEqual({ claimed: true });
		const [row] = await listPublishingChatDeliveriesForCycle(cycleId);
		expect(row.status).toBe("SKIPPED");
		expect(row.reason).toBe("CHANNEL_NOT_LINKED");
		expect(row.deliveredAt).toBeNull();
	},
);

// The row a skip writes must refuse a later send claim exactly as a settled one
// does — otherwise moving the skip into the claim would have quietly opened the
// door the two-statement version kept shut.
it.skipIf(!RUN_DB)(
	"a SKIPPED claim still refuses a later send claim",
	async () => {
		await claimPublishingChatDelivery({
			cycleId,
			projectId,
			organizationId: null,
			userId,
			...target,
			status: "SKIPPED",
			reason: "LINKER_NOT_AUTHORIZED",
		});
		expect(await claim()).toEqual({ claimed: false });
		expect(
			await listPublishingChatDeliveriesForCycle(cycleId),
		).toHaveLength(1);
	},
);

it.skipIf(!RUN_DB)("leaves another cycle's rows alone", async () => {
	await claim();
	await markPublishingChatDelivery({
		cycleId: `${cycleId}-absent`,
		...target,
		status: "SENT",
	});
	const [row] = await listPublishingChatDeliveriesForCycle(cycleId);
	expect(row.status).toBe("SENDING");
});

// ---- The API-facing reader (Fizzy #1850, Phase 1C-4b).

/**
 * The `projectId` argument is the security boundary, not a convenience: an API
 * caller's `cycleId` is untrusted, so without it any authenticated user who can
 * read one project could read another project's delivery ledger by passing that
 * project's cycle id.
 */
it.skipIf(!RUN_DB)(
	"refuses a cycle that belongs to a different project",
	async () => {
		const otherUser = await db.user.create({
			data: {
				id: `pub-chat-other-${randomUUID()}`,
				name: "pub-chat-other",
				email: `pub-chat-other-${randomUUID()}@test.local`,
				emailVerified: false,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		createdUserIds.push(otherUser.id);
		const otherProject = await db.project.create({
			data: {
				name: "pub-chat-other",
				userId: otherUser.id,
				techStack: [],
				features: [],
				tags: [],
			},
		});
		// Registered so afterAll reaches it. This file's beforeEach truncates only
		// the SHARED cycle's rows, so anything seeded here would otherwise outlive
		// this case and leak into the ordering test below.
		createdProjectIds.push(otherProject.id);
		const otherCycle = await db.publishingSuggestionCycle.create({
			data: {
				projectId: otherProject.id,
				userId: otherUser.id,
				status: "READY",
				actorUserId: otherUser.id,
				coveredThrough: new Date(),
			},
		});
		createdCycleIds.push(otherCycle.id);

		await claimPublishingChatDelivery({
			cycleId: otherCycle.id,
			projectId: otherProject.id,
			organizationId: null,
			userId: otherUser.id,
			...target,
		});

		// The positive read is what makes the empty result below mean SCOPING
		// rather than a failed seed. It is written first so a seed failure
		// reports as a seed failure; both run in the same case either way, so
		// the order buys a clearer message, not the guarantee itself.
		expect(
			await listPublishingChatDeliveriesForProjectCycle(
				otherCycle.id,
				otherProject.id,
			),
		).toHaveLength(1);

		expect(
			await listPublishingChatDeliveriesForProjectCycle(
				otherCycle.id,
				projectId,
			),
		).toEqual([]);

		await db.publishingChatDelivery.deleteMany({
			where: { cycleId: otherCycle.id },
		});
	},
);

/**
 * Proves the `externalTeamId` term is load-bearing WITHOUT seeding a tie.
 *
 * A tie-based control (compare two reads, or page with OFFSET) depends on how
 * Postgres resolves the tie, which depends on the plan: walking the unique index
 * `(cycleId, platform, externalTeamId, channelId)` already yields the full-triple
 * order, so a mutated ORDER BY receives pre-sorted input and passes by luck.
 *
 * These two rows make the two orderings strictly disagree instead. By
 * (platform, externalTeamId, channelId) the answer is T1/C2 then T2/C1; by
 * (platform, channelId) it is the reverse. No ties, no plan dependence.
 */
it.skipIf(!RUN_DB)(
	"orders on externalTeamId, not on channelId alone",
	async () => {
		// Inserted in the order that DISAGREES with the expected output, so a
		// read with no `orderBy` at all returns insertion order and fails too —
		// asserting only against a MUTATED clause would leave a deleted one
		// uncaught, and a deleted clause is the likelier refactor casualty.
		for (const row of [
			{ externalTeamId: "T2", channelId: "C1" },
			{ externalTeamId: "T1", channelId: "C2" },
		]) {
			await claimPublishingChatDelivery({
				cycleId,
				projectId,
				organizationId: null,
				userId,
				platform: "SLACK",
				...row,
			});
		}

		const rows = await listPublishingChatDeliveriesForProjectCycle(
			cycleId,
			projectId,
		);

		expect(rows.map((r) => `${r.externalTeamId}:${r.channelId}`)).toEqual([
			"T1:C2",
			"T2:C1",
		]);
	},
);

/**
 * The `cycleId` predicate, which the two cases above do NOT cover: the shared
 * fixture builds exactly one cycle per project, so dropping `cycleId` from the
 * `where` leaves every case in this file green — the reader would then serve
 * EVERY cycle's deliveries under whichever row the user expanded.
 */
it.skipIf(!RUN_DB)("returns only the named cycle's rows", async () => {
	await claim();

	const sibling = await db.publishingSuggestionCycle.create({
		data: {
			projectId,
			userId,
			status: "READY",
			actorUserId: userId,
			coveredThrough: new Date(),
		},
	});
	createdCycleIds.push(sibling.id);
	await claimPublishingChatDelivery({
		cycleId: sibling.id,
		projectId,
		organizationId: null,
		userId,
		platform: "TEAMS",
		externalTeamId: "T-sibling",
		channelId: "C-sibling",
	});

	const rows = await listPublishingChatDeliveriesForProjectCycle(
		cycleId,
		projectId,
	);

	expect(rows).toHaveLength(1);
	expect(rows[0].channelId).toBe(target.channelId);
	// Same project, so the projectId bound cannot be what excluded it.
	expect(
		await listPublishingChatDeliveriesForProjectCycle(
			sibling.id,
			projectId,
		),
	).toHaveLength(1);

	await db.publishingChatDelivery.deleteMany({
		where: { cycleId: sibling.id },
	});
});

/** The API must be able to render an outcome without a second read. */
it.skipIf(!RUN_DB)("returns the fields the panel renders", async () => {
	await claim();
	await markPublishingChatDelivery({
		cycleId,
		...target,
		status: "FAILED",
		reason: "POST_FAILED",
		errorMessage: "not_in_channel",
	});

	const [row] = await listPublishingChatDeliveriesForProjectCycle(
		cycleId,
		projectId,
	);

	expect(row).toEqual({
		platform: "SLACK",
		externalTeamId: target.externalTeamId,
		channelId: target.channelId,
		status: "FAILED",
		reason: "POST_FAILED",
		errorMessage: "not_in_channel",
		// Asserted as an exact SHAPE, not field by field: the failure mode is an
		// unexpected column riding along, which a per-field assertion cannot see.
		createdAt: expect.any(Date),
	});
});
