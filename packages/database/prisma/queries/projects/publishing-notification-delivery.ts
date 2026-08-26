import { randomUUID } from "node:crypto";
import { db, Prisma } from "../../client"; // client.ts re-exports both — NOT ../../../src
import { isTerminalNotificationOutcome } from "./publishing-notification-outcome";

export type PublishingDeliveryTenant = {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
};

export type InAppDeliveryResult =
	| "SENT"
	| "ALREADY_TERMINAL"
	| "TENANT_CHANGED"
	| "FAILED";

/**
 * Why an obligation was terminalized without being delivered. Four values, each of which a reader
 * has to be able to tell apart:
 *
 *   RECIPIENT_UNAUTHORIZED this specific person may no longer be notified. A decision ABOUT them.
 *   TENANT_CHANGED         the project moved tenant, or became ineligible. A decision about the
 *                          PROJECT, taken for every recipient at once.
 *   CYCLE_CLOSED           the cycle reached a terminal outcome with this obligation still open —
 *                          the kill switch went off, the candidate set emptied, or the batch
 *                          finished while this row belonged to someone no longer in it. Neither
 *                          sibling is honest for it: nobody was found unauthorized and nothing
 *                          moved tenant. Leaving such a row FAILED is the lie this value replaces:
 *                          FAILED means "try again", and once the cycle is terminal nothing ever
 *                          will — no further attempt runs, and 1C-2d's sweep is CYCLE-level, so a
 *                          row-level obligation under a terminal cycle is invisible to it.
 *   NO_EMAIL_ADDRESS       the recipient has no email address on their account, so the EMAIL
 *                          channel cannot reach them. Terminal and not a fault: a recipient who
 *                          is otherwise eligible simply has no address, and retrying cannot
 *                          create one. Distinct from RECIPIENT_UNAUTHORIZED, which is a decision
 *                          about their permissions rather than about their contact details.
 *
 * The column is plain nullable text with no CHECK constraint (see the table's migration: only
 * `status` is constrained, because only `status` has a state machine reading it), so widening this
 * union is a TypeScript change and not a migration.
 */
export type PublishingDeliverySkipReason =
	| "RECIPIENT_UNAUTHORIZED"
	| "TENANT_CHANGED"
	| "CYCLE_CLOSED"
	| "NO_EMAIL_ADDRESS";

/**
 * Why a CLAIMED email send failed. Two values, and the set is closed on purpose:
 *
 *   PROVIDER_ERROR    the provider call THREW. `sendEmail` is documented to return false rather
 *                     than throw, so reaching this means something outside that contract went
 *                     wrong — and the throw's own text is preserved in `errorMessage`, not here.
 *   PROVIDER_REJECTED the provider call returned false. The send did not succeed, and whether the
 *                     message was nonetheless accepted upstream is exactly what nobody knows.
 *
 * A CLASSIFICATION, never the provider's own response body. `reason` is a column operators read
 * and 1C-2d will GROUP on; a raw response is how an address or a subject line ends up in it. The
 * open-ended text has a home already — `errorMessage`, truncated — and keeping the two apart is
 * what lets one be grouped and the other be read.
 *
 * A union rather than the bare `string` this started as, and the choice is deliberate rather than
 * inherited: the callers are enumerable (both of them live in Task 7's provider call, one per
 * branch), so nothing is lost by closing it now and a grouping key stops being a free-text field
 * later. Like its sibling above, the column is plain nullable text with no CHECK constraint, so
 * widening this union is a TypeScript change and not a migration.
 */
export type PublishingEmailFailureReason =
	| "PROVIDER_ERROR"
	| "PROVIDER_REJECTED";

function buildTitle(topicCount: number, projectName: string): string {
	const noun = topicCount === 1 ? "topic" : "topics";
	return `${topicCount} publishing ${noun} ready in ${projectName}`;
}

/**
 * The tenant fence, inside the caller's transaction. Mirrors persistCycleTerminal's F1 guard: a
 * FOR UPDATE re-read of the Project's CURRENT row, which BLOCKS a concurrent transfer from
 * committing until this transaction does, rather than merely detecting one after the fact.
 *
 * The per-recipient permission check happens outside this transaction and cannot be locked. Tenancy
 * can be, and for in-app it MUST be: unlike email, delivery here is entirely database work, so the
 * "one provider call wide" residual §9.2(d) accepts is zero calls wide for this channel. Leaving
 * the window open would write a bell row and a ledger row under a tenant tuple that is no longer
 * the project's — the exact thing §9.2(d) forbids.
 *
 * Eligibility (status ACTIVE, deletedAt null) is part of the fence for the same reason it is part
 * of F1: a project archived or soft-deleted after the cycle was dispatched must not have its
 * members told about it either.
 */
async function currentTenantMatches(
	tx: Prisma.TransactionClient,
	tenant: PublishingDeliveryTenant,
): Promise<boolean> {
	const rows = await tx.$queryRaw<
		{
			organizationId: string | null;
			userId: string;
			status: string;
			deletedAt: Date | null;
		}[]
	>`SELECT "organizationId", "userId", "status", "deletedAt" FROM "project" WHERE "id" = ${tenant.projectId} FOR UPDATE`;
	const project = rows[0];
	if (!project || project.status !== "ACTIVE" || project.deletedAt !== null) {
		return false;
	}
	const currentOrg = project.organizationId ?? null;
	const currentUser = currentOrg === null ? project.userId : null;
	return (
		currentOrg === tenant.organizationId && currentUser === tenant.userId
	);
}

/**
 * Take the SAME project row lock every creating path takes, and NOTHING else — no tenancy
 * assertion, no eligibility filter, no return value.
 *
 * Delivery and terminalization are otherwise not mutually exclusive. The notification activity's
 * closing transaction terminalizes the outstanding ledger rows and compare-and-swaps the cycle's
 * outcome as one unit, but until it holds this lock nothing stops a still-running overlapping
 * attempt from committing a delivery beside it — a `SENT` row and a real bell for a cycle the
 * closing transaction is in the middle of resolving as `DISABLED`. Serializing the two on the
 * project row is what makes the creation fence's terminality check reliable rather than advisory:
 * the loser blocks here, and reads the winner's committed outcome when it wakes.
 *
 * LOCK-ONLY on purpose, and that is not an oversight. Every completing exit routes through the
 * closing transaction, INCLUDING the tenant-move exit — where the project's tuple no longer matches
 * the cycle's by definition. A helper that also asserted tenancy would refuse exactly the caller
 * that most needs the lock.
 *
 * Ordering: this must be the FIRST statement of the transaction that calls it. Every transaction in
 * this file and its callers takes the project row before any ledger row and writes the cycle row
 * last, and that single order is what keeps the wait-for graph acyclic.
 */
export async function lockPublishingProjectRow(
	client: Prisma.TransactionClient,
	projectId: string,
): Promise<void> {
	await client.$queryRaw`SELECT 1 FROM "project" WHERE "id" = ${projectId} FOR UPDATE`;
}

/**
 * ONE read of the cycle row, answering both questions the fences ask of it — who owns it, and
 * whether its notification outcome is already final. Two reads would be two snapshots, and the two
 * halves of a fence taken at different instants are not a fence.
 */
async function readCycleFenceState(
	tx: Prisma.TransactionClient,
	cycleId: string,
	tenant: PublishingDeliveryTenant,
): Promise<{ belongsToTenant: boolean; isTerminal: boolean }> {
	const owner = await tx.publishingSuggestionCycle.findUnique({
		where: { id: cycleId },
		// `notificationOutcome` rides along in the SAME statement the ownership assertion already
		// issues, so the terminality half of the creation fence below costs no extra round trip.
		select: {
			projectId: true,
			organizationId: true,
			userId: true,
			notificationOutcome: true,
		},
	});
	return {
		belongsToTenant:
			owner != null &&
			owner.projectId === tenant.projectId &&
			owner.organizationId === tenant.organizationId &&
			owner.userId === tenant.userId,
		isTerminal:
			owner != null &&
			isTerminalNotificationOutcome(owner.notificationOutcome),
	};
}

/**
 * The ownership half of the fence, and the half the project lock cannot supply. `currentTenantMatches`
 * validates the caller's tuple against the project the caller NAMED — it compares Y against Y — so
 * it says nothing about whether `cycleId` belongs to that project. The cycle's foreign key proves
 * only that the cycle exists.
 *
 * Without this, a stale, malformed or version-skewed workflow input creates a ledger row whose
 * cycleId belongs to one project while its denormalized projectId/organizationId/userId name
 * another; the fence passes, and readPublishingDeliveryStates({ cycleId }) then hands that
 * foreign-tenant row back to the first project's caller.
 *
 * Mirrors persistCycleTerminal's F5 guard — same table family, same threat, same remedy: load the
 * cycle, compare its own denormalized tuple, and no-op on a mismatch.
 *
 * Ownership ONLY, deliberately: this is what the TERMINALIZING path asks, and that path exists
 * precisely to close leftover obligations under a cycle that is already terminal. Folding the
 * creation fence's terminality refusal in here would make it refuse its own reason for existing.
 */
async function cycleBelongsToTenant(
	tx: Prisma.TransactionClient,
	cycleId: string,
	tenant: PublishingDeliveryTenant,
): Promise<boolean> {
	return (await readCycleFenceState(tx, cycleId, tenant)).belongsToTenant;
}

/**
 * The complete fence a CREATING path must clear: F1's `FOR UPDATE` assertion on the project's
 * CURRENT row, then F5's cycle-ownership assertion and the cycle's terminality. Its answer is a
 * VERDICT rather than a boolean, because its two failures mean different things and the callers say
 * different things about them.
 *
 * `TENANT_CHANGED` covers the whole tenancy question — the project moved, became ineligible, or the
 * cycle belongs to another project. The world moved under this attempt, so write nothing.
 *
 * `CYCLE_TERMINAL` is the third condition, and it closes a gap the tenancy checks structurally
 * cannot see: the tenant is unchanged and the project is fine, but a NEWER attempt has already
 * written the cycle's terminal outcome. An overlapping attempt is not hypothetical — an activity's
 * start-to-close timeout does not stop the attempt that timed out, so a slow attempt that read
 * `notificationsEnabled: true` before an admin switched it off can arrive here after the cycle has
 * been closed as DISABLED. Creating a row now produces one nothing will ever reconcile: no further
 * attempt runs, and 1C-2d's sweep is CYCLE-level, so a row-level obligation under a resolved cycle
 * is invisible to it — and for a delivery it also puts a real bell in someone's tray for a cycle
 * whose outcome says nobody was notified.
 *
 * F1 RUNS FIRST HERE, which inverts persistCycleTerminal's F5-then-F1 order, and the terminality
 * half is the whole reason. The outcome the notification activity's closing transaction writes is
 * only serialized against this one by the project row lock; read the cycle BEFORE taking that lock
 * and the answer is stale by construction — this transaction sees `PENDING`, blocks on the lock the
 * closing transaction is holding, and then proceeds on a cycle that committed `DISABLED` while it
 * waited. That is the exact interleaving the check exists to stop, so the read has to happen under
 * the lock. What the inversion costs is F5's cheap early reject: a cross-project cycleId now takes
 * (and immediately releases) a row lock on the project the caller named before being refused.
 *
 * Terminality is read through the SHARED predicate in publishing-notification-outcome.ts rather
 * than re-derived here: `NOT_APPLICABLE` (never entered the lifecycle) and `RESOLUTION_FAILED`
 * (stamped expecting a later attempt to supersede it) are both NON-terminal, and a fence that got
 * either wrong would refuse the rolling-deploy repair path or the stamp-then-retry path
 * respectively.
 */
type CreationFenceVerdict = "OK" | "TENANT_CHANGED" | "CYCLE_TERMINAL";

async function creationFenceVerdict(
	tx: Prisma.TransactionClient,
	cycleId: string,
	tenant: PublishingDeliveryTenant,
): Promise<CreationFenceVerdict> {
	if (!(await currentTenantMatches(tx, tenant))) {
		return "TENANT_CHANGED";
	}
	const cycle = await readCycleFenceState(tx, cycleId, tenant);
	if (!cycle.belongsToTenant) {
		return "TENANT_CHANGED";
	}
	return cycle.isTerminal ? "CYCLE_TERMINAL" : "OK";
}

/**
 * In-app delivery is EXACTLY-ONCE, and this is where that is true rather than asserted: the ledger
 * row and the Notification row commit in ONE transaction, so the unique triple
 * (cycleId, recipientUserId, channel) is itself the fence. Two overlapping attempts cannot both
 * commit, and the loser rolls back having written nothing.
 *
 * The row is CLAIMED, not blind-created. A blind create looks right and strands the recipient
 * permanently: a transient failure inside the transaction rolls the whole thing back, the caller
 * writes a FAILED row to record it, and every subsequent retry then hits P2002 on the insert,
 * reads it as "already handled", and never retries the Notification. The recipient is never told,
 * the row stays unconfirmed, and the activity rejects until its budget runs out. So an existing
 * row that is neither delivered nor terminal is TAKEN OVER by a conditional update, which is also
 * what keeps two overlapping attempts from both proceeding — under READ COMMITTED the loser
 * re-evaluates `deliveredAt IS NULL` after the winner commits and matches nothing.
 *
 * P2002 on the insert path does NOT by itself mean "already handled". A row appearing under the
 * triple can be a FAILED row from the recorder below or a SKIPPED row from the cancellation path,
 * so the catch decides from the row's STATE. See the branch itself for what actually makes it
 * unreachable today.
 */
export async function deliverPublishingTopicsReadyInApp(input: {
	cycleId: string;
	tenant: PublishingDeliveryTenant;
	recipientUserId: string;
	projectName: string;
	topicCount: number;
}): Promise<InAppDeliveryResult> {
	try {
		return await db.$transaction(async (tx) => {
			const fence = await creationFenceVerdict(
				tx,
				input.cycleId,
				input.tenant,
			);
			if (fence === "TENANT_CHANGED") {
				return "TENANT_CHANGED" as const;
			}
			if (fence === "CYCLE_TERMINAL") {
				// ALREADY_TERMINAL is the honest verdict and it is one the caller already
				// understands: "do not act". TENANT_CHANGED would be a lie the LEDGER then
				// repeats — the caller closes every outstanding obligation with that reason,
				// and the three skip reasons only earn their place by staying tellable apart.
				return "ALREADY_TERMINAL" as const;
			}

			const existing = await tx.publishingNotificationDelivery.findUnique(
				{
					where: {
						cycleId_recipientUserId_channel: {
							cycleId: input.cycleId,
							recipientUserId: input.recipientUserId,
							channel: "IN_APP",
						},
					},
					select: { id: true, status: true, deliveredAt: true },
				},
			);

			if (
				existing &&
				(existing.deliveredAt !== null || existing.status === "SKIPPED")
			) {
				return "ALREADY_TERMINAL" as const; // delivered, or cancelled — either way, do not act
			}

			if (existing) {
				// Take over an unresolved FAILED row. This is the retry path a blind create loses,
				// and FAILED is the WHOLE of it: the creating branch below writes SENT directly
				// (in-app delivery is exactly-once — ledger row and bell in one transaction), so
				// the only status this branch can ever find still owed is the one its own failure
				// recorder wrote. There is no PENDING to admit; the status CHECK does not even
				// list that value.
				//
				// AN ALLOW-LIST OF ONE, where this shipped as `status: { not: "SKIPPED" }`. The two
				// select the SAME rows today and this is not a bug fix — SENT is kept out by the
				// deliveredAt term, SKIPPED by both forms, and SENDING/DEFERRED/EXPIRED belong to
				// the email lifecycle, which publishing_notification_delivery_leased_channel now
				// makes unwritable on this channel.
				//
				// What it buys is that the constraint can be WIDENED safely. A slice that gives a
				// second channel a lease widens that CHECK; with an exclusion this reader would
				// silently begin adopting the new status — delivering a bell for an obligation
				// another carrier owns and marking it SENT, with the row present, every count in
				// agreement and only a ledger read after the fact able to see it. With the list it
				// refuses, which is the safe direction. Say plainly what that costs: BECAUSE the
				// state is unrepresentable, no test can fail on this line, and the same conversion
				// was declined one function over (terminalizeExistingDeliveriesAsSkipped) for
				// exactly that reason. The difference is that this function hard-codes its channel
				// and can therefore enumerate its statuses exactly, while that one takes the
				// channel as a parameter and cannot.
				//
				// The refusal surfaces as ALREADY_TERMINAL, which is safe but imprecise — a
				// deferred row is not terminal. A slice that widens the CHECK owes this branch a
				// verdict of its own; this file cares elsewhere about keeping the three skip
				// reasons tellable apart, and that debt is the same one.
				//
				// SKIPPED is now excluded by omission rather than by a term, and the reason it had
				// one is still worth knowing: the read above can see FAILED, a concurrent
				// cancellation can terminalize the row, and SKIPPED still carries a null
				// deliveredAt — so a predicate on deliveredAt alone would overwrite the
				// cancellation and notify someone the code had already decided it must not.
				// recordPublishingDeliverySkip DOES take the same project lock, and so does the
				// notification activity's closing transaction; terminalizeExistingDeliveriesAsSkipped's
				// OTHER call site — the already-terminal branch, which runs on the base client and
				// takes no lock — is the path that does not, and it is what makes this term
				// load-bearing rather than defensive padding.
				const { count } =
					await tx.publishingNotificationDelivery.updateMany({
						where: {
							id: existing.id,
							deliveredAt: null,
							status: "FAILED",
						},
						data: {
							status: "SENT",
							deliveredAt: new Date(),
							reason: null,
							errorMessage: null,
						},
					});
				if (count === 0) {
					return "ALREADY_TERMINAL" as const;
				}
			} else {
				await tx.publishingNotificationDelivery.create({
					data: {
						cycleId: input.cycleId,
						projectId: input.tenant.projectId,
						organizationId: input.tenant.organizationId,
						userId: input.tenant.userId,
						recipientUserId: input.recipientUserId,
						channel: "IN_APP",
						status: "SENT",
						deliveredAt: new Date(),
					},
				});
			}

			await tx.notification.create({
				data: {
					userId: input.recipientUserId,
					organizationId: input.tenant.organizationId,
					projectId: input.tenant.projectId,
					type: "PUBLISHING_TOPICS_READY",
					category: "PUBLISHING",
					title: buildTitle(input.topicCount, input.projectName),
					snippet: "Review them and pick what to write.",
					// Context-relative, no leading slash: resolveNotificationLink prepends the
					// notification's own workspace base.
					link: `projects/${input.tenant.projectId}/publishing`,
					payload: {
						projectId: input.tenant.projectId,
						cycleId: input.cycleId,
						topicCount: input.topicCount,
					},
					// No dedupeKey on purpose — see the test for why the live partial index is the
					// wrong mechanism for a once-per-cycle event under at-least-once retries.
				},
			});
			return "SENT" as const;
		});
	} catch (error) {
		if (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === "P2002"
		) {
			// A row appeared under this triple between the read above and the insert. Decide from
			// that row's STATE, never from its existence: the recorder below commits FAILED rows and
			// the cancellation path commits SKIPPED ones, so "a row is here" does not mean "the
			// recipient was told". Answering ALREADY_TERMINAL for a concurrently-created FAILED row
			// is precisely the has-a-row-is-discharged defect this module is organized against, and
			// it would strand the recipient with no delivery and no retry.
			//
			// What makes this branch unreachable today is NOT that a winner necessarily delivered —
			// it is that all three creating paths hold the SAME project row lock, so no ledger
			// insert can commit while a delivery transaction is open. That invariant is enforced
			// elsewhere in this file; reading state keeps this branch correct anyway if a fourth
			// creating path ever arrives without the lock.
			let winner: { status: string; deliveredAt: Date | null } | null =
				null;
			try {
				winner = await db.publishingNotificationDelivery.findUnique({
					where: {
						cycleId_recipientUserId_channel: {
							cycleId: input.cycleId,
							recipientUserId: input.recipientUserId,
							channel: "IN_APP",
						},
					},
					select: { status: true, deliveredAt: true },
				});
			} catch {
				// Unreadable — fall through to the recorder rather than guess at terminality.
				winner = null;
			}
			if (
				winner !== null &&
				(winner.deliveredAt !== null || winner.status === "SKIPPED")
			) {
				return "ALREADY_TERMINAL";
			}
			// Neither delivered nor cancelled: fall through to the recorder, which is already safe
			// here — its upsert cannot raise P2002 and leaves an existing row untouched, so the row
			// stays claimable by the next attempt.
		}
		// The transaction rolled back, so record the failure separately. This row is NOT terminal:
		// the claim path above takes it over on the next attempt. Recording it is what makes the
		// failure visible; leaving it retryable is what makes it recoverable.
		//
		// It carries the SAME fence as the delivery itself, because it CREATES a row. Without it
		// this is the one path that can write a stale-tenant row after everything else has stopped:
		// a slow attempt whose transaction rolled back releases the project lock, the project
		// transfers, a newer attempt cancels the cycle and completes — and then this write lands,
		// creating a non-terminal row under the old tuple that nothing will ever resolve.
		try {
			const recorded = await db.$transaction(async (tx) => {
				const fence = await creationFenceVerdict(
					tx,
					input.cycleId,
					input.tenant,
				);
				if (fence !== "OK") {
					// Same fence, and CYCLE_TERMINAL matters MORE here than on the delivery
					// path: this is the write that creates the FAILED row, and a FAILED row
					// means "try again" for a cycle nothing will ever try again. Leaving it
					// unwritten is what keeps the stranded-obligation set empty.
					return fence;
				}
				await tx.publishingNotificationDelivery.upsert({
					where: {
						cycleId_recipientUserId_channel: {
							cycleId: input.cycleId,
							recipientUserId: input.recipientUserId,
							channel: "IN_APP",
						},
					},
					create: {
						cycleId: input.cycleId,
						projectId: input.tenant.projectId,
						organizationId: input.tenant.organizationId,
						userId: input.tenant.userId,
						recipientUserId: input.recipientUserId,
						channel: "IN_APP",
						status: "FAILED",
						reason: "WRITE_FAILED",
						errorMessage: describeError(error),
					},
					update: {},
				});
				return "OK" as const;
			});
			if (recorded === "TENANT_CHANGED") {
				return "TENANT_CHANGED";
			}
			if (recorded === "CYCLE_TERMINAL") {
				// No row was created, and none is owed: the cycle already has its answer, so
				// there is nothing left for this attempt to record or to retry.
				return "ALREADY_TERMINAL";
			}
		} catch (recordError) {
			// Recording the failure must not mask it — but swallowing it silently leaves a deadlock,
			// FK violation or transaction timeout inside the recorder with no trace at all, and the
			// caller sees only "FAILED", indistinguishable from a failure that WAS recorded. Warn
			// for the same reason persistCycleTerminal warns on its analogous branch.
			console.warn(
				"[publishing-notification-delivery/deliverPublishingTopicsReadyInApp] could not record the delivery failure",
				{
					projectId: input.tenant.projectId,
					cycleId: input.cycleId,
					recipientUserId: input.recipientUserId,
					channel: "IN_APP",
					error: describeError(recordError),
				},
			);
		}
		return "FAILED";
	}
}

function describeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(
		0,
		1000,
	);
}

/**
 * A cancelled obligation is TERMINAL: SKIPPED means "we must not try", as opposed to FAILED's "we
 * tried and it did not work, try again". Collapsing the two either retries something forbidden or
 * spins the activity until its retry budget is exhausted over work it can never discharge.
 *
 * It must also be able to terminalize a row that ALREADY EXISTS unresolved — a recipient whose
 * first attempt left a FAILED row and who was then revoked. A create-only implementation hits
 * P2002, returns quietly, and leaves FAILED behind: forever unconfirmed, and forever making the
 * activity reject over an obligation it is now forbidden to discharge.
 */
export async function recordPublishingDeliverySkip(input: {
	cycleId: string;
	tenant: PublishingDeliveryTenant;
	recipientUserId: string;
	channel: string;
	reason: PublishingDeliverySkipReason;
}): Promise<"OK" | "TENANT_CHANGED"> {
	return db.$transaction(async (tx) => {
		// The same fence as delivery — cycle ownership AND the locked tenant tuple — for the same
		// reason: this path CREATES a row. A transfer between the caller's authorization check and
		// this write would otherwise insert a post-transfer row under the old tuple, and a
		// cross-project cycleId would insert a row belonging to neither — bypassing the delivery
		// fence through the door next to it.
		//
		// CYCLE_TERMINAL is deliberately NOT refused here, and the asymmetry is the point. The harm
		// that half of the fence exists to stop is a row nothing will ever reconcile: a FAILED row
		// saying "try again" under a cycle no attempt will revisit, or a SENT row plus a real bell
		// under a cycle whose outcome says nobody was notified. A SKIPPED row is neither — it is
		// terminal on arrival, it carries no bell, and it records that this specific person was
		// deliberately not notified. Refusing it would delete evidence rather than protect anything.
		// (There is also no verdict left to say it with: this function answers "OK" | "TENANT_CHANGED",
		// and both would be untrue.)
		if (
			(await creationFenceVerdict(tx, input.cycleId, input.tenant)) ===
			"TENANT_CHANGED"
		) {
			return "TENANT_CHANGED" as const;
		}
		await tx.publishingNotificationDelivery.upsert({
			where: {
				cycleId_recipientUserId_channel: {
					cycleId: input.cycleId,
					recipientUserId: input.recipientUserId,
					channel: input.channel,
				},
			},
			create: {
				cycleId: input.cycleId,
				projectId: input.tenant.projectId,
				organizationId: input.tenant.organizationId,
				userId: input.tenant.userId,
				recipientUserId: input.recipientUserId,
				channel: input.channel,
				status: "SKIPPED",
				reason: input.reason,
			},
			update: {},
		});
		// A delivered row is never downgraded — cancellation prevents a FUTURE claim and prevents
		// the row ever recording a delivery; it does not un-send one. An unresolved row is
		// terminalized. Both statements share this transaction and its lock, so an existing row
		// cannot change state between them.
		await tx.publishingNotificationDelivery.updateMany({
			where: {
				cycleId: input.cycleId,
				recipientUserId: input.recipientUserId,
				channel: input.channel,
				deliveredAt: null,
				status: { not: "SKIPPED" },
			},
			data: {
				status: "SKIPPED",
				reason: input.reason,
				// Release the lease along with the obligation. A row terminalized WITHOUT DELIVERING
				// must never carry a claim: every reader in THIS slice gates on `status` first and so
				// is unaffected, but 1C-2d's sweep decides re-claimability from lease expiry, and a
				// SKIPPED row with a live-looking claimedAt is exactly what would invite it to check
				// the lease first. A no-op for IN_APP rows, which never take a claim.
				//
				// "Without delivering" is the whole scope of that rule and not a hedge: a SENT row
				// KEEPS both fields, deliberately, and confirmPublishingEmailDelivery says why. The
				// commonest terminal state is therefore the one exception, so 1C-2d must still read
				// `status` before the lease — releasing here removes one trap, not the need to.
				claimedAt: null,
				claimToken: null,
				// lastAttemptAt is NOT cleared here either, and the omission is deliberate in both
				// places. Releasing a lease is a statement about ownership; the timestamp is a
				// statement about the outside world, and terminalizing an obligation does not unsend
				// a message. Clearing all three "for tidiness" is the tempting edit and it is the one
				// that reopens the duplicate hole.
			},
		});
		return "OK" as const;
	});
}

/**
 * Terminalize obligations that ALREADY EXIST, creating none. This is the path every COMPLETING exit
 * takes — a tenant transfer, the kill switch, an emptied candidate set, or a finished batch — and
 * the difference from the function above is the whole point.
 *
 * §9.2(d) requires that a transfer "writes no ledger row under the stale tuple" while still
 * recording TENANT_CHANGED "on any rows". Both halves are satisfiable at once only by updating and
 * never inserting: an existing row was written when the tuple was still the project's and stays
 * consistent with its parent cycle, whereas a NEW row would attribute a fresh record to a tenant
 * that no longer owns the project — reintroducing, one function over, exactly the stale-tuple write
 * the delivery fence exists to prevent.
 *
 * A recipient with no row is not an unconfirmed obligation; it is an obligation that was never
 * created.
 *
 * It carries F5's cycle-ownership assertion, and it needs it for the reason the creating paths do:
 * the update is keyed on cycleId + channel, which names no tenant at all, so a stale, malformed or
 * version-skewed cycleId reaching here would flip ANOTHER tenant's unresolved rows to SKIPPED —
 * silently discharging obligations that tenant still needs done, and doing it terminally. F1's
 * FOR UPDATE half is deliberately NOT taken HERE: this function only ever moves rows to a terminal
 * state, so there is nothing for a concurrent transfer to corrupt and no reason for it to hold a
 * lock of its own. Its COMPLETING caller is a different matter and does hold one — the closing
 * transaction in the notification activity takes the project row FOR UPDATE before calling this, so
 * that it and a concurrent delivery are mutually exclusive. The caller that does not is the
 * already-terminal branch, which has no outcome to write and nothing to serialize against.
 *
 * A cycle that does not belong to this tenant is a no-op, matching F5's contract everywhere else in
 * this file: write nothing, say nothing, let the tenant that owns it resolve it.
 *
 * Takes an optional client so a COMPLETING caller can run this and its outcome write in ONE
 * transaction — for the SAME REASON activateCycleNotificationLifecycle takes one, though not in the
 * same way: that function's client is required and positional-first. Closing an obligation
 * is only justified by the completion it accompanies, so committing it separately means a lost
 * compare-and-swap leaves a discharged obligation under a cycle that was never resolved: the retry
 * reads that row as settled and the recipient is never notified. Defaults to the base client, which
 * is correct for a caller that has no completion to pair with.
 */
export async function terminalizeExistingDeliveriesAsSkipped(
	input: {
		cycleId: string;
		tenant: PublishingDeliveryTenant;
		channel: string;
		reason: PublishingDeliverySkipReason;
	},
	client: Prisma.TransactionClient = db,
): Promise<void> {
	if (!(await cycleBelongsToTenant(client, input.cycleId, input.tenant))) {
		return;
	}
	await client.publishingNotificationDelivery.updateMany({
		where: {
			cycleId: input.cycleId,
			channel: input.channel,
			deliveredAt: null,
			// DEFERRED IS SPARED, and this term is the difference between a hand-off and a
			// round trip to nowhere. A row the producer has just written carries
			// deliveredAt null and a status that is not SKIPPED, so WITHOUT this it
			// matches: the completing exit terminalizes the obligation the same attempt
			// created, a few lines later, and the cycle reports MAIL_NOT_CONFIGURED as
			// though the hand-off had happened.
			//
			// Nothing else notices. The row exists, its status is terminal, every count
			// agrees, and the cycle outcome is correct — only a test that reads the ledger
			// back AFTER the activity returns can tell. It was observed exactly that way
			// before this term was added.
			//
			// UNCONDITIONAL rather than caller-supplied, though a tenant move or a kill
			// switch genuinely does void a deferral. The drain answers that per row and at
			// the right time — tenancy and the kill switch are its first two gates, each
			// terminalizing with its own reason — so a voided obligation is discharged
			// within one tick rather than stranded, at the cost of living up to an hour
			// longer and occupying one page slot. A caller-supplied flag would be a SECOND
			// answer to "may this row be terminalized", which is the exact shape that put
			// DEFERRED, EXPIRED and FAILED inside a deny-list of one before (see
			// PUBLISHING_EMAIL_CLAIMABLE_STATUSES).
			//
			// Still a deny-list rather than the allow-list that would be better: SENT is
			// kept out by `deliveredAt: null` above rather than by status, and converting
			// that is a behaviour change to a shipped path with no failing case behind it.
			status: { notIn: ["SKIPPED", "DEFERRED"] },
		},
		data: {
			status: "SKIPPED",
			reason: input.reason,
			// Release the lease along with the obligation. A terminal row must never carry a
			// claim: every reader in THIS slice gates on `status` first and so is unaffected, but
			// 1C-2d's sweep decides re-claimability from lease expiry, and a SKIPPED row with a
			// live-looking claimedAt is exactly what would invite it to check the lease first.
			// A no-op for IN_APP rows, which never take a claim.
			claimedAt: null,
			claimToken: null,
			// lastAttemptAt is NOT cleared here either, and the omission is deliberate in both
			// places. Releasing a lease is a statement about ownership; the timestamp is a
			// statement about the outside world, and terminalizing an obligation does not unsend
			// a message. Clearing all three "for tidiness" is the tempting edit and it is the one
			// that reopens the duplicate hole.
		},
	});
}

/**
 * Takes the same optional client, so a caller deciding an outcome inside a transaction reads the
 * rows it just terminalized on that transaction's own snapshot rather than across a second
 * connection — which would both borrow a pool slot while the first is held and read state the
 * transaction may still roll back.
 */
export async function readPublishingDeliveryStates(
	input: {
		cycleId: string;
	},
	client: Prisma.TransactionClient = db,
): Promise<
	{
		recipientUserId: string;
		channel: string;
		status: string;
		deliveredAt: Date | null;
	}[]
> {
	return client.publishingNotificationDelivery.findMany({
		where: { cycleId: input.cycleId },
		select: {
			recipientUserId: true,
			channel: true,
			status: true,
			deliveredAt: true,
		},
	});
}

/**
 * The email lease, in milliseconds.
 *
 * It MUST exceed the notification proxy's `startToCloseTimeout` (currently "1 minute" — the
 * `notifyPublishingTopicsReady` proxy in publishing-suggestion-generation-workflow.ts; named by
 * symbol rather than by line, because a line reference to it rots), or an attempt can lose its own
 * claim while it is still inside the provider call, and two attempts then both send.
 *
 * How much room that leaves is a MARGIN, not a guarantee, and the difference is worth stating
 * rather than discovering. Under the retry policy on that proxy (5 attempts, 2s initial interval)
 * and the SDK's default `backoffCoefficient` of 2.0, attempt starts land at roughly
 * 0 / 62 / 126 / 194 / 270 seconds — so the fifth attempt begins about 30 s inside this 300 s
 * lease, not comfortably inside it. And a claim is not taken at attempt START: the activity walks its
 * recipients SEQUENTIALLY with a provider call per recipient, so recipient k's claim lands at
 * attempt-start plus the sum of every earlier recipient's latency.
 *
 * THAT WALK USED TO BE UNCAPPED, and 1C-2d-3b bounded it — which repairs this margin rather than
 * merely re-describing it. With at most PUBLISHING_NOTIFY_MAX_EMAILS_PER_ATTEMPT (25) sends per
 * attempt, k is bounded, so the LAST claim of an attempt lands about 25 x latency in: ~6 s at 250 ms
 * per send, comfortably inside the 30 s of headroom above. Roster size no longer spends this margin
 * for any roster the cap admits. Provider latency still can — at 1 s per send the same walk is 25 s
 * — and that is the trigger to cut the cap rather than to raise the timeout.
 *
 * Crossing the margin is a DESIGNED degradation, not an unprotected duplicate. A lease that lapses
 * mid-flight lets a later attempt re-take the row, and the SECOND layer catches the resend: the
 * provider's idempotency key, whose horizon is PUBLISHING_EMAIL_PROVIDER_DEDUPE_WINDOW_MS below.
 * Every in-workflow retry lands minutes apart, far inside that window, so that layer is real here.
 *
 * The number is also a comparison between two APPLICATION clocks rather than an absolute 300 s:
 * `claimedAt` is stamped by the CLAIMING process and `leaseCutoff` is derived from the EVALUATING
 * process's `now`, so across two workers with clock skew s a fast-running worker sees an effective
 * lease of LEASE_MS − s and can re-grant early. NTP-synced containers keep s at milliseconds, and
 * the injectable `now` the tests need rules out reading the clock in SQL — but do not read the
 * constant as stronger than that. That argument holds for the LEASE, which is a margin. It does not
 * hold for `expiresAt`, which is a deadline whose wrong answer is mail sent after it — the claim's
 * expiry term reads the database clock inside the locking statement (1C-2d-2a Decision 33).
 *
 * These FOUR numbers are ONE budget: changing `maximumAttempts`, the activity's
 * `startToCloseTimeout`, PUBLISHING_NOTIFY_MAX_EMAILS_PER_ATTEMPT, or this constant needs
 * re-checking against the other three, because only their relation means anything. (It was three
 * until 1C-2d-3b; the cap joined them because it is what converts "how long does an attempt take"
 * from a property of the roster into a property of the four numbers.)
 *
 * A CRASHED attempt is the remaining case, and inside the margin it is not re-taken within this
 * workflow. That row stays SENDING and unconfirmed, the activity rejects on every remaining
 * attempt, and the cycle is left READY with notificationOutcome PENDING — which is the residue
 * parent §9.7 designates for 1C-2d's sweep, not a defect to work around here. A KNOWN failure is
 * different and does recover in-workflow: recordPublishingEmailFailure releases the claim, so the
 * next attempt re-takes the row at once.
 */
export const PUBLISHING_EMAIL_LEASE_MS = 5 * 60_000;

/**
 * How long the mail provider remembers an idempotency key. Resend: 24 hours.
 *
 * This is the horizon of the SECOND layer of duplicate protection, and it is not durable. Inside
 * one workflow every retry lands within minutes, so the key covers them and the layer is real.
 * Beyond this window it is gone: re-sending an obligation older than this hands the provider a
 * key it has forgotten, and the recipient gets a second copy.
 *
 * Exported because the only path that can cross the window is delayed recovery — the re-drive
 * script today, 1C-2d's sweep later — and both need to compare against it rather than each
 * hard-coding a number that would drift from this one.
 */
export const PUBLISHING_EMAIL_PROVIDER_DEDUPE_WINDOW_MS = 24 * 60 * 60_000;

/**
 * How many delivery attempts an obligation gets before it is FAILED, terminally.
 *
 * A BOUND, not a retry-forever escape hatch: parent §9.9 is explicit that both
 * the attempt bound and the 14-day expiry are terminal, and that no row in a
 * terminal state is ever re-queued.
 *
 * Exported and shared because several mechanisms must agree on it and they live
 * in different slices: the deferral claim increments and tests it inside one
 * atomic conditional UPDATE, and both at-bound discharges terminalize rows that
 * reached it — all three in 1C-2d-2b. A bound one side enforces and the other
 * copies is a bound that drifts, and the drift is silent, because the smaller of
 * the two simply wins and nothing reports which.
 *
 * 1C-2d-2a, which lands first, uses it only to EXCLUDE: its lease reclaim
 * refuses to touch a row at the bound, so the boundary is a passing test rather
 * than an absence. Nothing in that slice increments the column — this is the
 * bound's only reader there.
 */
export const PUBLISHING_DELIVERY_ATTEMPT_BOUND = 5;

/**
 * How long a deferred email obligation stays live.
 *
 * §9.9 gives the deferral lifecycle's two terminals as a PAIR — 14 days of expiry and 5
 * attempts — and the second of them is PUBLISHING_DELIVERY_ATTEMPT_BOUND directly above.
 * They are declared together because they are the only two ways an obligation ends
 * without being sent, and a reader deciding whether a backlog is healthy needs both
 * numbers at once.
 *
 * 14 days is long enough for an operator to notice MAIL_NOT_CONFIGURED and set the key
 * across a weekend, a holiday or a period of leave, and short enough that the digest
 * still describes something current and the topics it points at have not moved.
 *
 * WRITTEN from the caller's clock, never READ as one. The decision about whether an
 * obligation has expired is made against the DATABASE clock inside
 * publishingEmailClaimableSql; only the stamped value comes from here. That asymmetry is
 * what lets a test move time without moving the predicate, and it is the same split
 * claimedAt already uses.
 */
export const PUBLISHING_DEFERRAL_WINDOW_MS = 14 * 24 * 60 * 60_000;

/**
 * The statuses a claim may TAKE OVER.
 *
 * SENDING  a dead lease may be re-taken; that is the retry path.
 * FAILED   a recorded failure released its claim and may be owed another attempt.
 * DEFERRED an obligation inside its expiry (1C-2d-3 onwards).
 *
 * Everything else is terminal: SENT, SKIPPED, EXPIRED. An allow-list rather than
 * a deny-list, because `status: { not: "SKIPPED" }` admitted DEFERRED, EXPIRED,
 * FAILED and SENT, and only `deliveredAt: null` kept SENT out — which left
 * EXPIRED, whose deliveredAt is null, claimable. A deny-list of one is how that
 * happened, and a seventh status would do it again.
 *
 * BUT A STATUS LIST IS NOT A CLAIM PREDICATE. It answers WHICH statuses may be
 * claimed; it says nothing about whether THIS ROW is still claimable. Use
 * publishingEmailClaimableSql below — never this list on its own.
 */
export const PUBLISHING_EMAIL_CLAIMABLE_STATUSES = [
	"SENDING",
	"FAILED",
	"DEFERRED",
] as const;

/**
 * THE claim predicate. One question — IS THIS ROW STILL OWED, AND FREE TO TAKE?
 * — expressed once, so status, expiry, lease and attempt count cannot drift into
 * four separate answers.
 *
 *   deliveredAt IS NULL           an already-delivered row is not owed.
 *   status IN (claimable)         terminal states are unclaimable.
 *   attemptCount < BOUND          a retryable status at the bound is terminal in
 *                                 fact even though its status still says FAILED:
 *                                 recordPublishingEmailFailure preserves
 *                                 expiresAt and never touches attemptCount, so
 *                                 status alone cannot tell the two apart.
 *   expiresAt IS NULL OR         a LEGACY null-expiry primary-path row is still
 *     expiresAt > clock_timestamp() owed — that is the retry path this claim has
 *                                 always served. A DATED obligation past its own
 *                                 date is not owed, whatever its status: the
 *                                 sweep can commit a row as DEFERRED with an
 *                                 expiry ALREADY PAST, and a dead-leased SENDING
 *                                 row can sit past its deadline until the next
 *                                 tick.
 *   claimedAt IS NULL OR < cutoff nobody else holds it right now.
 *
 * THE EXPIRY TERM READS THE DATABASE CLOCK AND THE LEASE TERM DOES NOT, AND THAT
 * ASYMMETRY IS DELIBERATE (1C-2d-2a Decision 33). `now` is captured OUTSIDE
 * db.$transaction, and this transaction's first statement takes the project row
 * FOR UPDATE — so an unbounded wait sits between the two. Measured with the lock
 * held across the expiry: on the caller's clock the claim takes a row 3.3 s past
 * its deadline; on clock_timestamp() the same interleaving refuses it. A LEASE is
 * a margin backed by a second layer (the provider's idempotency key) and keeps
 * its injectable clock so tests can move time. An EXPIRY is a deadline whose
 * wrong answer is mail sent after it.
 *
 * clock_timestamp(), not now(): now() is transaction-START, which freezes before
 * the lock wait and reproduces the same staleness at a smaller scale.
 *
 * A SQL FRAGMENT RATHER THAN A WhereInput, and that is forced: no Prisma
 * where-input can express clock_timestamp(). Omit `leaseCutoffParam` and the
 * lease term is absent — that is the ONE switch, used by the refusal classifier
 * (a row still owed but not taken is HELD; a row not owed at all is
 * ALREADY_TERMINAL) and by the re-drive duplicate guard (Decision 34).
 *
 * 1C-2d-2b's atomic claim must IMPORT this. It is the slice that starts writing
 * attemptCount, which is the term with no producer today.
 */
export function publishingEmailClaimableSql(input: {
	/**
	 * e.g. "$2". Omit to drop the lease term entirely — which changes WHICH HALF of the
	 * two-part question above the fragment asks, and the two halves have different answer
	 * sets. WITH the term: still owed AND free to take right now. WITHOUT it: still owed,
	 * whoever happens to be holding it. A live-leased row satisfies the second and fails the
	 * first, so a caller that omits the term must not call its result set "claimable" — the
	 * word belongs to the other form, and the re-drive guard's comment has now been wrong
	 * about this twice.
	 */
	leaseCutoffParam?: string;
}): string {
	const statuses = PUBLISHING_EMAIL_CLAIMABLE_STATUSES.map(
		(status) => `'${status}'`,
	).join(", ");
	const lease = input.leaseCutoffParam
		? `\n   AND ("claimedAt" IS NULL OR "claimedAt" < ${input.leaseCutoffParam}::timestamp)`
		: "";
	// AT TIME ZONE 'UTC' explicitly: the column is timestamp WITHOUT time zone
	// and Prisma writes UTC into it, so comparing against a timestamptz would
	// otherwise convert through the server's TimeZone GUC — configuration this
	// code does not control.
	return `"deliveredAt" IS NULL
   AND "status" IN (${statuses})
   AND "attemptCount" < ${PUBLISHING_DELIVERY_ATTEMPT_BOUND}
   AND ("expiresAt" IS NULL OR "expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC'))${lease}`;
}

/**
 * A verdict rather than a boolean, because the four failures mean different things to the caller
 * and only one of them is retryable:
 *
 *   CLAIMED         this attempt owns the row for one lease. Carries the token every later write
 *                   against the row must present, AND the row's previous `lastAttemptAt` — read
 *                   inside this transaction, under the project lock, immediately before being
 *                   overwritten.
 *
 *                   Returning it here rather than letting the caller read it first is not a
 *                   convenience. A read taken before the claim is a snapshot with no bound on its
 *                   age: an activity that timed out KEEPS RUNNING, so it can read null, stall
 *                   while a retry claims, sends, fails and releases the lease, then resume a day
 *                   later, take the now-free row, and send again — evaluating its own stale null
 *                   and emitting no warning. That is precisely the ambiguous-acceptance case the
 *                   timestamp exists to surface, and the re-drive guard cannot cover it because
 *                   this is an in-workflow attempt. Reading it under the claim's own lock makes
 *                   the value and the ownership the same decision.
 *   ALREADY_TERMINAL delivered, or cancelled, or expired, or out of attempts, or the cycle is
 *                   closed. Do not act.
 *   HELD            another live attempt owns it. Not an error, and NOT terminal — the row is
 *                   still owed, so the caller must leave it counted as unconfirmed.
 *   TENANT_CHANGED  the project moved, became ineligible, or does not own this cycle.
 *   FAILED          the claim transaction itself threw. Retryable.
 */
export type EmailClaimResult =
	| {
			outcome: "CLAIMED";
			claimToken: string;
			/** The row's `lastAttemptAt` BEFORE this claim overwrote it; null on a first attempt. */
			previousAttemptAt: Date | null;
	  }
	| { outcome: "ALREADY_TERMINAL" }
	| { outcome: "HELD" }
	| { outcome: "TENANT_CHANGED" }
	| { outcome: "FAILED" };

/**
 * Take the EMAIL row for one recipient, under a lease.
 *
 * A CREATING path, so it clears the module's full fence — F1's `FOR UPDATE` re-read of the
 * project's current row, then F5's cycle-ownership assertion and the cycle's terminality — in
 * exactly the order `creationFenceVerdict` already defines. Nothing new is invented here; the
 * fence is the one every other creating path in this file uses, and the whole reason email can be
 * added without re-arguing tenancy.
 *
 * The claim is a CONDITIONAL UPDATE, never a read followed by a write. Reading `deliveredAt IS
 * NULL` and then writing is an observation, not exclusive ownership: a Temporal
 * `startToCloseTimeout` does not stop the attempt that timed out, so a slow attempt can still be
 * inside the provider call when its retry reads the same row, and both would send. Proceed only
 * if the update affected a row.
 *
 * The token is a fresh UUID per claim, never an attempt number: 1C-2d's reconciler claims these
 * same rows from a different activity with its own numbering, and two sequences that are not
 * comparable make a fence that is not a fence (parent §11.3).
 */
export async function claimPublishingEmailDelivery(input: {
	cycleId: string;
	tenant: PublishingDeliveryTenant;
	recipientUserId: string;
	now?: Date;
}): Promise<EmailClaimResult> {
	const now = input.now ?? new Date();
	const leaseCutoff = new Date(now.getTime() - PUBLISHING_EMAIL_LEASE_MS);
	const claimToken = randomUUID();

	try {
		return await db.$transaction(async (tx) => {
			const fence = await creationFenceVerdict(
				tx,
				input.cycleId,
				input.tenant,
			);
			if (fence === "TENANT_CHANGED") {
				return { outcome: "TENANT_CHANGED" } as const;
			}
			if (fence === "CYCLE_TERMINAL") {
				return { outcome: "ALREADY_TERMINAL" } as const;
			}

			const existing = await tx.publishingNotificationDelivery.findUnique(
				{
					where: {
						cycleId_recipientUserId_channel: {
							cycleId: input.cycleId,
							recipientUserId: input.recipientUserId,
							channel: "EMAIL",
						},
					},
					// lastAttemptAt rides along in the existence read this path already issues, so the
					// previous value is captured under the fence's project lock at no extra cost.
					select: {
						id: true,
						status: true,
						deliveredAt: true,
						lastAttemptAt: true,
					},
				},
			);
			const previousAttemptAt = existing?.lastAttemptAt ?? null;

			if (existing) {
				// RAW, because no Prisma where-input can express
				// clock_timestamp(). tx.$queryRaw is already how this file takes
				// the project lock (lockPublishingProjectRow) and how the fence
				// reads (currentTenantMatches), so this is the module's existing
				// idiom rather than a new one.
				//
				// `claimedAt` and `lastAttemptAt` are still written from the
				// injectable application `now`; only the DECISION moved to the
				// database clock. Keeping the written values on the caller's
				// clock is what lets a test move time, and it is also what keeps
				// the lease comparison a comparison between two application
				// clocks, exactly as PUBLISHING_EMAIL_LEASE_MS describes.
				const claimed = await tx.$queryRawUnsafe<Array<{ id: string }>>(
					`UPDATE "publishing_notification_delivery"
					    SET "status" = 'SENDING', "claimedAt" = $2, "claimToken" = $3,
					        "lastAttemptAt" = $2, "reason" = NULL, "errorMessage" = NULL
					  WHERE "id" = $1
					    AND ${publishingEmailClaimableSql({ leaseCutoffParam: "$4" })}
					  RETURNING "id"`,
					existing.id,
					now,
					claimToken,
					leaseCutoff,
				);
				if (claimed.length === 0) {
					// The three situations this branch used to conflate, told
					// apart at last — and by the SAME predicate, minus the one
					// term that is about who holds the row right now.
					//
					// still owed  another live attempt owns it. HELD.
					// not owed    delivered, cancelled, expired, or attempt-
					//             exhausted. ALREADY_TERMINAL.
					//
					// The shipped comment here already named this move:
					// "Revisit if a claimer appears that does NOT hold the
					// project lock — 1C-2d's reconciler is the candidate.
					// Telling the three apart is then a re-read inside this
					// branch, not a redesign." This is that re-read.
					//
					// A VERDICT, not a guarantee: it runs only after the update
					// has already refused, and its job is to give the caller
					// ALREADY_TERMINAL rather than HELD, because HELD says
					// "still owed" and an expired or attempt-exhausted
					// obligation is not. SELECT … LIMIT 1 rather than a count,
					// because the question is existence and a count on a primary
					// key that can only ever return 0 or 1 is a count in name
					// only.
					//
					// TWO clock_timestamp() READS, not one: the UPDATE above evaluated the
					// expiry term at its instant, and this SELECT evaluates it again — strictly
					// LATER, because the two statements are not simultaneous even inside the
					// same transaction.
					//
					// WHAT CAN MOVE IN THAT GAP is more than the clock, and the project lock does
					// not narrow it to the clock. The lock excludes concurrent CLAIMS — every
					// claimer takes it first — but it does not exclude concurrent WRITES:
					// `confirmPublishingEmailDelivery` and `recordPublishingEmailFailure` are
					// bare `updateMany`s against this row on the pooled client, holding no lock at
					// all, and either can commit between these two statements while this
					// transaction is mid-flight. So three transitions are live here, not one:
					//
					//   the clock crosses "expiresAt"    HELD becomes ALREADY_TERMINAL
					//   the winner CONFIRMS  SENDING -> SENT, deliveredAt set. Ditto.
					//   the winner FAILS     SENDING -> FAILED with claimedAt and claimToken
					//                        nulled. FAILED is a CLAIMABLE status and the lease is
					//                        gone, so the row reads as still owed:
					//                        ALREADY_TERMINAL becomes HELD.
					//
					// The verdict is therefore NOT monotone toward terminal, and an earlier
					// version of this comment claiming it was — on the strength of a lock that
					// stops claims rather than writes — was wrong in both directions. The
					// concurrency case in packages/temporal/__tests__/publishing-email-delivery.test.ts
					// is what pins it: it stages exactly this window, and it caught the claim
					// being read as terminal by a loser that had read it live one statement
					// earlier.
					//
					// SAFE IN EVERY ONE OF THEM, and not because the answer is stable — because
					// this branch runs only after the claim was already refused. It cannot return
					// CLAIMED, so no re-read here can turn a refusal into a send, and the only
					// question left is which true statement to report. Each answer is honest for
					// the state that produced it: ALREADY_TERMINAL for a row delivered or expired
					// in the gap, HELD for a row whose lease was just released — that obligation
					// really is still owed, and the caller keeping it counted as unconfirmed is
					// exactly the behaviour a released lease calls for.
					const stillOwed = await tx.$queryRawUnsafe<
						Array<{ id: string }>
					>(
						`SELECT "id" FROM "publishing_notification_delivery"
						  WHERE "id" = $1 AND ${publishingEmailClaimableSql({})}
						  LIMIT 1`,
						existing.id,
					);
					return stillOwed.length > 0
						? ({ outcome: "HELD" } as const)
						: ({ outcome: "ALREADY_TERMINAL" } as const);
				}
			} else {
				await tx.publishingNotificationDelivery.create({
					data: {
						cycleId: input.cycleId,
						projectId: input.tenant.projectId,
						organizationId: input.tenant.organizationId,
						userId: input.tenant.userId,
						recipientUserId: input.recipientUserId,
						channel: "EMAIL",
						status: "SENDING",
						claimedAt: now,
						claimToken,
						lastAttemptAt: now,
					},
				});
			}

			return {
				outcome: "CLAIMED",
				claimToken,
				previousAttemptAt,
			} as const;
		});
	} catch (error) {
		if (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === "P2002"
		) {
			// A row appeared under this triple between the read and the insert. The loser of that
			// race did NOT claim anything, so HELD is the honest answer for the common case: the
			// row is owed, someone else holds it, and this attempt must not treat it as
			// discharged.
			//
			// Same three-way ambiguity as the `count === 0` branch above, with the same
			// resolution. The winner could have been another claim (HELD is right), or
			// recordPublishingDeliverySkip's create, which commits a SKIPPED row and for which
			// ALREADY_TERMINAL would be the honest verdict. Answering HELD for the second is safe
			// for the same two reasons: it UNDER-claims, so an unconfirmed row is never mistaken
			// for a delivered one, and the next attempt's findUnique reads the committed SKIPPED
			// and returns ALREADY_TERMINAL itself.
			return { outcome: "HELD" };
		}
		console.warn(
			"[publishing-notification-delivery/claimPublishingEmailDelivery] claim failed",
			{
				projectId: input.tenant.projectId,
				cycleId: input.cycleId,
				recipientUserId: input.recipientUserId,
				channel: "EMAIL",
				error: describeError(error),
			},
		);
		return { outcome: "FAILED" };
	}
}

/**
 * The result of recording a set of deferred email obligations.
 *
 * `created` is what the DATABASE inserted, not the size of the input: they differ on
 * every retry of an already-deferred cycle, and the caller logs the number to tell a
 * fresh deferral from a repeat.
 */
export type DeferEmailDeliveriesResult =
	| { outcome: "DEFERRED"; created: number }
	| { outcome: "TENANT_CHANGED" }
	| { outcome: "CYCLE_TERMINAL" };

/**
 * Record the email-only recipients' obligations as DEFERRED, so that a mail-key outage
 * costs a DELAY rather than the notification (§9.6).
 *
 * ONE STATEMENT FOR THE WHOLE SET, and that is a requirement rather than a tidy-up. The
 * caller runs under a 1-minute startToCloseTimeout with NO heartbeat, on the path taken
 * exactly when the deployment is already unwell; a per-recipient INSERT loop would put a
 * second unbounded sequential walk there. (The email loop beside it WAS the first such walk;
 * 1C-2d-3b capped it, which makes an unbounded one here the only one left rather than the
 * second of two.)
 * Nothing here is per-recipient anyway: the fence is per CYCLE, and every row carries the
 * same tuple, the same expiry and the same zero attempt count.
 *
 * A DEFERRAL IS NOT A CLAIM. `claimedAt` and `claimToken` stay null, which is what leaves
 * the lease fence untouched and lets reconciliation claim the row normally when the time
 * comes — the distinction §9.9 draws against the "unsendable claim" objection that would
 * otherwise rule out writing rows for a configuration fault at all.
 *
 * CREATE-ONCE VIA skipDuplicates, over the unique triple that already prevents a second
 * obligation for the same person and cycle. A retried attempt that still has no key
 * re-runs this and writes NOTHING — not "writes and overwrites": an existing row's
 * attemptCount, its expiresAt and any lease a drain attempt has taken all survive
 * untouched. Without skipDuplicates the second attempt throws P2002; with an upsert it
 * would reset expiresAt every attempt, silently extending a 14-day obligation for as long
 * as the outage lasts.
 *
 * THE PROJECT ROW LOCK COMES FROM THE FENCE, and an earlier revision of this function took
 * it a second time explicitly, on a premise that was wrong. That premise — written into
 * this comment and only refuted by a delete-a-guard run — was that creationFenceVerdict
 * "only READS", leaving a window in which a concurrent closing transaction could commit a
 * terminal cycle between the fence and the insert.
 *
 * It does not only read. Its FIRST statement is currentTenantMatches, which is
 * `SELECT ... FROM "project" WHERE "id" = $1 FOR UPDATE` — the same row, the same mode,
 * held for the rest of the transaction. So the mutual exclusion this writer needs is
 * already there, the window never existed, and the explicit call was a second acquisition
 * of a lock this transaction already held: one round trip for nothing.
 *
 * That is also why claimPublishingEmailDelivery does not take it either, and why
 * closeObligationsAndComplete DOES — that exit does not go through the fence, so it has to
 * take the row itself. Lock order is unchanged and acyclic in every case: project row,
 * then the ledger.
 */
export async function deferPublishingEmailDeliveries(input: {
	cycleId: string;
	tenant: PublishingDeliveryTenant;
	recipientUserIds: string[];
	now?: Date;
}): Promise<DeferEmailDeliveriesResult> {
	if (input.recipientUserIds.length === 0) {
		// No obligation to record, so nothing to lock and nothing to fence. This is the
		// COMMON case — every email recipient also gets a bell — and returning before the
		// transaction keeps it off the project row lock, which every claim contends for.
		return { outcome: "DEFERRED", created: 0 };
	}

	const now = input.now ?? new Date();
	const expiresAt = new Date(now.getTime() + PUBLISHING_DEFERRAL_WINDOW_MS);

	return await db.$transaction(async (tx) => {
		// The fence's first statement takes the project row FOR UPDATE; see the note above
		// for why this function does not take it again.
		const fence = await creationFenceVerdict(
			tx,
			input.cycleId,
			input.tenant,
		);
		if (fence === "TENANT_CHANGED") {
			// No row is written under a stale tuple — §9.2(d)'s requirement, and the same
			// answer every creating path in this file gives.
			return { outcome: "TENANT_CHANGED" } as const;
		}
		if (fence === "CYCLE_TERMINAL") {
			// Another attempt has already resolved this cycle. There is nothing left to
			// hand off, and creating an obligation under a terminal cycle would be the
			// stranded row the whole lifecycle exists to prevent.
			return { outcome: "CYCLE_TERMINAL" } as const;
		}

		const { count } = await tx.publishingNotificationDelivery.createMany({
			data: input.recipientUserIds.map((recipientUserId) => ({
				cycleId: input.cycleId,
				projectId: input.tenant.projectId,
				organizationId: input.tenant.organizationId,
				userId: input.tenant.userId,
				recipientUserId,
				channel: "EMAIL",
				status: "DEFERRED",
				expiresAt,
				// attemptCount is deliberately NOT set. The column is NOT NULL DEFAULT 0
				// (1C-2d-1a) and letting the default apply keeps ONE writer of that zero;
				// a second literal here is the shape that drifts when the default moves.
			})),
			skipDuplicates: true,
		});

		return { outcome: "DEFERRED", created: count } as const;
	});
}

/**
 * Refuse a falsy `claimToken` BEFORE the query runs, in both token-fenced writers below.
 *
 * The reason is a Prisma behaviour rather than a style preference, and it was confirmed by running
 * it rather than assumed: **Prisma DROPS an `undefined` where-predicate** — it treats the key as
 * ABSENT rather than as unmatchable, so `where: { id: undefined }` matches every row. A token that
 * arrives undefined therefore does not MISS; it deletes the token condition and leaves the fence as
 * `cycleId + recipientUserId + channel + status`, which matches whichever attempt currently owns
 * the row. The failure mode is a WIDENED fence, not an empty result.
 *
 * That is why this throws rather than returning "LOST". Both consequences are silent otherwise: the
 * confirming write would stamp a delivery for a caller holding no claim, and the failing write
 * would additionally RELEASE the owner's lease, letting the next attempt send while the previous
 * one is still inside the provider call. A thrown error in a Temporal activity retries and
 * eventually surfaces; a widened `where` sends a duplicate email and reports success.
 *
 * Unreachable through the typed surface today — `EmailClaimResult` carries `claimToken` only on its
 * CLAIMED branch and TypeScript narrows it. Task 7 is an ACTIVITY, where inputs arrive as
 * deserialized JSON and the compiler is not in the loop, which is the whole reason this is a
 * RUNTIME check. This module validates no other input, and that inconsistency is accepted: the
 * consequence here is a duplicate send rather than a wrong record.
 */
function requireClaimToken(claimToken: string, caller: string): void {
	if (!claimToken) {
		throw new Error(
			`${caller}: a claimToken is required — an absent one would widen the fence rather than match nothing`,
		);
	}
}

/**
 * Record that the provider accepted the message, fenced on the claim.
 *
 * TWO conditions, and both are load-bearing:
 *   1. `claimToken` matches — an attempt whose lease expired mid-flight cannot mark delivered a
 *      message that the succeeding attempt actually sent;
 *   2. `status: "SENDING"` — a cancelled row is SKIPPED, and cancellation sets the row terminal
 *      REGARDLESS of any live token (§9.2(d)). Cancelling does two things and not a third: it
 *      prevents a future claim and it prevents the row ever recording deliveredAt. It does not
 *      recall a message already handed to the provider — nothing can — and the ledger's job is
 *      to never assert a delivery this design does not stand behind.
 *
 * No tenant fence, and that is the module's rule rather than an oversight: this path only UPDATES
 * a row that claimPublishingEmailDelivery created under the full fence. The token is what carries
 * the authorization forward — an unguessable value issued inside that fence.
 *
 * A confirmed row DELIBERATELY KEEPS `claimedAt` and `claimToken`. It is the one terminal state
 * that does — both terminalizing writers above release theirs — and the asymmetry is recorded here
 * rather than tidied away, because it is real: the surviving token is what lets a LATE FAILURE be
 * refused by IDENTITY rather than by timing. The attempt that confirmed can come back, a retried
 * activity re-running its recipient loop, presenting the very token this row still holds; the only
 * thing that can refuse it is `status`, and that predicate is TESTABLE precisely because the token
 * still matches. Clearing the token here would make the refusal accidental — no token, no match —
 * and delete the case "a late failure cannot overwrite a delivery its own token confirmed" pins.
 *
 * The cost is that a SENT row carries lease fields that no longer mean "someone is sending", so
 * 1C-2d must read `status` BEFORE the lease. Every reader in this slice already does.
 *
 * `cycleId` / `recipientUserId` / `channel` are not merely redundant scoping beside the token.
 * That triple IS the unique index publishing_notification_delivery_cycle_recipient_channel_key,
 * and `claimToken` has no index at all — they are what makes this write an index lookup instead of
 * a sequential scan taking row locks across the table. Do not delete them as redundant.
 */
export async function confirmPublishingEmailDelivery(input: {
	cycleId: string;
	recipientUserId: string;
	claimToken: string;
}): Promise<"CONFIRMED" | "LOST"> {
	requireClaimToken(input.claimToken, "confirmPublishingEmailDelivery");
	const { count } = await db.publishingNotificationDelivery.updateMany({
		where: {
			cycleId: input.cycleId,
			recipientUserId: input.recipientUserId,
			channel: "EMAIL",
			claimToken: input.claimToken,
			status: "SENDING",
		},
		data: {
			status: "SENT",
			deliveredAt: new Date(),
			reason: null,
			errorMessage: null,
		},
	});
	// LOST conflates THREE situations, and the conflation is safe for the reason the claim's
	// `count === 0` branch spells out for HELD — so it is spelled out here too rather than left as
	// one word:
	//
	//   lease expired  a newer attempt re-claimed the row and holds a different token.
	//   cancelled      the row was terminalized. Note this is now refused by the TOKEN predicate
	//                  and not the status one: terminalizing RELEASES claimToken, so the caller's
	//                  token no longer matches anything.
	//   already SENT   this row was confirmed before — by this attempt, retried.
	//
	// All three demand the SAME caller behaviour: this attempt does not own the row, so it must not
	// report its own send as recorded and must stop acting on this recipient. The error is in the
	// UNDER-claiming direction by construction — a delivery is never asserted on a row this
	// attempt does not own — which is the direction that cannot corrupt the ledger.
	return count > 0 ? "CONFIRMED" : "LOST";
}

/**
 * Record a KNOWN send failure and RELEASE the claim.
 *
 * Releasing is the deliberate half. A failure whose outcome we know — `sendEmail` returned false,
 * a template render threw — is not the ambiguous-commit case the lease exists for, so holding the
 * lease afterwards would make the next attempt wait one full lease to retry something we already
 * know did not happen. Clearing `claimedAt` and `claimToken` lets the very next attempt re-take
 * the row, which is where nearly all of this design's in-workflow recovery comes from.
 *
 * Re-sending after a `false` is safe because `sendEmail` forwards `idempotencyKey` to Resend
 * (parent D20): if the provider did in fact accept the first one, the retry collapses into it.
 * Without that key this release would be a duplicate generator, which is why the key is called
 * load-bearing in packages/mail/src/provider/index.ts.
 *
 * That safety has a horizon, and it is short: Resend retains an idempotency key for 24 HOURS.
 * The retry this release enables happens within seconds, so it is covered. A recovery run a day
 * later is not — see PUBLISHING_EMAIL_PROVIDER_DEDUPE_WINDOW_MS above and the re-drive script's
 * age guard, which is where that case is handled rather than silently re-sent.
 *
 * FAILED, never SKIPPED: FAILED means "we tried and it did not work, try again"; SKIPPED means
 * "we must not try". Collapsing the two either mails a former member or spins the activity until
 * its budget is exhausted over work it can never discharge.
 *
 * Fenced on the token for the same reason the confirmation is: a late attempt must not stamp its
 * own failure over a newer attempt's live claim, which would release a lease it does not hold.
 *
 * `cycleId` / `recipientUserId` / `channel` carry the same second job they do on the confirming
 * write: that triple IS the unique index publishing_notification_delivery_cycle_recipient_channel_key
 * and `claimToken` has none, so they are what keeps this an index lookup rather than a sequential
 * scan taking row locks across the table. Not redundant scoping; do not delete them.
 */
export async function recordPublishingEmailFailure(input: {
	cycleId: string;
	recipientUserId: string;
	claimToken: string;
	reason: PublishingEmailFailureReason;
	errorMessage?: string;
}): Promise<"RECORDED" | "LOST"> {
	requireClaimToken(input.claimToken, "recordPublishingEmailFailure");
	const { count } = await db.publishingNotificationDelivery.updateMany({
		where: {
			cycleId: input.cycleId,
			recipientUserId: input.recipientUserId,
			channel: "EMAIL",
			claimToken: input.claimToken,
			status: "SENDING",
		},
		data: {
			status: "FAILED",
			reason: input.reason,
			// `|| null`, not `?? null`. An empty provider message is not nullish, so `??` would
			// store "" while an absent message stores null — two representations of nothing in a
			// column 1C-2d reads. One representation, and it is null.
			errorMessage: input.errorMessage?.slice(0, 1000) || null,
			claimedAt: null,
			claimToken: null,
			// lastAttemptAt is CONSPICUOUSLY ABSENT and must stay that way. This function releases
			// the LEASE, not the historical fact that a message may already have reached the
			// provider — `sendEmail` returns false for a provider error that can arrive after
			// acceptance. Clearing it here would make a FAILED row read as never-attempted, and
			// every age check downstream would then re-send past the provider's dedupe window
			// believing it was the first try.
		},
	});
	// The same three-way conflation as the confirming write, and safe for the same reason: a newer
	// attempt re-claimed the row (different token), the row was terminalized (the token was
	// released, so the TOKEN predicate refuses it), or the row was already confirmed SENT.
	//
	// Every one of them means this attempt does not own the row, and the required behaviour is
	// identical: record nothing, release nothing, treat the row as unconfirmed. The direction of
	// the error matters more here than on the confirming write — LOST UNDER-claims, so the worst
	// case is a lease left held one extra lease-length, which 1C-2d reconciles. The opposite error
	// releases a lease this attempt never held, and that one sends a second email.
	return count > 0 ? "RECORDED" : "LOST";
}
