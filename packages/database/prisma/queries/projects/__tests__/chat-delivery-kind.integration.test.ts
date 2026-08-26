/**
 * Real-Postgres proof of what `kind` does to the chat-delivery ledger
 * (Fizzy #2203). The mocked sibling `chat-delivery-kind.test.ts` proves the
 * queries are BUILT right — that `kind` reaches the `where`/`data` passed to
 * Prisma. It cannot prove what a real unique index and a real conditional
 * write do; that is what this suite hits, no mocks, through the production
 * query layer.
 *
 * `newsletter_chat_delivery` now carries ONE unique index:
 * `(sendId, kind, platform, externalTeamId, channelId)`. The narrower
 * `(sendId, platform, externalTeamId, channelId)` index was retained for one
 * release as a rollback fence and dropped in
 * `20260820190000_newsletter_chat_delivery_drop_legacy_fence`. While it stood,
 * a CONTENT row and an APPROVAL row could not share a channel; the second test
 * below is what proves that is over.
 *
 * If the first two tests fail with a duplicate-key error naming
 * `newsletter_chat_delivery_send_channel_key`, the database this ran against
 * predates that migration — apply migrations rather than changing the
 * assertions.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder, mirroring
 * the sibling integration suites.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { db, Prisma } from "../../../client";
import {
	claimChatDelivery,
	listChatDeliveriesForSend,
	markChatDelivery,
} from "../newsletter";

describe.skipIf(!hasReachableDatabaseUrl())(
	"chat delivery ledger partitioning by kind (real Postgres)",
	() => {
		const RUN_ID = `${Date.now()}-${process.pid}`;
		const USER_ID = `test-chat-delivery-kind-user-${RUN_ID}`;
		let sendCounter = 0;

		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Chat Delivery Kind User"}, ${`${USER_ID}@example.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
		});

		afterEach(async () => {
			// Deleting the project cascades its newsletter sends, which cascades
			// the chat-delivery rows (onDelete: Cascade on both FKs).
			await db.project.deleteMany({ where: { userId: USER_ID } });
		});

		async function seedSend() {
			sendCounter += 1;
			const project = await db.project.create({
				data: {
					name: `Chat Delivery Kind Project ${sendCounter}`,
					userId: USER_ID,
				},
			});
			const send = await db.newsletterSend.create({
				data: {
					projectId: project.id,
					organizationId: null,
					userId: null,
					dedupeKey: `chat-kind:${RUN_ID}:${sendCounter}`,
					status: "PENDING",
					trigger: "MANUAL",
					timeWindowStart: new Date(0),
					timeWindowEnd: new Date(1),
				},
			});
			return { projectId: project.id, sendId: send.id };
		}

		function readStatus(sendId: string, channelId: string) {
			return db.newsletterChatDelivery
				.findFirstOrThrow({
					where: { sendId, channelId },
					select: { status: true },
				})
				.then((row) => row.status);
		}

		// The property the whole feature rests on: one channel can hold the
		// review alert AND the published notes for a single send. Until the
		// legacy index was dropped this returned {claimed:false} and the
		// publication was the row that got refused.
		it("a CONTENT and an APPROVAL claim can share one channel on the same send", async () => {
			const { projectId, sendId } = await seedSend();
			const channel = {
				platform: "SLACK" as const,
				externalTeamId: "T-example",
				channelId: "C-example",
			};

			const content = await claimChatDelivery({
				sendId,
				projectId,
				organizationId: null,
				userId: null,
				kind: "CONTENT",
				...channel,
			});
			expect(content).toEqual({ claimed: true });

			const approval = await claimChatDelivery({
				sendId,
				projectId,
				organizationId: null,
				userId: null,
				kind: "APPROVAL",
				...channel,
			});
			expect(approval).toEqual({ claimed: true });

			// Proven by count, not by absence of error: two rows, not one
			// upserted over the other.
			const rows = await db.newsletterChatDelivery.count({
				where: { sendId },
			});
			expect(rows).toBe(2);
		});

		// The negative control for the test above. Without it, a green
		// coexistence claim is equally consistent with "the index was dropped"
		// and "the assertion was weakened", and those look identical in a
		// summary line. This asserts the schema itself.
		it("the legacy index is gone and the widened one is still enforcing", async () => {
			// `pg_indexes.indexname` is Postgres type `name`, which Prisma's
			// `$queryRaw` cannot deserialize ("Failed to deserialize column of
			// type 'name'"). Cast to text — every system-catalog identifier
			// read through $queryRaw needs this, and the `<{...}[]>` type
			// argument is an unchecked assertion that `tsc` will not catch.
			const present = await db.$queryRaw<{ indexname: string }[]>(
				Prisma.sql`SELECT indexname::text FROM pg_indexes
				           WHERE tablename = 'newsletter_chat_delivery'
				             AND indexname IN (
				               'newsletter_chat_delivery_send_channel_key',
				               'newsletter_chat_delivery_send_kind_channel_key'
				             )`,
			);
			const names = present.map((r) => r.indexname);
			expect(names).toContain(
				"newsletter_chat_delivery_send_kind_channel_key",
			);
			expect(names).not.toContain(
				"newsletter_chat_delivery_send_channel_key",
			);

			// Present is not the same as enforcing: a concurrent build that
			// failed leaves an index that exists and serves nothing. Make it
			// refuse something.
			const { projectId, sendId } = await seedSend();
			const claim = (kind: "CONTENT" | "APPROVAL") =>
				claimChatDelivery({
					sendId,
					projectId,
					organizationId: null,
					userId: null,
					kind,
					platform: "SLACK" as const,
					externalTeamId: "T-example",
					channelId: "C-example",
				});
			expect(await claim("CONTENT")).toEqual({ claimed: true });
			expect(await claim("CONTENT")).toEqual({ claimed: false });
		});

		// Pins two facts about THIS stack that the comment in
		// `claimChatDelivery` rests on. Neither can be established by a mocked
		// test, because the error has to come from Postgres rather than from a
		// fixture — a hand-built P2002 once encoded the opposite of both, and
		// nine green tests said nothing about it (Fizzy #2203).
		it("a same-kind re-claim reports the widened constraint, and meta.target is empty", async () => {
			const { projectId, sendId } = await seedSend();
			const row = {
				sendId,
				projectId,
				organizationId: null,
				userId: null,
				kind: "CONTENT" as const,
				status: "SENDING",
				platform: "SLACK" as const,
				externalTeamId: "T-example",
				channelId: "C-example",
			};
			await db.newsletterChatDelivery.create({ data: row });

			// Same kind, same channel: an ORDINARY retry, not a fence collision.
			// Written through the raw client rather than `claimChatDelivery`,
			// which swallows P2002 by design — the error itself is the subject.
			const err = (await db.newsletterChatDelivery
				.create({ data: row })
				.then(() => null)
				.catch((e: unknown) => e)) as {
				code?: string;
				message?: string;
				meta?: Record<string, unknown>;
			} | null;

			expect(err?.code).toBe("P2002");

			// Fact 1: Prisma documents `meta.target` as the constraint's home.
			// On Prisma 6.18 + the Postgres driver adapter it is undefined, so a
			// predicate reading only that can never fire against a real database.
			expect(err?.meta?.target).toBeUndefined();

			// Fact 2: where the constraint IS reported, it now names the
			// widened index — the only unique index left on the table. Measured
			// against real Postgres, not predicted.
			//
			// This does NOT make a constraint-name predicate viable in
			// `claimChatDelivery`. The reason changed but the conclusion did
			// not: before the drop the name was ambiguous (a re-claim satisfied
			// both tuples and Postgres named whichever it checked first); now
			// the name is unambiguous but not reachable through any supported
			// API, because Fact 1 above holds and the driver never populates
			// `meta.target`. Asking the ledger what is there remains the right
			// shape.
			const reported =
				JSON.stringify(err?.meta ?? {}) + (err?.message ?? "");
			expect(reported).toContain(
				"newsletter_chat_delivery_send_kind_channel_key",
			);
		});

		it("a second claim with the same kind and the same channel is still refused", async () => {
			const { projectId, sendId } = await seedSend();
			const channel = {
				platform: "TEAMS" as const,
				externalTeamId: "T-example-2",
				channelId: "C-example-2",
			};

			const first = await claimChatDelivery({
				sendId,
				projectId,
				organizationId: null,
				userId: null,
				kind: "CONTENT",
				...channel,
			});
			expect(first).toEqual({ claimed: true });

			const second = await claimChatDelivery({
				sendId,
				projectId,
				organizationId: null,
				userId: null,
				kind: "CONTENT",
				...channel,
			});
			expect(second).toEqual({ claimed: false });
		});

		// Deliberately ONE row, not two on the same channel, and not two
		// DIFFERENT channels. Two different channels would make this vacuous:
		// the `where`'s channelId alone would already isolate the rows, so
		// removing `kind` from markChatDelivery's `where` would still pass.
		// One row is the shape that discriminates: with `kind` in the `where`,
		// an APPROVAL mark for a tuple that only holds a CONTENT row matches
		// zero rows and the row survives; drop `kind` from the `where` and the
		// same call matches the CONTENT row on
		// (sendId, platform, externalTeamId, channelId) alone and clobbers it
		// — verified by temporarily doing exactly that (see the integration
		// report). This shape was chosen while the legacy fence still made a
		// same-channel pair unrepresentable, and it remains the right shape now
		// that it does not: a second row would weaken the test, not strengthen
		// it.
		it("an approval mark cannot touch a content row for the same channel", async () => {
			const { projectId, sendId } = await seedSend();
			const channel = {
				platform: "SLACK" as const,
				externalTeamId: "T-example",
				channelId: "C-example",
			};

			await claimChatDelivery({
				sendId,
				projectId,
				organizationId: null,
				userId: null,
				kind: "CONTENT",
				...channel,
			});

			await markChatDelivery({
				sendId,
				kind: "APPROVAL",
				...channel,
				status: "FAILED",
				errorMessage: "example failure",
			});

			// Read the row back from the database rather than infer it — this
			// is the assertion the mocked sibling test cannot make.
			expect(await readStatus(sendId, channel.channelId)).toBe("SENDING");
		});

		it("listChatDeliveriesForSend(sendId, kind) excludes the other kind's rows", async () => {
			const { projectId, sendId } = await seedSend();
			await claimChatDelivery({
				sendId,
				projectId,
				organizationId: null,
				userId: null,
				kind: "CONTENT",
				platform: "SLACK",
				externalTeamId: "T-example",
				channelId: "C-content-example",
			});
			await claimChatDelivery({
				sendId,
				projectId,
				organizationId: null,
				userId: null,
				kind: "APPROVAL",
				platform: "SLACK",
				externalTeamId: "T-example",
				channelId: "C-approval-example",
			});

			// Proven by count, not by absence of error: if the kind filter were
			// dropped this would return both rows.
			const contentRows = await listChatDeliveriesForSend(
				sendId,
				"CONTENT",
			);
			expect(contentRows).toHaveLength(1);
			expect(contentRows[0]?.channelId).toBe("C-content-example");

			const approvalRows = await listChatDeliveriesForSend(
				sendId,
				"APPROVAL",
			);
			expect(approvalRows).toHaveLength(1);
			expect(approvalRows[0]?.channelId).toBe("C-approval-example");
		});

		// The state this release CREATES, read back rather than only counted.
		// Test 1 proves the pair can exist; nothing else marked or listed one.
		// Deliberately not using the `readStatus` helper — it is findFirstOrThrow
		// on {sendId, channelId} and cannot address a channel holding two rows.
		it("marking one kind on a shared channel leaves the other kind untouched", async () => {
			const { projectId, sendId } = await seedSend();
			const channel = {
				platform: "SLACK" as const,
				externalTeamId: "T-example",
				channelId: "C-example",
			};
			const claim = (kind: "CONTENT" | "APPROVAL") =>
				claimChatDelivery({
					sendId,
					projectId,
					organizationId: null,
					userId: null,
					kind,
					...channel,
				});
			expect(await claim("CONTENT")).toEqual({ claimed: true });
			expect(await claim("APPROVAL")).toEqual({ claimed: true });

			await markChatDelivery({
				sendId,
				kind: "CONTENT",
				...channel,
				status: "SENT",
			});

			const statusOf = (kind: string) =>
				db.newsletterChatDelivery
					.findFirstOrThrow({
						where: { sendId, channelId: channel.channelId, kind },
						select: { status: true },
					})
					.then((row) => row.status);

			expect(await statusOf("CONTENT")).toBe("SENT");
			// The co-resident row this release made possible must be untouched.
			expect(await statusOf("APPROVAL")).toBe("SENDING");

			// And the per-kind read must see exactly its own row on this channel.
			const approvalRows = await listChatDeliveriesForSend(
				sendId,
				"APPROVAL",
			);
			expect(approvalRows).toHaveLength(1);
			expect(approvalRows[0]?.status).toBe("SENDING");
		});
	},
);
