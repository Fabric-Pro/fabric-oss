import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Mock the prisma client so the helpers can be unit-tested without a DB. ----
// upsertEmbedPendingSubscriber uses the base `db` directly (deleteMany / updateMany /
// create). confirmPublicSubscriberByToken runs inside db.$transaction(cb), receiving a
// tx client exposing newsletterSubscriber.findFirst/updateMany + $queryRaw (FOR UPDATE
// settings lock). The default $transaction impl invokes its callback with `tx`; a
// concurrency test overrides it to serialize on a single-slot mutex.
const subDeleteMany = vi.fn();
const subUpdateMany = vi.fn();
const subCreate = vi.fn();

// tx client handed to the $transaction callback (confirm path).
const txFindFirst = vi.fn();
const txUpdateMany = vi.fn();
const txQueryRaw = vi.fn();
const transactionMock = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
	fn({
		newsletterSubscriber: {
			findFirst: (...a: unknown[]) => txFindFirst(...a),
			updateMany: (...a: unknown[]) => txUpdateMany(...a),
		},
		$queryRaw: (...a: unknown[]) => txQueryRaw(...a),
	}),
);

vi.mock("../../client", () => ({
	db: {
		newsletterSubscriber: {
			deleteMany: (...a: unknown[]) => subDeleteMany(...a),
			updateMany: (...a: unknown[]) => subUpdateMany(...a),
			create: (...a: unknown[]) => subCreate(...a),
		},
		$transaction: (fn: (tx: unknown) => Promise<unknown>) =>
			transactionMock(fn),
	},
}));

import {
	confirmPublicSubscriberByToken,
	upsertEmbedPendingSubscriber,
} from "./newsletter";

// ---- TTL constant under test (mirrors STALE_PENDING_SUBSCRIBER_MS in newsletter.ts). ----
const STALE_PENDING_SUBSCRIBER_MS = 7 * 24 * 60 * 60 * 1000;

const base = {
	projectId: "p1",
	email: "visitor@example.com",
	userId: null as string | null,
	organizationId: "org-9" as string | null,
	createdByUserId: "admin-1",
};

describe("upsertEmbedPendingSubscriber — atomic upsert keyed on (projectId,email)", () => {
	beforeEach(() => {
		subDeleteMany.mockReset().mockResolvedValue({ count: 0 });
		subUpdateMany.mockReset();
		subCreate.mockReset();
	});

	it("step-0 purges UNRELATED stale PENDING rows (project-scoped, age-gated deleteMany)", async () => {
		// No replaceable row, no existing row → create succeeds; we only assert the purge shape.
		subUpdateMany.mockResolvedValue({ count: 0 });
		subCreate.mockResolvedValue({ id: "s-new" });
		const callObservedAt = Date.now();

		await upsertEmbedPendingSubscriber({ ...base, version: 5 });

		expect(subDeleteMany).toHaveBeenCalledTimes(1);
		const where = (
			subDeleteMany.mock.calls[0][0] as {
				where: { createdAt: { lt: Date } } & Record<string, unknown>;
			}
		).where;
		// Mirrors createPendingPublicSubscriber: project-scoped, PENDING-only, age-gated.
		expect(where).toMatchObject({
			projectId: "p1",
			status: "PENDING_CONFIRMATION",
		});
		// Never touches ACTIVE / UNSUBSCRIBED / fresh PENDING; cutoff ≈ now - TTL.
		const cutoffAgeMs = callObservedAt - where.createdAt.lt.getTime();
		expect(cutoffAgeMs).toBeGreaterThan(
			STALE_PENDING_SUBSCRIBER_MS - 60_000,
		);
		expect(cutoffAgeMs).toBeLessThan(STALE_PENDING_SUBSCRIBER_MS + 60_000);
	});

	it("no existing row → create stamped row, sendEmail:true with a fresh token", async () => {
		subUpdateMany.mockResolvedValue({ count: 0 }); // nothing to replace
		subCreate.mockResolvedValue({ id: "s-new" });

		const r = await upsertEmbedPendingSubscriber({ ...base, version: 5 });

		expect(r.sendEmail).toBe(true);
		expect(r.token).toMatch(/^[A-Za-z0-9_-]{30,}$/);
		// The create stamps PENDING_CONFIRMATION at the supplied version + the new token.
		const data = subCreate.mock.calls[0][0].data as Record<string, unknown>;
		expect(data).toMatchObject({
			projectId: "p1",
			email: "visitor@example.com",
			status: "PENDING_CONFIRMATION",
			embedTokenVersion: 5,
			createdByUserId: "admin-1",
			organizationId: "org-9",
			userId: null,
		});
		expect(data.unsubscribeToken).toBe(r.token);
	});

	it("ACTIVE row exists → create throws P2002 → no email, no resurrect", async () => {
		subUpdateMany.mockResolvedValue({ count: 0 }); // an ACTIVE row is not replaceable
		subCreate.mockRejectedValue({ code: "P2002" });

		const r = await upsertEmbedPendingSubscriber({ ...base, version: 5 });
		expect(r).toEqual({ token: null, sendEmail: false });
	});

	it("UNSUBSCRIBED row exists → create throws P2002 → no email (NEVER resurrect)", async () => {
		subUpdateMany.mockResolvedValue({ count: 0 }); // UNSUBSCRIBED is not replaceable
		subCreate.mockRejectedValue({ code: "P2002" });

		const r = await upsertEmbedPendingSubscriber({ ...base, version: 5 });
		expect(r).toEqual({ token: null, sendEmail: false });
		// updateMany must EXCLUDE non-PENDING statuses so it can never flip an
		// UNSUBSCRIBED tombstone back to PENDING.
		const where = subUpdateMany.mock.calls[0][0].where as Record<
			string,
			unknown
		>;
		expect(where.status).toBe("PENDING_CONFIRMATION");
	});

	it("current-version PENDING (fresh) → send-once: updateMany matches 0, create P2002 → no email", async () => {
		// A fresh current-version PENDING row matches neither the version OR-clauses nor
		// the TTL clause → updateMany count 0; the unique row makes create throw P2002.
		subUpdateMany.mockResolvedValue({ count: 0 });
		subCreate.mockRejectedValue({ code: "P2002" });

		const r = await upsertEmbedPendingSubscriber({ ...base, version: 5 });
		expect(r.sendEmail).toBe(false);
		expect(r.token).toBeNull();
		// The replace filter must include the version OR-set so a fresh current-version
		// row is deliberately excluded (send-once), while null/different/stale qualify.
		const where = subUpdateMany.mock.calls[0][0].where as {
			OR: Array<Record<string, unknown>>;
		};
		expect(where.OR).toEqual(
			expect.arrayContaining([
				{ embedTokenVersion: null },
				{ embedTokenVersion: { not: 5 } },
				expect.objectContaining({ createdAt: expect.anything() }),
			]),
		);
	});

	it("different-version PENDING → replace token + re-stamp version, sendEmail:true", async () => {
		subUpdateMany.mockResolvedValue({ count: 1 }); // the stale-version row matched
		const r = await upsertEmbedPendingSubscriber({ ...base, version: 7 });

		expect(r.sendEmail).toBe(true);
		expect(r.token).toMatch(/^[A-Za-z0-9_-]{30,}$/);
		// Replacement re-stamps the new token + version and refreshes createdAt (TTL reset).
		const data = subUpdateMany.mock.calls[0][0].data as Record<
			string,
			unknown
		>;
		expect(data.unsubscribeToken).toBe(r.token);
		expect(data.embedTokenVersion).toBe(7);
		expect(data.createdAt).toBeInstanceOf(Date);
		// create is NOT attempted when a row was replaced.
		expect(subCreate).not.toHaveBeenCalled();
	});

	it("null-version PENDING (legacy/marketing) → replaced (re-stamped), sendEmail:true", async () => {
		subUpdateMany.mockResolvedValue({ count: 1 });
		const r = await upsertEmbedPendingSubscriber({ ...base, version: 5 });
		expect(r.sendEmail).toBe(true);
		expect(r.token).not.toBeNull();
	});

	it("stale current-version PENDING (older than TTL) → reclaimed via updateMany, sendEmail:true", async () => {
		// Even at the CURRENT version, an older-than-TTL PENDING row matches the
		// createdAt-cutoff OR-clause and is re-stamped (link refreshed).
		subUpdateMany.mockResolvedValue({ count: 1 });
		const r = await upsertEmbedPendingSubscriber({ ...base, version: 5 });
		expect(r.sendEmail).toBe(true);
		const where = subUpdateMany.mock.calls[0][0].where as {
			OR: Array<{ createdAt?: { lt: Date } }>;
		};
		const staleClause = where.OR.find((c) => c.createdAt);
		expect(staleClause?.createdAt?.lt).toBeInstanceOf(Date);
	});

	it("rethrows a non-P2002 create error (does not swallow real failures)", async () => {
		subUpdateMany.mockResolvedValue({ count: 0 });
		subCreate.mockRejectedValue({ code: "P2003" }); // FK violation, not a dup
		await expect(
			upsertEmbedPendingSubscriber({ ...base, version: 5 }),
		).rejects.toMatchObject({ code: "P2003" });
	});

	it("I-1: P2002 on the GLOBAL unsubscribeToken @unique is REJECTED (not a send-once no-op)", async () => {
		// A token collision must NOT be misclassified as the (projectId,email) row
		// already existing — that would silently drop a legitimate first-subscribe.
		// When meta.target positively names the token column, rethrow.
		subUpdateMany.mockResolvedValue({ count: 0 });
		subCreate.mockRejectedValue({
			code: "P2002",
			meta: { target: ["unsubscribeToken"] },
		});
		await expect(
			upsertEmbedPendingSubscriber({ ...base, version: 5 }),
		).rejects.toMatchObject({ code: "P2002" });
	});

	it("I-1: plain P2002 with NO meta still returns send-once no-op (adapter-pg may omit target)", async () => {
		// Without a positively-identified token target, default to the (projectId,email)
		// send-once no-op — preserving the pre-fix behavior.
		subUpdateMany.mockResolvedValue({ count: 0 });
		subCreate.mockRejectedValue({ code: "P2002" }); // no meta.target
		const r = await upsertEmbedPendingSubscriber({ ...base, version: 5 });
		expect(r).toEqual({ token: null, sendEmail: false });
	});

	it("I-1: P2002 whose meta.target names ONLY (projectId,email) → send-once no-op", async () => {
		subUpdateMany.mockResolvedValue({ count: 0 });
		subCreate.mockRejectedValue({
			code: "P2002",
			meta: { target: ["projectId", "email"] },
		});
		const r = await upsertEmbedPendingSubscriber({ ...base, version: 5 });
		expect(r).toEqual({ token: null, sendEmail: false });
	});

	describe("concurrency", () => {
		it("two stale-replacements → exactly one sendEmail:true (guarded updateMany count)", async () => {
			// The (projectId,email) row is unique, so only one concurrent updateMany can
			// match it (count 1); the loser sees count 0 and then a P2002 on create.
			let firstReplace = true;
			subUpdateMany.mockImplementation(async () => {
				if (firstReplace) {
					firstReplace = false;
					return { count: 1 };
				}
				return { count: 0 };
			});
			subCreate.mockRejectedValue({ code: "P2002" });

			const [a, b] = await Promise.all([
				upsertEmbedPendingSubscriber({ ...base, version: 7 }),
				upsertEmbedPendingSubscriber({ ...base, version: 7 }),
			]);
			const sent = [a, b].filter((r) => r.sendEmail);
			expect(sent).toHaveLength(1);
		});

		it("two first-subscribes (no row) → one create wins, the other P2002 → one email", async () => {
			subUpdateMany.mockResolvedValue({ count: 0 }); // nothing to replace either time
			let firstCreate = true;
			subCreate.mockImplementation(async () => {
				if (firstCreate) {
					firstCreate = false;
					return { id: "s-new" };
				}
				throw { code: "P2002" };
			});

			const [a, b] = await Promise.all([
				upsertEmbedPendingSubscriber({ ...base, version: 5 }),
				upsertEmbedPendingSubscriber({ ...base, version: 5 }),
			]);
			const sent = [a, b].filter((r) => r.sendEmail);
			expect(sent).toHaveLength(1);
			expect(sent[0]?.token).not.toBeNull();
		});
	});
});

describe("confirmPublicSubscriberByToken — token-gated activation", () => {
	beforeEach(() => {
		txFindFirst.mockReset();
		txUpdateMany.mockReset();
		txQueryRaw.mockReset();
		transactionMock.mockClear();
	});

	it("unknown / used token → not confirmed (no settings read, no activation)", async () => {
		txFindFirst.mockResolvedValue(null);
		const r = await confirmPublicSubscriberByToken("nope");
		expect(r).toEqual({ confirmed: false, email: null, projectId: null });
		expect(txQueryRaw).not.toHaveBeenCalled();
		expect(txUpdateMany).not.toHaveBeenCalled();
	});

	it("null-stamp legacy subscriber → confirmed with NO widget gate", async () => {
		txFindFirst.mockResolvedValue({
			id: "sub-1",
			email: "legacy@example.com",
			projectId: "p1",
			embedTokenVersion: null,
		});
		txUpdateMany.mockResolvedValue({ count: 1 });

		const r = await confirmPublicSubscriberByToken("t-legacy");
		expect(r).toEqual({
			confirmed: true,
			email: "legacy@example.com",
			projectId: "p1",
		});
		// The version gate (settings FOR UPDATE) is SKIPPED for a null stamp.
		expect(txQueryRaw).not.toHaveBeenCalled();
	});

	it("null-stamp legacy subscriber confirms even when the project has NO settings row", async () => {
		// No settings lookup happens at all, so a missing settings row is irrelevant.
		txFindFirst.mockResolvedValue({
			id: "sub-1",
			email: "legacy@example.com",
			projectId: "p-no-settings",
			embedTokenVersion: null,
		});
		txUpdateMany.mockResolvedValue({ count: 1 });
		const r = await confirmPublicSubscriberByToken("t-legacy");
		expect(r.confirmed).toBe(true);
		expect(txQueryRaw).not.toHaveBeenCalled();
	});

	it("stamped + enabled + version match → confirmed (gate read happens, then activate)", async () => {
		txFindFirst.mockResolvedValue({
			id: "sub-2",
			email: "v@example.com",
			projectId: "p1",
			embedTokenVersion: 5,
		});
		txQueryRaw.mockResolvedValue([
			{ publicWidgetEnabled: true, publicEmbedTokenVersion: 5 },
		]);
		txUpdateMany.mockResolvedValue({ count: 1 });

		const r = await confirmPublicSubscriberByToken("t");
		expect(r).toEqual({
			confirmed: true,
			email: "v@example.com",
			projectId: "p1",
		});
		// The gate MUST read the settings row (FOR UPDATE lock) before activating.
		expect(txQueryRaw).toHaveBeenCalledTimes(1);
		expect(txUpdateMany).toHaveBeenCalledTimes(1);
		// Activation is status-guarded AND re-checks the still-current bearer token +
		// stamped version, so a racing resubscribe that replaced the token/version
		// (READ COMMITTED) cannot activate a superseded row.
		const where = txUpdateMany.mock.calls[0][0].where as Record<
			string,
			unknown
		>;
		expect(where).toMatchObject({
			id: "sub-2",
			status: "PENDING_CONFIRMATION",
			unsubscribeToken: "t",
			embedTokenVersion: 5,
		});
	});

	it("activation re-checks bearer token + version: a racing resubscribe replaced them → count 0 → not confirmed, no welcome email", async () => {
		// After findFirst returns the pending row (token "t", version 5), a concurrent
		// upsertEmbedPendingSubscriber replaces this row's unsubscribeToken/embedTokenVersion.
		// Under READ COMMITTED the activation updateMany must therefore match 0 rows
		// (the WHERE pins the old token + version), so the OLD/superseded token cannot
		// activate the row.
		txFindFirst.mockResolvedValue({
			id: "sub-race",
			email: "v@example.com",
			projectId: "p1",
			embedTokenVersion: 5,
		});
		txQueryRaw.mockResolvedValue([
			{ publicWidgetEnabled: true, publicEmbedTokenVersion: 5 },
		]);
		// The token/version were replaced between the read and the update → 0 rows match.
		txUpdateMany.mockResolvedValue({ count: 0 });

		const r = await confirmPublicSubscriberByToken("t");
		expect(r).toEqual({ confirmed: false, email: null, projectId: null });
		// The activation WHERE pins the still-current token + stamped version.
		const where = txUpdateMany.mock.calls[0][0].where as Record<
			string,
			unknown
		>;
		expect(where).toMatchObject({
			id: "sub-race",
			status: "PENDING_CONFIRMATION",
			unsubscribeToken: "t",
			embedTokenVersion: 5,
		});
	});

	it("null-stamp legacy activation pins embedTokenVersion:null (IS NULL matches the legacy row)", async () => {
		// A legacy/marketing row carries embedTokenVersion === null. The activation WHERE
		// must pin embedTokenVersion to the read value (null) — Prisma treats this as
		// IS NULL, which still matches the same legacy row.
		txFindFirst.mockResolvedValue({
			id: "sub-legacy",
			email: "legacy@example.com",
			projectId: "p1",
			embedTokenVersion: null,
		});
		txUpdateMany.mockResolvedValue({ count: 1 });

		const r = await confirmPublicSubscriberByToken("t-legacy");
		expect(r).toEqual({
			confirmed: true,
			email: "legacy@example.com",
			projectId: "p1",
		});
		const where = txUpdateMany.mock.calls[0][0].where as Record<
			string,
			unknown
		>;
		expect(where).toMatchObject({
			id: "sub-legacy",
			status: "PENDING_CONFIRMATION",
			unsubscribeToken: "t-legacy",
			embedTokenVersion: null,
		});
	});

	it("stamped + widget DISABLED → not confirmed (revocation gate)", async () => {
		txFindFirst.mockResolvedValue({
			id: "sub-3",
			email: "v@example.com",
			projectId: "p1",
			embedTokenVersion: 5,
		});
		txQueryRaw.mockResolvedValue([
			{ publicWidgetEnabled: false, publicEmbedTokenVersion: 5 },
		]);

		const r = await confirmPublicSubscriberByToken("t");
		expect(r).toEqual({ confirmed: false, email: null, projectId: null });
		// Gate read happened, but activation did NOT.
		expect(txQueryRaw).toHaveBeenCalledTimes(1);
		expect(txUpdateMany).not.toHaveBeenCalled();
	});

	it("stamped + version MISMATCH (rotated) → not confirmed", async () => {
		txFindFirst.mockResolvedValue({
			id: "sub-4",
			email: "v@example.com",
			projectId: "p1",
			embedTokenVersion: 5,
		});
		txQueryRaw.mockResolvedValue([
			{ publicWidgetEnabled: true, publicEmbedTokenVersion: 6 }, // bumped by a rotate
		]);

		const r = await confirmPublicSubscriberByToken("t");
		expect(r).toEqual({ confirmed: false, email: null, projectId: null });
		expect(txUpdateMany).not.toHaveBeenCalled();
	});

	it("stamped but settings row missing → not confirmed (no enabled state to trust)", async () => {
		txFindFirst.mockResolvedValue({
			id: "sub-5",
			email: "v@example.com",
			projectId: "p1",
			embedTokenVersion: 5,
		});
		txQueryRaw.mockResolvedValue([]); // FOR UPDATE found no settings row
		const r = await confirmPublicSubscriberByToken("t");
		expect(r).toEqual({ confirmed: false, email: null, projectId: null });
		expect(txUpdateMany).not.toHaveBeenCalled();
	});

	it("double-confirm of the same token → exactly one confirmed:true", async () => {
		// First confirm: PENDING found, gate passes, activation count 1.
		// Second confirm: the row is now ACTIVE, so the PENDING-guarded findFirst
		// returns null → not confirmed. We simulate that ordering across two calls.
		txFindFirst
			.mockResolvedValueOnce({
				id: "sub-6",
				email: "v@example.com",
				projectId: "p1",
				embedTokenVersion: null,
			})
			.mockResolvedValueOnce(null);
		txUpdateMany.mockResolvedValue({ count: 1 });

		const first = await confirmPublicSubscriberByToken("t");
		const second = await confirmPublicSubscriberByToken("t");
		const confirmed = [first, second].filter((r) => r.confirmed);
		expect(confirmed).toHaveLength(1);
	});

	it("guarded activation losing the race (count 0) → not confirmed", async () => {
		// findFirst saw PENDING, but a concurrent confirm flipped it ACTIVE before our
		// updateMany ran → count 0 → no second welcome email.
		txFindFirst.mockResolvedValue({
			id: "sub-7",
			email: "v@example.com",
			projectId: "p1",
			embedTokenVersion: null,
		});
		txUpdateMany.mockResolvedValue({ count: 0 });
		const r = await confirmPublicSubscriberByToken("t");
		expect(r).toEqual({ confirmed: false, email: null, projectId: null });
	});

	it("revocation race: disable holds the settings lock, confirm waits then rejects on committed-disabled state", async () => {
		// Model Postgres FOR UPDATE serialization: a disable tx holds the settings-row
		// lock; the stamped confirm's $queryRaw (FOR UPDATE) BLOCKS until disable commits,
		// then reads the committed (disabled) state → rejects. We serialize the two via a
		// single-slot mutex on the settings row and mutate shared committed state.
		const committed = {
			publicWidgetEnabled: true,
			publicEmbedTokenVersion: 5,
		};
		let locked = false;
		const waiters: Array<() => void> = [];
		const acquire = () =>
			new Promise<void>((resolve) => {
				if (!locked) {
					locked = true;
					resolve();
				} else {
					waiters.push(resolve);
				}
			});
		const release = () => {
			const next = waiters.shift();
			if (next) {
				next();
			} else {
				locked = false;
			}
		};

		// The owner "disable" transaction: take the lock, commit a disable, release.
		const disable = (async () => {
			await acquire();
			committed.publicWidgetEnabled = false; // durable revocation
			committed.publicEmbedTokenVersion = 6; // a disable bumps the version too
			release();
		})();

		txFindFirst.mockResolvedValue({
			id: "sub-8",
			email: "v@example.com",
			projectId: "p1",
			embedTokenVersion: 5,
		});
		// The confirm's FOR UPDATE settings read must serialize behind the disable lock,
		// then observe the COMMITTED (post-revocation) snapshot.
		txQueryRaw.mockImplementation(async () => {
			await acquire();
			const snapshot = [{ ...committed }];
			release();
			return snapshot;
		});
		txUpdateMany.mockResolvedValue({ count: 1 });

		const [, confirmResult] = await Promise.all([
			disable,
			confirmPublicSubscriberByToken("t"),
		]);

		// After the revocation commits, the gate sees disabled + bumped version → reject.
		expect(confirmResult).toEqual({
			confirmed: false,
			email: null,
			projectId: null,
		});
		expect(txUpdateMany).not.toHaveBeenCalled();
		// Proof the gate actually performed the locked read.
		expect(txQueryRaw).toHaveBeenCalledTimes(1);
	});
});
