import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, expect, it, vi } from "vitest";

// @repo/mail is mocked because the provider call is the one thing that must NOT be real here.
// Everything else — the ledger, the fence, the token — runs against real Postgres, because every
// property worth asserting lives in a conditional UPDATE that a mocked client does not have.
vi.mock("@repo/mail", () => ({
	isMailConfigured: vi.fn(() => true),
	sendEmail: vi.fn(() => Promise.resolve(true)),
}));

// Exactly what the cases in THIS file reference, and nothing more — Biome fails an unused import,
// so a generous list breaks the lint step as surely as a short one breaks the compile.
// `isMailConfigured` stays in the mock factory above (a partial module mock must still provide it)
// but is not imported here: this file drives deliverPublishingTopicsReadyEmail directly, and that
// module reads only `sendEmail`. The activity that consults isMailConfigured is exercised in
// publishing-notify-activity.test.ts instead.
import {
	claimPublishingEmailDelivery,
	db,
	type PrismaQueryObserver,
	PUBLISHING_EMAIL_PROVIDER_DEDUPE_WINDOW_MS,
	setPrismaQueryObserver,
	terminalizeExistingDeliveriesAsSkipped,
} from "@repo/database";
import { sendEmail } from "@repo/mail";
import { deliverPublishingTopicsReadyEmail } from "../src/activities/publishing-suggestion/deliver-topics-ready-email";

const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";

/**
 * The registered query observer is MODULE state — `setPrismaQueryObserver` replaces the single
 * registered function — so it must be restored in a `finally`, or every later test in this file runs
 * under whatever the last one installed. Same shape and same discipline as the activity suite's.
 */
const passThrough: PrismaQueryObserver = ({ args, query }) => query(args);
setPrismaQueryObserver(passThrough);

async function withQueryObserver<T>(
	observer: PrismaQueryObserver,
	body: () => Promise<T>,
): Promise<T> {
	setPrismaQueryObserver(observer);
	try {
		return await body();
	} finally {
		setPrismaQueryObserver(passThrough);
	}
}

const projectIds: string[] = [];
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

/**
 * The seed helpers below are COPIED from publishing-notify-activity.test.ts rather than extracted
 * to a shared module, and that duplication is deliberate. Each of these files decides in its own
 * `vi.mock` factory which `@repo/database` exports are spies; a shared fixture would import the
 * real module while its caller imports the mocked one, so the rows it seeded and the rows the code
 * under test reads would travel through two different clients.
 */
async function seedUser(name: string) {
	const user = await db.user.create({
		data: {
			id: `user-${randomUUID()}`,
			name,
			// `User.createdAt` / `updatedAt` carry no Prisma default, so both are required here.
			email: `${randomUUID()}@example.com`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	createdUserIds.push(user.id);
	return user;
}

async function seedOrg(name: string) {
	const orgId = `org-${randomUUID()}`;
	await db.organization.create({
		data: {
			id: orgId,
			name,
			slug: `slug-${randomUUID()}`,
			createdAt: new Date(),
		},
	});
	createdOrgIds.push(orgId);
	return orgId;
}

/**
 * An ACTIVE organization project with a READY cycle — the only state this delivery is ever reached
 * from. `status: ACTIVE` is not decoration: the claim's tenant fence mirrors persistCycleTerminal's
 * F1 eligibility filter, so a DRAFT fixture would make every claim answer TENANT_CHANGED for a
 * reason that cannot occur in production.
 */
async function seedReadyCycle() {
	const orgId = await seedOrg("1C-2c email org");
	const owner = await seedUser("Tenant owner");
	const project = await db.project.create({
		data: {
			name: "Example project",
			userId: owner.id,
			organizationId: orgId,
			status: "ACTIVE",
		},
	});
	projectIds.push(project.id);
	const cycle = await db.publishingSuggestionCycle.create({
		data: {
			projectId: project.id,
			organizationId: orgId,
			status: "READY",
			actorUserId: owner.id,
			coveredThrough: new Date(),
		},
	});
	const tenant = {
		projectId: project.id,
		organizationId: orgId as string | null,
		userId: null as string | null,
	};
	return { orgId, owner, project, cycle, tenant };
}

const ACCEPTED_AT = new Date("2026-01-01T00:00:00.000Z");

async function addProjectMember(
	projectId: string,
	userId: string,
	role: "OWNER" | "PROJECT_ADMIN" | "EDITOR" | "COMMENTER" | "VIEWER",
) {
	await db.projectMember.create({
		data: {
			projectId,
			userId,
			role,
			invitedBy: userId,
			acceptedAt: ACCEPTED_AT,
		},
	});
}

/**
 * The same, with N eligible EDITORs instead of one. Returns their ids in creation order.
 */
async function seedReadyCycleWithRecipients(count: number) {
	const { orgId, project, cycle, tenant } = await seedReadyCycle();
	const recipientUserIds: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const editor = await seedUser(`Eligible editor ${index + 1}`);
		await addProjectMember(project.id, editor.id, "EDITOR");
		recipientUserIds.push(editor.id);
	}
	return {
		cycleId: cycle.id,
		projectId: project.id,
		organizationId: orgId,
		recipientUserIds,
		tenant,
	};
}

/**
 * A READY cycle on an ACTIVE organization project, plus one recipient who is genuinely eligible:
 * an accepted, unexpired EDITOR. EDITOR because PUBLISHING_TOPIC_CREATE is Editor+ at project
 * level — a VIEWER holds only PUBLISHING_TOPIC_READ and would be filtered out upstream.
 *
 * No NotificationPreference row is created: the opt-out model means a missing row is "enabled on
 * both channels", which is the state every case here wants.
 */
async function seedReadyCycleWithRecipient() {
	const seeded = await seedReadyCycleWithRecipients(1);
	const recipientUserId = seeded.recipientUserIds[0];
	if (!recipientUserId) {
		throw new Error("seedReadyCycleWithRecipients(1) seeded no recipient");
	}
	return { ...seeded, recipientUserId };
}

afterAll(async () => {
	if (!RUN_DB) {
		return;
	}
	// Delivery rows cascade from the cycle (PublishingNotificationDelivery.cycle is
	// onDelete: Cascade), so deleting the cycles takes the ledger with them.
	await db.publishingSuggestionCycle.deleteMany({
		where: { projectId: { in: projectIds } },
	});
	await db.project.deleteMany({ where: { id: { in: projectIds } } });
	await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
	await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

/**
 * Both mocks this file installs — the console.warn spy the loud/fresh pair use, and the shared
 * sendEmail mock — are reset HERE rather than trusted to each case's own cleanup.
 *
 * `vi.spyOn` on an already-spied method hands back the EXISTING spy, so a case that installs
 * `console.warn` and fails before reaching its own `mockRestore()` leaves the mock installed for
 * every case that runs after it — swallowing `claimPublishingEmailDelivery`'s own warnings while
 * someone is trying to debug the failure. `vi.restoreAllMocks()` runs unconditionally, on both
 * pass and fail, which closes that.
 *
 * It also does more than `mockClear()` ever did for `sendEmail`: `mockClear()` empties call
 * history but leaves a queued `mockResolvedValueOnce` / `mockImplementationOnce` in place for the
 * next case to consume by accident. `mockRestore()` is equivalent to `mockReset()` for a mock that
 * (like this file's `sendEmail`) was created with `vi.fn(impl)` rather than `vi.spyOn` — there is
 * no spied original to return to, so it drains the queue and restores the factory's default
 * `Promise.resolve(true)` instead. No case here happens to leak on one today, but that soundness
 * would otherwise depend on every earlier case's queued value being fully consumed, which is the
 * same fragility already fixed for the warn spy above.
 */
afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * The delivery call's arguments for a seeded fixture, in one place.
 *
 * Every test here calls `deliverPublishingTopicsReadyEmail` with the same seven fields and varies
 * only the mail mock or the row's prior state. Repeating the literal in each test buries that —
 * and invites a test to differ in a field it did not mean to vary, which is how a case ends up
 * proving something other than its name.
 */
function args(seeded: Awaited<ReturnType<typeof seedReadyCycleWithRecipient>>) {
	return {
		cycleId: seeded.cycleId,
		tenant: seeded.tenant,
		recipientUserId: seeded.recipientUserId,
		recipientEmail: "dev@example.com",
		projectName: "Example project",
		topicCount: 3,
		url: "https://example.com/app/example-org/projects/example-project-id/publishing",
	};
}

/**
 * NOT gated on RUN_DB, because it asks nothing of the database.
 *
 * `worker.ts` does `import * as activities from "./activities"` and hands the whole namespace to
 * every Worker.create, so ANYTHING the publishing-suggestion barrel re-exports becomes a registered
 * Temporal activity. This function is a helper called inside the notification activity's recipient
 * loop, not an activity: registering it would publish a second retry boundary nobody schedules, and
 * would invite a future caller to `proxyActivities` it — at which point one recipient's send would
 * get its own independent retry budget racing the one PUBLISHING_EMAIL_LEASE_MS was sized against,
 * and the lease would stop being the thing that makes two attempts mutually exclusive.
 *
 * A barrel line is one word and reads like tidying up. Nothing else in the repo would object to it:
 * there is no test anywhere that asserts the registered activity set, so without this case the
 * constraint lives only in a comment.
 */
it("is NOT re-exported through the activities barrel", async () => {
	const barrel = await import(
		"../src/activities/publishing-suggestion/index"
	);
	expect(Object.keys(barrel)).not.toContain(
		"deliverPublishingTopicsReadyEmail",
	);
	// A positive control, so this cannot pass because the barrel failed to load or was renamed.
	expect(Object.keys(barrel)).toContain(
		"runPublishingTopicsReadyNotification",
	);
});

it.skipIf(!RUN_DB)(
	"sends with the template, the absolute url and the idempotency key",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		// Captured from inside the mock, between the claim and the confirmation — the only way to
		// pin "the token the claim issued" from the test without adding a read to the module
		// itself. The module's own invariant is exactly three DB calls, none of them a read.
		let claimTokenAtSendTime: string | null = null;
		vi.mocked(sendEmail).mockImplementationOnce(async () => {
			const claimed =
				await db.publishingNotificationDelivery.findUniqueOrThrow({
					where: {
						cycleId_recipientUserId_channel: {
							cycleId: seeded.cycleId,
							recipientUserId: seeded.recipientUserId,
							channel: "EMAIL",
						},
					},
				});
			claimTokenAtSendTime = claimed.claimToken;
			return true;
		});

		const outcome = await deliverPublishingTopicsReadyEmail({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
			recipientEmail: "dev@example.com",
			projectName: "Example project",
			topicCount: 3,
			url: "https://example.com/app/example-org/projects/p1/publishing",
		});

		expect(outcome).toBe("SENT");
		// The key is asserted explicitly because nothing else in the system would notice its
		// absence: it is the only duplicate protection that survives the ambiguous-commit window,
		// and a send without it looks identical in every log and every row.
		expect(vi.mocked(sendEmail)).toHaveBeenCalledWith({
			to: "dev@example.com",
			templateId: "publishingTopicsReady",
			idempotencyKey: `publishing-${seeded.cycleId}-${seeded.recipientUserId}`,
			context: {
				projectName: "Example project",
				topicCount: 3,
				url: "https://example.com/app/example-org/projects/p1/publishing",
			},
		});
		// The module's central durable effect, read back rather than trusted from the return value
		// alone: nothing else in this case would notice if confirmPublishingEmailDelivery were
		// deleted and the module returned "SENT" directly.
		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		expect(row.status).toBe("SENT");
		expect(row.deliveredAt).not.toBeNull();
		// claimToken deliberately SURVIVES confirmation rather than being cleared — unlike the
		// FAILED path, which releases it so a retry can recover immediately. That is what lets a
		// late-arriving failure be refused by IDENTITY (its token no longer matches what the row
		// carries) rather than by timing.
		expect(claimTokenAtSendTime).not.toBeNull();
		expect(row.claimToken).toBe(claimTokenAtSendTime);
	},
);

it.skipIf(!RUN_DB)(
	"a false return marks the row FAILED and releases the claim",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		vi.mocked(sendEmail).mockResolvedValueOnce(false);

		const outcome = await deliverPublishingTopicsReadyEmail({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
			recipientEmail: "dev@example.com",
			projectName: "Example project",
			topicCount: 1,
			url: "https://example.com/app/projects/p1/publishing",
		});

		expect(outcome).toBe("FAILED");
		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		expect(row.status).toBe("FAILED");
		expect(row.claimToken).toBeNull();
		// The provider's own message must never reach this column verbatim — `reason` is a
		// classification, and a raw body is how an address or a subject line ends up in a table
		// operators read.
		expect(row.reason).toBe("PROVIDER_REJECTED");
	},
);

it.skipIf(!RUN_DB)(
	"a throw from the provider is caught, recorded and reported as FAILED",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		// sendEmail is documented never to throw. This asserts the module does not RELY on that:
		// a dependency's contract is not a guarantee about its next version, and an uncaught
		// throw here would leave the row SENDING with its lease held for five minutes.
		vi.mocked(sendEmail).mockRejectedValueOnce(new Error("socket hang up"));

		const outcome = await deliverPublishingTopicsReadyEmail({
			cycleId: seeded.cycleId,
			tenant: seeded.tenant,
			recipientUserId: seeded.recipientUserId,
			recipientEmail: "dev@example.com",
			projectName: "Example project",
			topicCount: 2,
			url: "https://example.com/app/projects/p1/publishing",
		});

		expect(outcome).toBe("FAILED");
		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		expect(row.status).toBe("FAILED");
		expect(row.claimToken).toBeNull();
		// PROVIDER_ERROR, not PROVIDER_REJECTED: the union's two members exist to tell a THROW
		// apart from a `false` return, and the throw's own text lives in errorMessage rather than
		// in the classification column.
		expect(row.reason).toBe("PROVIDER_ERROR");
		expect(row.errorMessage).toBe("socket hang up");
	},
);

it.skipIf(!RUN_DB)(
	"a known failure keeps lastAttemptAt, and re-sending past the window still proceeds — loudly",
	async () => {
		// The defect this pins: recordPublishingEmailFailure releases claimedAt so a retry can
		// recover, and a guard keyed on claimedAt therefore reads a FAILED row as never-attempted.
		// FAILED is the MOST COMMON shape of "the provider may already have accepted", because a
		// false return covers a provider error arriving after acceptance.
		const seeded = await seedReadyCycleWithRecipient();
		vi.mocked(sendEmail).mockResolvedValueOnce(false);
		await deliverPublishingTopicsReadyEmail({ ...args(seeded) });

		const failed =
			await db.publishingNotificationDelivery.findUniqueOrThrow({
				where: {
					cycleId_recipientUserId_channel: {
						cycleId: seeded.cycleId,
						recipientUserId: seeded.recipientUserId,
						channel: "EMAIL",
					},
				},
			});
		expect(failed.status).toBe("FAILED");
		expect(failed.claimedAt).toBeNull(); // the lease WAS released
		expect(failed.lastAttemptAt).not.toBeNull(); // the fact was NOT

		// Age it past the provider's retention and re-send.
		const agedTo = new Date(
			Date.now() - PUBLISHING_EMAIL_PROVIDER_DEDUPE_WINDOW_MS - 60_000,
		);
		await db.publishingNotificationDelivery.update({
			where: { id: failed.id },
			data: { lastAttemptAt: agedTo },
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.mocked(sendEmail).mockResolvedValueOnce(true);

		const outcome = await deliverPublishingTopicsReadyEmail({
			...args(seeded),
		});

		// PROCEEDS — refusing would drop the notification, and the spec ranks a possible duplicate
		// above a possible silent drop. But it must leave evidence, or a duplicate that reaches a
		// recipient is unexplainable afterwards.
		expect(outcome).toBe("SENT");
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("past the provider dedupe window"),
			expect.objectContaining({
				recipientUserId: seeded.recipientUserId,
			}),
		);
		// The assertion above pins the message and who it was about; this one pins the rest of the
		// payload, because that is the EVIDENCE the whole branch exists to leave. Proceeding past
		// the window is only defensible if a duplicate can be explained afterwards, and it cannot
		// be explained from a recipient id alone — an operator needs the project, the cycle, and
		// above all HOW STALE the previous attempt was. Deleting any one of those three fields
		// leaves every other case in this file green, which is exactly why they are named here.
		expect(warn).toHaveBeenCalledWith(expect.any(String), {
			projectId: seeded.projectId,
			cycleId: seeded.cycleId,
			recipientUserId: seeded.recipientUserId,
			lastAttemptAt: agedTo.toISOString(),
		});
		warn.mockRestore();
	},
);

it.skipIf(!RUN_DB)(
	"a fresh failure inside the window re-sends WITHOUT the warning",
	async () => {
		// The negative control for the case above. Without it the age comparison is unpinned in
		// one direction: an implementation that warned on EVERY previousAttemptAt — or that
		// inverted the comparison — passes the loud case and makes the warning meaningless,
		// because the line then fires on the ordinary in-workflow retry that lands seconds later
		// and is fully covered by the provider's idempotency key.
		const seeded = await seedReadyCycleWithRecipient();
		vi.mocked(sendEmail).mockResolvedValueOnce(false);
		await deliverPublishingTopicsReadyEmail({ ...args(seeded) });

		// No mockClear() needed here: the afterEach above restores console.warn unconditionally
		// after every case — including a failed one — so vi.spyOn always hands back a fresh spy
		// with empty history. Isolation no longer depends on the case above reaching its own
		// mockRestore() on its last line.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.mocked(sendEmail).mockResolvedValueOnce(true);

		const outcome = await deliverPublishingTopicsReadyEmail({
			...args(seeded),
		});

		expect(outcome).toBe("SENT");
		expect(warn).not.toHaveBeenCalledWith(
			expect.stringContaining("past the provider dedupe window"),
			expect.anything(),
		);
		warn.mockRestore();
	},
);

it.skipIf(!RUN_DB)("a held claim does not send", async () => {
	const seeded = await seedReadyCycleWithRecipient();
	await claimPublishingEmailDelivery({
		cycleId: seeded.cycleId,
		tenant: seeded.tenant,
		recipientUserId: seeded.recipientUserId,
	});
	vi.mocked(sendEmail).mockClear();

	const outcome = await deliverPublishingTopicsReadyEmail({
		cycleId: seeded.cycleId,
		tenant: seeded.tenant,
		recipientUserId: seeded.recipientUserId,
		recipientEmail: "dev@example.com",
		projectName: "Example project",
		topicCount: 1,
		url: "https://example.com/app/projects/p1/publishing",
	});

	// The fence's whole purpose, asserted at the level that matters: not "the claim was
	// refused" but "no message was handed to the provider".
	expect(outcome).toBe("HELD");
	expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
});

it.skipIf(!RUN_DB)("a terminal cycle does not send", async () => {
	const seeded = await seedReadyCycleWithRecipient();
	await db.publishingSuggestionCycle.update({
		where: { id: seeded.cycleId },
		data: { notificationOutcome: "DISABLED" },
	});
	vi.mocked(sendEmail).mockClear();

	const outcome = await deliverPublishingTopicsReadyEmail({
		cycleId: seeded.cycleId,
		tenant: seeded.tenant,
		recipientUserId: seeded.recipientUserId,
		recipientEmail: "dev@example.com",
		projectName: "Example project",
		topicCount: 1,
		url: "https://example.com/app/projects/p1/publishing",
	});

	expect(outcome).toBe("ALREADY_TERMINAL");
	expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
});

it.skipIf(!RUN_DB)(
	"a lost confirmation reports ALREADY_TERMINAL rather than SENT",
	async () => {
		// The confirmation's LOST branch, and the only case that reaches it. Cancelling the row
		// mid-flight releases its claimToken, so the confirming write's token predicate matches
		// nothing when the send returns. Reporting SENT here would assert a delivery on a row this
		// attempt no longer owns — and the ledger must never carry a delivery this design does not
		// stand behind.
		const seeded = await seedReadyCycleWithRecipient();
		vi.mocked(sendEmail).mockImplementationOnce(async () => {
			await db.publishingNotificationDelivery.updateMany({
				where: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
				data: {
					status: "SKIPPED",
					reason: "RECIPIENT_UNAUTHORIZED",
					claimedAt: null,
					claimToken: null,
				},
			});
			return true;
		});

		const outcome = await deliverPublishingTopicsReadyEmail({
			...args(seeded),
		});

		expect(outcome).toBe("ALREADY_TERMINAL");
		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		// The cancellation stands, and no deliveredAt was stamped over it.
		expect(row.status).toBe("SKIPPED");
		expect(row.deliveredAt).toBeNull();
	},
);

// ---------------------------------------------------------------------------
// The interleavings a sequential test cannot reach.
//
// Everything above drives ONE attempt at a time, and the whole design — a lease, a conditional
// update, a provider call that cannot join a transaction — is about what happens when two overlap.
//
// "A held claim does not send" above is already real coverage of ONE such defect: its seeded claim
// leaves deliveredAt null, so a version whose claim proceeds on "deliveredAt IS NULL" alone — never
// consulting the lease at all — would send there, and its `expect(sendEmail).not.toHaveBeenCalled()`
// would fail. Nothing below repeats that.
//
// What a sequential test genuinely cannot reach is narrower than "concurrency" in general, and worth
// naming precisely rather than gesturing at. Whether a claim is written as a bare SELECT-then-UPDATE
// or as the one conditional UPDATE this module uses is NOT a distinction the cases below can force
// either: `creationFenceVerdict`'s project-row `FOR UPDATE` is every claim transaction's FIRST
// statement, so two claims for the same project are always serialized on it — a second attempt's
// delivery-row read cannot happen until the first attempt's transaction has committed.
// `claimPublishingEmailDelivery`'s own comment on its `count === 0` branch says exactly this: that
// ambiguity is "unreachable today" for the same reason. A SELECT-then-UPDATE run inside that same
// locked transaction is exactly as safe as the conditional UPDATE, because nothing can interleave
// between the two statements regardless of which shape the claim takes.
//
// What the cases below DO reach is the window a locked transaction cannot cover at all: the claiming
// transaction COMMITS — releasing the project lock — before the provider is ever called, so for the
// whole span the winning message is genuinely in flight with `sendEmail`, the only thing standing
// between it and a second send is the LEASE it left committed on the row (`status`, `claimedAt`), not
// any lock. A version that claims atomically but does not hold that lease live for the duration of
// the send — one whose conditional update re-checks only `deliveredAt`, say — passes every case above
// and fails here: the losing attempt's own claim would succeed too, and the observable harm is a
// genuine SECOND CALL TO THE PROVIDER, not merely an outcome reported under the wrong label.
// ---------------------------------------------------------------------------

/**
 * Wait for `signal`, but never longer than `ms`. Answers whether it arrived.
 *
 * The barrier below deliberately holds a transaction open until another attempt reaches a chosen
 * point, so a staging that never gets there would hang until vitest's own timeout and report
 * "timed out" — which says nothing about WHICH half failed to arrive. Bounding the wait turns that
 * into a recorded tape entry and a failed assertion naming the missing step.
 */
async function reachedWithin(signal: Promise<void>, ms: number) {
	let timer: NodeJS.Timeout | undefined;
	const arrived = await Promise.race([
		signal.then(() => true),
		new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), ms);
		}),
	]);
	if (timer) {
		clearTimeout(timer);
	}
	return arrived;
}

/** The claim transaction's FIRST statement — F1's `FOR UPDATE` re-read of the project row. */
function isProjectLockStatement(args: unknown): boolean {
	const sql =
		(args as { strings?: string[] } | null)?.strings?.join("?") ?? "";
	return sql.includes('FROM "project"') && sql.includes("FOR UPDATE");
}

type OverlapBarrier = {
	observer: PrismaQueryObserver;
	/** The ordered record of what actually happened. This IS the evidence. */
	tape: string[];
	/** Resolves once the FIRST attempt HOLDS the project row lock, inside its open transaction. */
	firstHoldsLock: Promise<void>;
	/** Resolves once the SECOND attempt has read the delivery row under its own lock. */
	secondAttemptRead: Promise<void>;
	/**
	 * Resolves once the SECOND attempt's whole call has SETTLED — its verdict included, not merely
	 * its row read. Holding the winner open until this point is what makes the loser's verdict a
	 * property of the staging rather than of the machine; see the call site for why the row read is
	 * the wrong anchor.
	 */
	secondAttemptSettled: Promise<void>;
	/** Called by `runOverlapping` the instant the second attempt settles, either way. */
	markSecondAttemptSettled: () => void;
	/** What that read returned — a row shape that can only exist mid-overlap. */
	secondAttemptSaw: () => {
		status?: string;
		deliveredAt?: Date | null;
	} | null;
};

/**
 * Does `earlier` appear before `later` on the tape? Both must be present.
 *
 * The tape is asserted as a SET plus these pairwise relations rather than as one literal array, and
 * the distinction is the difference between a test and a flake. Two of the transitions here are
 * genuinely unordered — whether the winning attempt reaches the provider before or after the losing
 * attempt is granted the released lock is a JS-microtask-versus-network-round-trip race that carries
 * no meaning — and the first version of these cases asserted a total order, passed once, and failed
 * on the next run with the two swapped. Pinning only the orderings the DESIGN forces is what makes
 * the evidence reproducible; pinning the rest would be recording an accident.
 */
function precedes(tape: string[], earlier: string, later: string) {
	const first = tape.indexOf(earlier);
	const second = tape.indexOf(later);
	expect(first, `missing tape entry: ${earlier}`).toBeGreaterThanOrEqual(0);
	expect(second, `missing tape entry: ${later}`).toBeGreaterThanOrEqual(0);
	expect(
		first,
		`expected "${earlier}" to precede "${later}" — tape was ${JSON.stringify(tape)}`,
	).toBeLessThan(second);
}

/**
 * Force two claim transactions to genuinely overlap, on the project row lock.
 *
 * `Promise.all([claim(), claim()])` alone is not evidence. Both calls start, but nothing stops the
 * first from committing before the second issues its `BEGIN` — in which case the second is refused
 * by a COMMITTED row it simply read, which is the sequential case the file already covers. The
 * distinction matters because those two worlds refuse the second attempt through DIFFERENT
 * predicates, and only one of them is the fence.
 *
 * So the first attempt is held INSIDE its transaction, immediately after taking the project row
 * `FOR UPDATE`, until the second attempt has issued its own lock request. From that instant the
 * overlap is a fact rather than a hope: the second attempt's statement was sent while the first
 * still held the lock, so it cannot return until the first COMMITS. Postgres does the blocking; the
 * barrier only decides when to let go.
 *
 * `firstHoldsLock` is why the caller starts the two attempts in sequence rather than handing two
 * already-created promises to `Promise.all`. Dispatching both at once leaves WHICH ONE acquires the
 * lock up to I/O scheduling — observed live: the second attempt's statement reached this observer
 * before the first attempt's had returned — so the labels would name entry order while the
 * assertions talked about acquisition order, and the two are not the same thing. Waiting for the
 * first to actually HOLD the lock before the second is created makes the acquisition order a fact
 * of the staging. The attempts still overlap: the first is mid-transaction throughout the second's
 * entire life.
 */
function overlappingClaimBarrier(): OverlapBarrier {
	const tape: string[] = [];
	let locks = 0;
	let rowReads = 0;
	let firstHolds: () => void = () => {};
	const firstHoldsLock = new Promise<void>((resolve) => {
		firstHolds = resolve;
	});
	let secondLockRequested: () => void = () => {};
	const secondLockRequestedSignal = new Promise<void>((resolve) => {
		secondLockRequested = resolve;
	});
	let secondRead: () => void = () => {};
	const secondAttemptRead = new Promise<void>((resolve) => {
		secondRead = resolve;
	});
	let secondSettled: () => void = () => {};
	const secondAttemptSettled = new Promise<void>((resolve) => {
		secondSettled = resolve;
	});
	let saw: { status?: string; deliveredAt?: Date | null } | null = null;

	const observer: PrismaQueryObserver = async ({
		model,
		operation,
		args,
		query,
	}) => {
		if (operation === "$queryRaw" && isProjectLockStatement(args)) {
			locks += 1;
			if (locks === 1) {
				const result = await query(args);
				tape.push("attempt-1:holds-the-project-lock");
				firstHolds();
				// The transaction stays OPEN across this await, which is the whole mechanism:
				// the lock is held until the callback returns and Prisma commits. The bound has to
				// stay UNDER Prisma's default interactive-transaction timeout — 5 s, measured from
				// BEGIN, since no `transactionOptions` is configured on this client (see
				// packages/database/prisma/client.ts) — or Prisma aborts the open transaction with
				// P2028 at or before the 5 s mark, the claim's own catch swallows that into
				// `{ outcome: "FAILED" }`, and the case fails at the sendEmail count with no tape
				// entry naming the step that never arrived.
				const arrived = await reachedWithin(
					secondLockRequestedSignal,
					2_500,
				);
				tape.push(
					arrived
						? "attempt-1:resumes"
						: "attempt-1:resumes-unmet (STAGING FAILED)",
				);
				return result;
			}
			if (locks === 2) {
				// Recorded BEFORE the statement is issued and before the first attempt is
				// released, so the tape entry cannot be read as "it asked once the lock was
				// already free".
				tape.push("attempt-2:requests-the-project-lock");
				secondLockRequested();
				const result = await query(args);
				// Reached only after the first attempt's transaction committed.
				tape.push("attempt-2:holds-the-project-lock");
				return result;
			}
			return query(args);
		}
		if (
			model === "PublishingNotificationDelivery" &&
			operation === "findUnique"
		) {
			rowReads += 1;
			const mine = rowReads;
			const result = await query(args);
			if (mine === 2) {
				saw = result as {
					status?: string;
					deliveredAt?: Date | null;
				} | null;
				tape.push("attempt-2:reads-the-row");
				secondRead();
			}
			return result;
		}
		return query(args);
	};

	return {
		observer,
		tape,
		firstHoldsLock,
		secondAttemptRead,
		secondAttemptSettled,
		markSecondAttemptSettled: () => secondSettled(),
		secondAttemptSaw: () => saw,
	};
}

/**
 * Start two attempts that PROVABLY overlap, and hand back both results.
 *
 * The second is created only once the first holds the project row lock, so "they overlapped" is a
 * property of the staging rather than of the machine the suite happens to run on.
 */
async function runOverlapping<T>(
	barrier: OverlapBarrier,
	attempt: () => Promise<T>,
): Promise<[T, T]> {
	return withQueryObserver(barrier.observer, async () => {
		const first = attempt();
		// Bounded under Prisma's default 5 s interactive-transaction timeout for the same reason as
		// the observer's own wait above: the first attempt's transaction is already open while this
		// resolves.
		const started = await reachedWithin(barrier.firstHoldsLock, 2_500);
		// A positive control on the staging itself. Without it, a first attempt that failed before
		// reaching its claim would leave the two running one after the other and every assertion
		// below would be about a sequential pair wearing a concurrency test's name.
		expect(started, "the first attempt never took the project lock").toBe(
			true,
		);
		const second = attempt();
		// Settled, not resolved: a rejected second attempt must still release whatever is waiting on
		// it, or a failure inside it is reported as the winner's timeout five seconds later instead of
		// as itself. `Promise.all` below still surfaces the rejection.
		void second.then(
			() => barrier.markSecondAttemptSettled(),
			() => barrier.markSecondAttemptSettled(),
		);
		return Promise.all([first, second]);
	});
}

it.skipIf(!RUN_DB)(
	"1C-2c: two concurrent deliveries send exactly one message",
	async () => {
		const seeded = await seedReadyCycleWithRecipient();
		const barrier = overlappingClaimBarrier();
		vi.mocked(sendEmail).mockClear();
		// The provider call is held open until the LOSING attempt has SETTLED, so the losing attempt
		// necessarily evaluates a live claim rather than a completed delivery. Without this the two
		// are in a genuine race — the winner's confirmation and the loser's refusal land within a
		// round trip of each other — and the loser would sometimes be refused by `deliveredAt`
		// instead. Both refusals produce one email, so the count assertion would pass either way;
		// what would quietly stop being exercised is the LEASE, which is the only one of the two a
		// pre-fence implementation lacks.
		//
		// SETTLED, not "has read the row", and the difference is the whole staging. The claim does
		// not decide from that read: it asks its one claimability question in a conditional UPDATE,
		// and when that refuses it re-asks the same question in a second statement to tell HELD from
		// ALREADY_TERMINAL. Both run AFTER the read. Meanwhile `confirmPublishingEmailDelivery`
		// takes no project lock — it is a bare `updateMany` — so releasing the winner at the loser's
		// read lets the confirming write land between that read and the two statements that actually
		// decide, and the verdict becomes whichever won the gap. That is not hypothetical: this case
		// asserted HELD, passed here, and produced ALREADY_TERMINAL on CI; a 300 ms delay inserted at
		// the old release point reproduces the CI failure verbatim, every run. Anchoring the release
		// to the loser's own completion puts the verdict back inside the barrier, and strengthens
		// every ordering below rather than weakening one: the loser's ENTIRE claim is now evaluated
		// while the winner's message is still with the provider.
		vi.mocked(sendEmail).mockImplementation(async () => {
			barrier.tape.push("attempt-1:hands-the-message-to-the-provider");
			const arrived = await reachedWithin(
				barrier.secondAttemptSettled,
				5_000,
			);
			barrier.tape.push(
				arrived
					? "attempt-1:provider-call-returns"
					: "attempt-1:provider-call-returns-unmet (STAGING FAILED)",
			);
			return true;
		});

		const outcomes = await runOverlapping(barrier, () =>
			deliverPublishingTopicsReadyEmail({ ...args(seeded) }),
		);

		// The assertion that distinguishes a fence from an observation. A sequential
		// timeout-then-retry test passes under the unfenced "deliveredAt is null, so re-send"
		// rule — it is the case fencing does not fix, and therefore not evidence.
		expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);
		expect([...outcomes].sort()).toEqual(["HELD", "SENT"]);

		// EVIDENCE THE INTERLEAVING HAPPENED, and not a claim that it did. Every step is recorded
		// from inside the run. The events are exact — no step missing, none injected twice — and
		// the orderings the design FORCES are pinned one by one below. One pair is pinned on a
		// different basis — a structural margin rather than a guarantee — and is labelled as such at
		// its own call site rather than left to be read as identical to the rest.
		expect([...barrier.tape].sort()).toEqual(
			[
				"attempt-1:holds-the-project-lock",
				"attempt-2:requests-the-project-lock",
				"attempt-1:resumes",
				"attempt-2:holds-the-project-lock",
				"attempt-1:hands-the-message-to-the-provider",
				"attempt-2:reads-the-row",
				"attempt-1:provider-call-returns",
			].sort(),
		);
		// The second attempt asked for a lock the first was still holding …
		precedes(
			barrier.tape,
			"attempt-1:holds-the-project-lock",
			"attempt-2:requests-the-project-lock",
		);
		// … the first was released only afterwards …
		precedes(
			barrier.tape,
			"attempt-2:requests-the-project-lock",
			"attempt-1:resumes",
		);
		// … and the second was granted the lock only once the first had COMMITTED. Postgres
		// enforces that, which is what makes this line evidence rather than decoration: a run in
		// which the two did not overlap cannot produce it.
		precedes(
			barrier.tape,
			"attempt-1:resumes",
			"attempt-2:holds-the-project-lock",
		);
		// The losing attempt read the row while the winning attempt's message was still with the
		// provider — the ambiguous window the whole lease exists for.
		//
		// MARGIN-based, not design-forced like its three siblings above. Nothing in Postgres or the
		// barrier stops attempt 2 from reading the row before attempt 1 reaches the provider; this
		// holds because, from the shared instant attempt 1's commit is acknowledged — the same
		// instant that releases the lock attempt 2 is blocked on — attempt 1 needs ZERO further
		// round trips to call `sendEmail` (the dedupe-window check above reads an already-fetched
		// value synchronously), while attempt 2 still needs two: the cycle-ownership read inside
		// `creationFenceVerdict`, then the delivery-row read itself. That is a large structural
		// margin, not a JS-microtask-versus-network-round-trip coin flip — but it is a margin, and it
		// is named as one rather than left to look identical to a guarantee.
		precedes(
			barrier.tape,
			"attempt-1:hands-the-message-to-the-provider",
			"attempt-2:reads-the-row",
		);
		precedes(
			barrier.tape,
			"attempt-2:reads-the-row",
			"attempt-1:provider-call-returns",
		);
		// The value that could only exist in the interleaved world: the losing attempt's own read
		// returned a LIVE, UNDELIVERED row. It was refused while `deliveredAt` was still null, which
		// is precisely the state an unfenced "re-send if not delivered" rule would have sent into.
		expect(barrier.secondAttemptSaw()).toMatchObject({
			status: "SENDING",
			deliveredAt: null,
		});

		// One obligation, one delivery. A second row would mean the triple stopped being the
		// identity of an obligation.
		const rows = await db.publishingNotificationDelivery.findMany({
			where: { cycleId: seeded.cycleId, channel: "EMAIL" },
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("SENT");
		expect(rows[0]?.deliveredAt).not.toBeNull();
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: the claim returns the attempt age it saw under its own lock",
	async () => {
		// The property that a pre-claim read cannot have. An attempt that timed out KEEPS RUNNING,
		// so a snapshot taken before claiming has no bound on its age: it can read null, stall
		// while a retry claims/sends/fails/releases, then resume a day later, take the free row,
		// and send while evaluating its own stale null — no warning, in exactly the interleaving
		// the timestamp exists to surface.
		const seeded = await seedReadyCycleWithRecipient();
		const aged = new Date(
			Date.now() - PUBLISHING_EMAIL_PROVIDER_DEDUPE_WINDOW_MS - 60_000,
		);
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: seeded.cycleId,
				projectId: seeded.projectId,
				organizationId: seeded.organizationId,
				userId: null,
				recipientUserId: seeded.recipientUserId,
				channel: "EMAIL",
				status: "FAILED",
				reason: "PROVIDER_REJECTED",
				// Non-null on purpose: the claim's own update sets both `reason` and `errorMessage`
				// to null, and a seed that left this column null already would make the assertion
				// below hold whether or not the claim actually cleared it.
				errorMessage: "socket hang up",
				lastAttemptAt: aged,
			},
		});

		// Concurrent, so the winner's answer cannot have been read before the row settled.
		const barrier = overlappingClaimBarrier();
		const [a, b] = await runOverlapping(barrier, () =>
			claimPublishingEmailDelivery({
				cycleId: seeded.cycleId,
				tenant: seeded.tenant,
				recipientUserId: seeded.recipientUserId,
			}),
		);
		const won = [a, b].filter((r) => r.outcome === "CLAIMED");
		expect(won).toHaveLength(1);
		const winner = won[0];
		if (winner === undefined || winner.outcome !== "CLAIMED") {
			throw new Error("unreachable");
		}
		// The value from BEFORE the overwrite, not null and not `now`.
		expect(winner.previousAttemptAt?.getTime()).toBe(aged.getTime());

		// And the column really was advanced, so the next claim sees a fresh attempt.
		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		expect(row.lastAttemptAt?.getTime()).toBeGreaterThan(aged.getTime());
		// The claim also CLEARS the previous attempt's classification, and nothing else read that
		// back: `confirmPublishingEmailDelivery` nulls both columns again on the way to SENT, so
		// every other case in this file is green whether the claim clears them or not. The seeded
		// row arrives carrying PROVIDER_REJECTED and a non-null errorMessage, so this is the one
		// place the clearing of BOTH columns is visible — a seed that left errorMessage null would
		// make that half of the assertion hold whether or not the claim actually cleared it.
		// A SENDING row still advertising the PREVIOUS attempt's failure is what 1C-2d would group
		// on.
		expect(row.reason).toBeNull();
		expect(row.errorMessage).toBeNull();

		// EVIDENCE, as above: the loser's lock request was issued while the winner held the lock,
		// so the winner's `previousAttemptAt` was read and overwritten inside a window the loser was
		// already waiting on. That is what makes it "under its own lock" rather than "before anyone
		// else got there".
		expect([...barrier.tape].sort()).toEqual(
			[
				"attempt-1:holds-the-project-lock",
				"attempt-2:requests-the-project-lock",
				"attempt-1:resumes",
				"attempt-2:holds-the-project-lock",
				"attempt-2:reads-the-row",
			].sort(),
		);
		precedes(
			barrier.tape,
			"attempt-1:holds-the-project-lock",
			"attempt-2:requests-the-project-lock",
		);
		precedes(
			barrier.tape,
			"attempt-2:requests-the-project-lock",
			"attempt-1:resumes",
		);
		precedes(
			barrier.tape,
			"attempt-1:resumes",
			"attempt-2:holds-the-project-lock",
		);
		precedes(
			barrier.tape,
			"attempt-2:holds-the-project-lock",
			"attempt-2:reads-the-row",
		);
		// The loser saw the row the winner had just claimed — SENDING, undelivered — and still took
		// nothing. The lease, not the delivery, is what refused it.
		expect(barrier.secondAttemptSaw()).toMatchObject({
			status: "SENDING",
			deliveredAt: null,
		});
		expect([a, b].filter((r) => r.outcome === "HELD")).toHaveLength(1);
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: an organization-context retry does not duplicate",
	async () => {
		// The dedupe triple must hold for an ORG project, not only a personal one. In org context
		// the tenant userId is NULL and PostgreSQL permits unlimited duplicate NULLs in a unique
		// index — a triple keyed on it would have silently disabled retry dedupe for exactly the
		// org projects, with no error anywhere.
		//
		// SEQUENTIAL, and deliberately so: this is not an interleaving case and does not claim to
		// be one. What it pins is the IDENTITY of an obligation under a null tenant column, which is
		// a property of the unique index rather than of the fence — and which the concurrent cases
		// above would not isolate, since they would fail for either reason at once.
		//
		// Honestly labelled, this is a FORWARD-LOOKING GUARD rather than a pin against today's code.
		// A single-predicate deletion — either `claimPublishingEmailDelivery`'s early
		// `existing.deliveredAt !== null` check or its claim update's own `deliveredAt: null`
		// predicate — leaves this case green, because the other one alone already refuses the second
		// call here. Removing BOTH would still not redden it: the same update's `claimedAt` / lease
		// predicate independently refuses a same-process resend taken seconds apart, well inside the
		// five-minute lease, so this case never exercises that combination either. What it guards
		// against — a future dedupe key that folded `userId` into the unique triple — is in any case
		// largely pre-empted by the compiler: such a change renames the
		// `cycleId_recipientUserId_channel` compound key and fails to build before this test would
		// ever run. Kept anyway because the brief asks for it, and because "the row's tenant column
		// really is null" is worth stating once for a human reading the ledger.
		const seeded = await seedReadyCycleWithRecipient(); // organization project
		expect(seeded.tenant.userId).toBeNull(); // the null the case is about
		vi.mocked(sendEmail).mockClear();
		vi.mocked(sendEmail).mockResolvedValue(true);

		await deliverPublishingTopicsReadyEmail({ ...args(seeded) });
		await deliverPublishingTopicsReadyEmail({ ...args(seeded) });

		expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1);
		const rows = await db.publishingNotificationDelivery.findMany({
			where: { cycleId: seeded.cycleId, channel: "EMAIL" },
		});
		expect(rows).toHaveLength(1);
		// The row carries the null tenant column the case is named for, so a future dedupe key that
		// folded `userId` in would be keying on this value.
		expect(rows[0]?.userId).toBeNull();
		expect(rows[0]?.status).toBe("SENT");
	},
);

it.skipIf(!RUN_DB)(
	"1C-2c: a cancellation committed mid-claim survives, and is reported TERMINAL rather than held",
	async () => {
		// The SKIPPED-excluding status allow-list on the claim's take-over update, and the ONLY
		// window in which it does any work.
		//
		// A cancellation that lands BEFORE the claim is caught by the claim's own predicate on a
		// row it reads as already cancelled — so a sequential test leaves the interleaving
		// untouched. What makes this window reachable is stated in the module's own comment:
		// `terminalizeExistingDeliveriesAsSkipped` runs on the BASE CLIENT and takes no project
		// lock, so it is the one writer that can commit between this transaction's `findUnique` and
		// its conditional UPDATE while that transaction holds the lock everything else waits on.
		//
		// Without the allow-list the update matches (a SKIPPED row still carries a null
		// `deliveredAt`), the cancellation is overwritten with SENDING, and the message goes to
		// someone the code had already decided it must not mail. There is no error and no second
		// row — the ledger simply stops recording the decision it made.
		//
		// 1C-2d-2a CHANGED THE VERDICT THIS RETURNS, from HELD to ALREADY_TERMINAL, and the change
		// is the point rather than an incidental. HELD means "still owed"; a cancelled obligation is
		// not owed by anyone, and the refusal classifier now says so. The shipped code answered HELD
		// here — an under-claim its own comment acknowledged and deferred to 1C-2d.
		//
		// WHICH ALSO COST THIS CASE ITS OLD POSITIVE CONTROL, and the replacement is the reason the
		// staging below changed shape. The old control inferred the interleaving from the verdict:
		// HELD could only arise if the read saw a claimable row and the write did not. With the
		// early terminal branch deleted, the sequential world and the interleaved world now return
		// the SAME verdict and leave the SAME row, so no assertion on either can tell them apart.
		// `readSawStatus` below replaces the inference with the fact — the status the claim's own
		// existence read observed — which is strictly stronger and survives further sharpening.
		//
		// The caller-visible consequence of a cancelled row — that it is NOT counted as unconfirmed,
		// so the activity completes instead of rejecting until its retry budget is gone — is a
		// property of the ACTIVITY's accounting, not of this verdict: the unconfirmed set is derived
		// from a fresh readPublishingDeliveryStates classified by status, and this function's return
		// value is consulted only for TENANT_CHANGED. It is pinned by six cases in
		// publishing-notify-activity.test.ts, among them "a pre-existing SKIPPED row is confirmed,
		// not outstanding, so the activity completes".
		const seeded = await seedReadyCycleWithRecipient();
		await db.publishingNotificationDelivery.create({
			data: {
				cycleId: seeded.cycleId,
				projectId: seeded.projectId,
				organizationId: seeded.organizationId,
				userId: null,
				recipientUserId: seeded.recipientUserId,
				channel: "EMAIL",
				// FAILED rather than absent, so the claim takes the UPDATE path where the predicate
				// lives. With no row it would take the create path and meet the unique index
				// instead, which is a different fence answering a different question.
				status: "FAILED",
				reason: "PROVIDER_REJECTED",
				lastAttemptAt: new Date(),
			},
		});
		vi.mocked(sendEmail).mockClear();
		vi.mocked(sendEmail).mockResolvedValue(true);

		let injected = false;
		let readSawStatus: string | null = null;
		const outcome = await withQueryObserver(
			async ({ model, operation, args, query }) => {
				if (
					!injected &&
					model === "PublishingNotificationDelivery" &&
					operation === "findUnique"
				) {
					injected = true;
					// AFTER the read resolves and BEFORE the update is issued. The claim has seen a
					// live, claimable row; by the time it writes, that row is cancelled.
					const result = await query(args);
					// WHAT THE CLAIM'S OWN EXISTENCE READ SAW, captured from the very value being
					// returned to it. This is the positive control, and it states the ordering
					// instead of inferring it: FAILED here means the read observed a claimable row,
					// and since the cancellation below is AWAITED before that value is handed back,
					// the write that follows can only have run against a cancelled row.
					readSawStatus =
						(result as { status?: string } | null)?.status ?? null;
					await terminalizeExistingDeliveriesAsSkipped({
						cycleId: seeded.cycleId,
						tenant: seeded.tenant,
						channel: "EMAIL",
						reason: "RECIPIENT_UNAUTHORIZED",
					});
					return result;
				}
				return query(args);
			},
			() => deliverPublishingTopicsReadyEmail({ ...args(seeded) }),
		);

		// Confirms the injection branch fired at all — the claim's own findUnique ran and this
		// observer matched it — so the case is not silently skipping the whole staging.
		expect(injected).toBe(true);
		// THE WINDOW WAS ACTUALLY HIT. Seeded FAILED, read back FAILED, cancelled immediately
		// after: the read saw a claimable row. Cancel-then-claim would read SKIPPED here and this
		// assertion would go red, which is exactly the discrimination the old `toBe("HELD")`
		// provided until the verdicts converged.
		expect(readSawStatus).toBe("FAILED");
		// AND THE WRITE DID NOT TAKE IT. Terminal, not held: this row is not owed, and a caller
		// that acts on the verdict must stop rather than keep it counted as unconfirmed.
		expect(outcome).toBe("ALREADY_TERMINAL");
		// The only assertion that matters to a recipient.
		expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();

		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: seeded.cycleId,
					recipientUserId: seeded.recipientUserId,
					channel: "EMAIL",
				},
			},
		});
		// The cancellation SURVIVED the claim, reason and all. A row flipped back to SENDING here
		// would be the ledger forgetting a decision it had already committed. Together with `outcome`
		// above, this is the half of the positive control that reads from the database rather than
		// from the staging's own bookkeeping.
		expect(row.status).toBe("SKIPPED");
		expect(row.reason).toBe("RECIPIENT_UNAUTHORIZED");
		expect(row.deliveredAt).toBeNull();
		// No lease was taken over the cancellation either.
		expect(row.claimToken).toBeNull();
		expect(row.claimedAt).toBeNull();
	},
);

/**
 * The re-drive script, run as a REAL CHILD PROCESS rather than imported.
 *
 * Importing it is not an option and the reason is structural, not stylistic: the script calls
 * `main()` at module scope and exits through `process.exit`, so an import would run a re-drive as a
 * side effect of loading it and would take the test runner down with it. A child process is also
 * the only way to exercise the thing under test — the guard reads `process.env.RESEND_API_KEY`
 * through `isMailConfigured()`, and THIS file mocks `@repo/mail` module-wide, so an in-process run
 * would consult the mock and never see the environment at all.
 *
 * `tsx` is invoked by its CLI entry rather than by name so the spawn does not depend on a `.bin`
 * shim being on PATH or on shell resolution differing between Windows and the CI runner.
 */
const REDRIVE_SCRIPT = fileURLToPath(
	new URL("../scripts/redrive-publishing-notification.ts", import.meta.url),
);
const TSX_CLI = fileURLToPath(
	new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url),
);

function runRedrive(cycleId: string, options: { mailKey: string | null }) {
	if (!existsSync(TSX_CLI)) {
		throw new Error(
			`tsx CLI not found at ${TSX_CLI} — the re-drive cases cannot spawn the script`,
		);
	}
	// Inherit the run's DATABASE_URL / DIRECT_URL — the child talks to the same Postgres this
	// suite seeded — and control ONLY the mail key, which is the single variable between the two
	// cases below.
	const env = { ...process.env } as NodeJS.ProcessEnv;
	if (options.mailKey === null) {
		delete env.RESEND_API_KEY;
	} else {
		env.RESEND_API_KEY = options.mailKey;
	}
	const result = spawnSync(
		process.execPath,
		[TSX_CLI, REDRIVE_SCRIPT, "--cycle-id", cycleId],
		{ env, encoding: "utf8", timeout: 120_000 },
	);
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

/**
 * A re-driveable cycle carrying ONE live email obligation: `PENDING`, and a row a claim is holding
 * under a fresh lease.
 *
 * `PENDING` rather than the column default, because that is the state an operator re-drives from
 * and the state the damage is worth measuring against. The claim is taken through
 * `claimPublishingEmailDelivery` rather than written by hand so the row carries a real token and a
 * real `claimedAt` — a hand-built row could assert survival of fields the claim path never sets.
 *
 * The cycle has NO topics, so `selectRelevantRecipientIds` returns nobody and BOTH candidate sets
 * are empty. That is what keeps the permitted run below off the network: the notification core
 * closes at its no-candidates exit without ever reaching the email loop, so no provider call is
 * made from a child process this file's `@repo/mail` mock cannot reach.
 */
async function seedRedriveableCycleWithLiveEmailClaim() {
	const seeded = await seedReadyCycleWithRecipient();
	await db.publishingSuggestionCycle.update({
		where: { id: seeded.cycleId },
		data: { notificationOutcome: "PENDING" },
	});
	const claim = await claimPublishingEmailDelivery({
		cycleId: seeded.cycleId,
		tenant: seeded.tenant,
		recipientUserId: seeded.recipientUserId,
	});
	expect(claim.outcome).toBe("CLAIMED");
	return seeded;
}

function readEmailRow(seeded: { cycleId: string; recipientUserId: string }) {
	return db.publishingNotificationDelivery.findUniqueOrThrow({
		where: {
			cycleId_recipientUserId_channel: {
				cycleId: seeded.cycleId,
				recipientUserId: seeded.recipientUserId,
				channel: "EMAIL",
			},
		},
	});
}

function readOutcome(cycleId: string) {
	return db.publishingSuggestionCycle.findUniqueOrThrow({
		where: { id: cycleId },
		select: { notificationOutcome: true },
	});
}

it.skipIf(!RUN_DB)(
	"1C-2c: the re-drive refuses without a mail key, leaving the obligation and the cycle untouched",
	async () => {
		// THE RECOVERY TOOL MUST NOT DISCHARGE WHAT IT WAS RUN TO RECOVER. The script runs as plain
		// `tsx` with no dotenv wrapper, so an operator shell with DATABASE_URL and no
		// RESEND_API_KEY is the ordinary case, not an exotic one. Without the guard that run reaches
		// the notification core, which finds the mail client unusable, drops the email channel, and
		// CLOSES the cycle — terminalizing this very row to SKIPPED/CYCLE_CLOSED and releasing its
		// lease under an attempt that may be mid-provider-call, then writing an outcome that puts
		// the cycle outside this script's own re-driveable set forever.
		//
		// The dedupe-horizon guard does not cover it: this row was claimed seconds ago, so its
		// `lastAttemptAt` is far inside the 24-hour window.
		const seeded = await seedRedriveableCycleWithLiveEmailClaim();
		const before = await readEmailRow(seeded);

		const run = runRedrive(seeded.cycleId, { mailKey: null });

		expect(run.status).toBe(1);
		expect(run.stderr).toContain("RESEND_API_KEY");
		// The refusal happens BEFORE the core is called. The script prints this line immediately
		// before handing over, so its absence is what pins the placement rather than merely the
		// verdict.
		expect(run.stdout).not.toContain("re-driving");

		const after = await readEmailRow(seeded);
		// Untouched, field by field: the obligation is still owed, and still LEASED by the attempt
		// that took it. A guard that refused after the close would satisfy the exit code above and
		// fail here.
		expect(after.status).toBe("SENDING");
		expect(after.reason).toBeNull();
		expect(after.deliveredAt).toBeNull();
		expect(after.claimToken).toBe(before.claimToken);
		expect(after.claimedAt).toEqual(before.claimedAt);
		expect(after.lastAttemptAt).toEqual(before.lastAttemptAt);
		expect((await readOutcome(seeded.cycleId)).notificationOutcome).toBe(
			"PENDING",
		);
	},
	120_000,
);

it.skipIf(!RUN_DB)(
	"1C-2c: with the mail key present the re-drive proceeds — and the close it was refused for lands",
	async () => {
		// THE GREEN HALF, and the positive control for the case above. Same fixture, same script,
		// one variable changed: RESEND_API_KEY is set. Without this pair the red case would pass
		// against a script that refused every re-drive for any reason at all, and its "untouched"
		// assertions would prove nothing — a row nothing ever writes to is trivially unchanged.
		//
		// So this asserts the damage too. With the guard cleared the core runs, finds no candidates
		// (the fixture seeds no topics), and closes the cycle — which terminalizes exactly the row
		// the red case found intact and releases its lease. That is the write the refusal exists to
		// stand between an operator and, observed rather than argued.
		//
		// The outcome here is NO_RECIPIENTS rather than MAIL_NOT_CONFIGURED because this fixture has
		// an empty email candidate set; the terminalization is the same either way, and it is what
		// this case is measuring. `runPublishingTopicsReadyNotification`'s own MAIL_NOT_CONFIGURED
		// behaviour is pinned in publishing-notify-activity.test.ts, where the mail client can be
		// mocked in-process.
		const seeded = await seedRedriveableCycleWithLiveEmailClaim();

		const run = runRedrive(seeded.cycleId, {
			// Never used: the core closes before the email loop. Any non-empty value satisfies
			// `isMailConfigured`, which only tests for presence.
			mailKey: "placeholder-not-a-real-key",
		});

		expect(run.stderr).not.toContain("RESEND_API_KEY");
		expect(run.stdout).toContain(`re-driving ${seeded.cycleId}`);
		expect(run.status).toBe(0);

		const after = await readEmailRow(seeded);
		expect(after.status).toBe("SKIPPED");
		expect(after.reason).toBe("CYCLE_CLOSED");
		expect(after.deliveredAt).toBeNull();
		// The lease is gone with the obligation — the half that makes this irreversible for the
		// attempt that held it, whose confirm is fenced on a token this row no longer carries.
		expect(after.claimToken).toBeNull();
		expect(after.claimedAt).toBeNull();
		expect((await readOutcome(seeded.cycleId)).notificationOutcome).toBe(
			"NO_RECIPIENTS",
		);
	},
	120_000,
);
