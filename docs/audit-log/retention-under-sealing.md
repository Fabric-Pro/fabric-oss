# Retention under sealing

How the audit-log retention purge and the seal chain interact, why retention
currently stops at the sealed boundary, and the design that would let it past.

- **Audience**: whoever next needs `FABRIC_AUDIT_LOG_RETENTION_DAYS` and
  `FABRIC_AUDIT_LOG_SEALING_ENABLED` on at the same time
- **Owner**: Platform / SRE

## The interaction

A seal covers a time window. Its `contentHash` is a fold over the per-row hashes of
every `audit_log` row in that window, and `verifySealAgainstContent` reports a
mismatch for **modified, inserted or deleted** rows alike — it cannot tell them
apart, which is exactly what makes it useful as tamper evidence.

The retention purge deletes rows older than a cutoff. It originally had no knowledge
of sealing. So enabling both would make every seal covering a purged window report
tampering, and once retention runs nightly, *every* historical seal reports it. That
does not merely produce noise: it destroys the control, because real tampering
becomes indistinguishable from routine housekeeping (SOC 2 CC7.1 / CC7.2).

## What ships today

Retention takes `getSealedThroughAt()` — the newest seal's `periodEnd` — as a hard
**lower bound** on deletion, and counts what it withheld on
`audit.retention.withheld_sealed_rows`.

**Consequence, stated plainly: while sealing keeps up, retention deletes nothing.**
The purge is not broken; it is correctly refusing to create false tamper evidence.

This is not a live problem. **Both switches are off by default** — sealing is opt-in
via `FABRIC_AUDIT_LOG_SEALING_ENABLED` and inert until set, and retention treats `0`
(its default) as disabled. A deployment that turns retention on *without* sealing
purges normally. The refusal only appears when both are on, and then it fails safe.

The near-term volume levers are therefore elsewhere, and they are the effective
ones anyway: the activity-capture read-name rule (which stopped ~75 read procedures
writing rows), the `FABRIC_AUDIT_ACTIVITY_CAPTURE_SKIP_PATHS` list, and the
`FABRIC_AUDIT_ACTIVITY_CAPTURE_DISABLED` kill switch.

## The design that unblocks it: a signed retention watermark

Verification needs to distinguish "these rows were purged by policy" from "these
rows were removed by someone". A hash alone cannot say that. A **signature** can,
because it requires the same key the seals themselves are signed with — so the trust
assumption does not widen.

Sketch:

1. **A new signed record** — `AuditLogRetentionWatermark` — carrying
   `purgedThroughAt`, `purgedFromAt`, `purgedRowCount`, a `purgedContentHash` folded
   over exactly the rows about to be deleted, `prevWatermarkHash` for chaining, and
   an HMAC signature over all of it. Same key, same fold function, same chaining
   discipline as `AuditLogSeal`.

2. **Retention writes it before deleting**, in the same transaction as the delete:
   compute the fold over the batch, append the watermark, then delete. Ordering
   matters — a crash after the delete but before the watermark is the one state that
   would look like tampering, so the watermark must commit with (or before) the
   delete, never after.

3. **Verification reconciles.** For a seal window that a watermark overlaps,
   recompute the fold over the *surviving* rows and combine it with the watermark's
   `purgedContentHash`; the result must equal the seal's `contentHash`. If it
   reconciles, the gap is policy. If not, it is tampering. An unsigned or
   chain-broken watermark is treated as absent, so forging one requires the key.

4. **Monotonicity.** `purgedThroughAt` must never move backwards, and a watermark may
   only cover a window already sealed — otherwise a purge could be claimed for rows
   no seal ever attested, which would let an attacker "pre-authorise" a deletion.

### Why this is not implemented yet

It is a change to a tamper-evidence control, where a subtle error does not fail
loudly — it silently converts the control into decoration, which is worse than the
current honest refusal. It needs a real-Postgres integration test proving all four
cases (clean purge reconciles; modified row still detected; deleted row *without* a
watermark still detected; forged watermark rejected), and the crypto reviewed by
someone other than its author.

Until then the refusal is the correct behaviour, and it is not costing anything while
both switches stay off.

### Category-aware retention depends on this

Keeping security-relevant categories (`auth`, `org`, `audit`) longer than the
machine-derived `activity.*` tail is the natural volume answer, and it is blocked by
the same thing: a category-selective purge deletes a *subset* of a sealed window,
which is precisely the case a whole-window seal cannot reconcile without a watermark.
Do this design first.
