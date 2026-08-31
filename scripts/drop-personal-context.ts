#!/usr/bin/env npx tsx
/**
 * Drop personal-workspace data, per the 2026-08-25 ruling.
 *
 * TWO PHASES, and the split is the whole design.
 *
 * The first shape of this job walked users and asked all 192 personal-bearing
 * models about each one. That is 183,000 count queries for a thousand users and
 * nine million for fifty thousand, before a single delete — hours of held
 * connection with no way to resume from the middle. The per-user shape was only
 * ever needed for the three things that are inherently per-user; the relational
 * rows are not among them.
 *
 *   Phase A, per user: cancel subscriptions at the payment provider, delete
 *   objects under the user's storage prefix, delete their vector points. Three
 *   operations each, and none can be expressed as one bulk statement — a
 *   subscription is cancelled one at a time, a storage prefix is one user's, a
 *   vector filter names a user.
 *
 *   Phase B, per model: delete the relational rows in batches, one pass per
 *   model. 192 passes total rather than 192 per person.
 *
 * Phase A finishes for everyone before Phase B starts. The order is the point:
 * deleting rows while a subscription still bills, or while files still sit in
 * the bucket, is the half-success this job exists to avoid.
 *
 * A user refused in Phase A is excluded from Phase B by id, so a bulk delete
 * cannot quietly take the rows of someone whose subscription could not be
 * cancelled or whose files could not be reached.
 *
 * Deletes run in batches of ids rather than one statement per model, so a large
 * table does not hold locks for the length of its own deletion, and an
 * interrupted run resumes by simply being run again.
 *
 * The hazards the surface map lists are what shape it:
 *
 *   A purchase row carries the provider's customer and subscription
 *   identifiers. Deleting it removes our record and nothing else.
 *   Files are keyed by tenant, so rows without objects leaves the user's
 *   content in the bucket after every trace of it left the database.
 *   Personal embeddings share one collection with every other user's.
 *   Two tables encode personal as an empty string, not null.
 *   `audit_log` permits DELETE only with a session variable set in the same
 *   transaction, and permits no UPDATE at all.
 *
 * DRY RUN BY DEFAULT. REFUSES RATHER THAN SKIPS — a phase that cannot complete
 * leaves that user out of the deletion entirely and says why, because a drop
 * that reports success while content survives is worse than one that stops.
 *
 * Usage:
 *   pnpm exec tsx scripts/drop-personal-context.ts --all
 *   pnpm exec tsx scripts/drop-personal-context.ts --user <id>
 *   pnpm exec tsx scripts/drop-personal-context.ts --all --apply
 *   pnpm exec tsx scripts/drop-personal-context.ts --all --apply --cancel-subscriptions
 *   pnpm exec tsx scripts/drop-personal-context.ts --all --apply --batch 500
 *   pnpm exec tsx scripts/drop-personal-context.ts --all --apply --drop-audit
 */

import { db } from "@repo/database";
import {
	auditLogWhere,
	delegateFor,
	personalBearingModels,
	personalWhere,
	withOwner,
} from "./lib/personal-context-models";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const cancelSubscriptions = args.includes("--cancel-subscriptions");
/**
 * Deleting audit rows is the one step here that suspends a tamper-evidence
 * trigger, and the one whose predicate cannot be made exactly right — see the
 * audit branch of Phase B. It therefore takes its own switch rather than
 * riding on `--apply`, so an operator who wants the rest of the drop does not
 * get this by not knowing about it.
 */
const dropAudit = args.includes("--drop-audit");
const all = args.includes("--all");
/** Where to write the per-user record. See `writeReport`. */
const reportPath = flagValue("--report");

function flagValue(name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

/** Rows removed per statement. Small enough that locks stay short. */
const BATCH = Number(flagValue("--batch") ?? 1000);

type Delegate = {
	count: (args: { where: unknown }) => Promise<number>;
	findMany: (args: {
		where: unknown;
		select: unknown;
		take: number;
	}) => Promise<{ id: string }[]>;
	deleteMany: (args: { where: unknown }) => Promise<{ count: number }>;
};

function client(): Record<string, unknown> {
	return db as unknown as Record<string, unknown>;
}

// ─── Phase A — the three things that are genuinely per user ─────────────────

/**
 * The payment provider.
 *
 * Refuses rather than cancels unless told to: the row names a live
 * subscription, and deleting our record of it would leave the customer billed
 * by a subscription nobody can now look up.
 */
async function settlePurchases(
	userId: string,
): Promise<{ refused?: string; cancelled: number }> {
	const purchases = await db.purchase.findMany({
		where: { userId, organizationId: null },
		select: { id: true, subscriptionId: true, status: true },
	});

	const live = purchases.filter(
		(purchase) => purchase.subscriptionId && purchase.status !== "canceled",
	);
	if (live.length === 0) {
		return { cancelled: 0 };
	}

	if (!cancelSubscriptions) {
		return {
			refused: `${live.length} live subscription(s) at the payment provider — deleting the rows would not cancel them. Re-run with --cancel-subscriptions, or cancel them out of band first.`,
			cancelled: 0,
		};
	}

	if (!apply) {
		return { cancelled: live.length };
	}

	// Relative rather than by package name: only `@repo/temporal` and
	// `@repo/tsconfig` are declared at the repository root, and the other
	// workspace packages do not resolve from here. Declaring them would be
	// an install; a path is enough for a script.
	const { cancelSubscription } = await import("../packages/payments/index");
	let cancelled = 0;
	for (const purchase of live) {
		try {
			await cancelSubscription(purchase.subscriptionId as string);
			cancelled += 1;
		} catch (error) {
			return {
				refused: `cancelling a subscription failed: ${(error as Error).message}`,
				cancelled,
			};
		}
	}
	return { cancelled };
}

/**
 * Objects, which live under the owner's own prefix — in EVERY bucket.
 *
 * This swept one, named by an `S3_BUCKET_NAME` the application does not define,
 * falling back to the avatars bucket. So it deleted a user's avatar, reported
 * their files removed, and cleared them for the row sweep — while their chat
 * documents, project contexts, workspace documents, skills, document assets and
 * QA evidence stayed behind. Six buckets of orphans, and the report said clean.
 *
 * Every bucket carries a default in `config.storage.bucketNames`, so there is no
 * "not configured" state to fall back from: the names are always known. What can
 * fail is reaching them, and that refuses the user rather than passing them on
 * — the same rule the vector delete follows, and for the same reason.
 */
async function dropObjects(
	userId: string,
): Promise<{ refused?: string; deleted: number }> {
	const { config } = await import("../config/index");
	const buckets = Object.values(config.storage.bucketNames) as string[];
	if (buckets.length === 0) {
		return {
			refused:
				"no storage buckets configured, so personal files cannot be removed",
			deleted: 0,
		};
	}

	const { listObjects, deleteObjects } = await import(
		"../packages/storage/index"
	);

	let deleted = 0;
	for (const bucket of buckets) {
		const keys: string[] = [];
		try {
			let continuationToken: string | undefined;
			do {
				const page = await listObjects({
					bucket,
					prefix: `${userId}/`,
					continuationToken,
				});
				keys.push(...page.objects.map((object) => object.key));
				continuationToken = page.nextContinuationToken;
			} while (continuationToken);
		} catch (error) {
			return {
				refused: `could not list "${bucket}": ${(error as Error).message}`,
				deleted,
			};
		}

		deleted += keys.length;
		if (keys.length === 0 || !apply) {
			continue;
		}

		try {
			for (let i = 0; i < keys.length; i += BATCH) {
				await deleteObjects(keys.slice(i, i + BATCH), { bucket });
			}
		} catch (error) {
			return {
				refused: `could not delete from "${bucket}": ${(error as Error).message}`,
				deleted,
			};
		}
	}

	return { deleted };
}

/** Embeddings, which share one collection across all personal data. */
async function dropEmbeddings(
	userId: string,
): Promise<{ refused?: string; deleted: number }> {
	try {
		const { deleteUserExecutions, deleteUserEpisodes } = await import(
			"../packages/rag/index"
		);
		if (!apply) {
			return { deleted: 0 };
		}
		const executions = await deleteUserExecutions(userId);

		// Checked, not awaited-and-discarded. Neither of these throws: both
		// catch their own error and report it in the RETURN value, so the
		// try/catch around them never fires and a vector store that is simply
		// down reads as a clean run. Observed exactly that — the store was
		// unreachable, the log said so, and both users cleared anyway. Their
		// rows would then be deleted while their episodes survived, which is
		// the orphan this phase exists to refuse.
		//
		// `deleteUserEpisodes` returns false on failure, which is a real
		// signal. `deleteUserExecutions` returns 0, which is indistinguishable
		// from "there were none" — so it cannot be checked the same way. They
		// share one store, so a failure that matters shows up in the first.
		if (!(await deleteUserEpisodes(userId))) {
			return {
				refused:
					"vector store did not confirm the episode delete — refusing rather than orphaning embeddings",
				deleted: 0,
			};
		}

		return { deleted: executions };
	} catch (error) {
		return {
			refused: `vector store unreachable or missing a per-user delete: ${(error as Error).message}`,
			deleted: 0,
		};
	}
}

type PhaseAResult = {
	cleared: string[];
	refused: { userId: string; reason: string }[];
	cancelled: number;
	objects: number;
	vectors: number;
};

async function runPhaseA(userIds: string[]): Promise<PhaseAResult> {
	const result: PhaseAResult = {
		cleared: [],
		refused: [],
		cancelled: 0,
		objects: 0,
		vectors: 0,
	};

	for (const userId of userIds) {
		try {
			const purchases = await settlePurchases(userId);
			if (purchases.refused) {
				result.refused.push({ userId, reason: purchases.refused });
				continue;
			}

			const objects = await dropObjects(userId);
			if (objects.refused) {
				result.refused.push({ userId, reason: objects.refused });
				continue;
			}

			const embeddings = await dropEmbeddings(userId);
			if (embeddings.refused) {
				result.refused.push({ userId, reason: embeddings.refused });
				continue;
			}

			result.cleared.push(userId);
			result.cancelled += purchases.cancelled;
			result.objects += objects.deleted;
			result.vectors += embeddings.deleted;
		} catch (error) {
			// Failure-isolated: one user's failure does not end the run, and
			// their rows stay because they never reach the cleared list.
			result.refused.push({
				userId,
				reason: `failed: ${(error as Error).message}`,
			});
		}
	}

	return result;
}

// ─── Phase B — relational rows, once per model rather than once per user ────

/**
 * Delete in batches of ids.
 *
 * `deleteMany` on a large table takes locks for the length of its own
 * deletion; taking a page of ids and deleting those keeps each statement small
 * and lets an interrupted run resume by being run again.
 */
async function deleteInBatches(
	delegate: Delegate,
	where: Record<string, unknown>,
): Promise<number> {
	let removed = 0;
	for (;;) {
		const page = await delegate.findMany({
			where,
			select: { id: true },
			take: BATCH,
		});
		if (page.length === 0) {
			return removed;
		}
		const result = await delegate.deleteMany({
			where: { id: { in: page.map((row) => row.id) } },
		});
		removed += result.count;
		if (page.length < BATCH) {
			return removed;
		}
	}
}

async function runPhaseB(
	clearedUserIds: string[] | null,
	refusedUserIds: string[],
): Promise<{ counts: Record<string, number>; uncounted: string[] }> {
	const counts: Record<string, number> = {};
	const uncounted: string[] = [];

	/**
	 * Restrict to the users Phase A cleared, and never to those it refused. A
	 * bulk delete that ignored the refusals would take the rows of exactly the
	 * people whose subscription could not be cancelled or whose files could not
	 * be reached — the failure the refusal exists to prevent.
	 */
	function scope(model: ReturnType<typeof personalBearingModels>[number]) {
		const base = personalWhere(model);
		if (!model.hasUserId) {
			// No user column: the row cannot be attributed, so it is left alone
			// rather than deleted on a guess.
			return null;
		}
		// MERGE with the guard rather than replacing it. `personalWhere` sets
		// `userId: { not: null }` on every model whose owner column is
		// nullable, because a row with no owner is global, not personal —
		// seventy-two of eighty-seven on a local database. Spreading a new
		// `userId` over the base silently dropped that guard, and global rows
		// survived only because SQL's IN and NOT IN happen to exclude NULLs.
		// That is an accident of the operator, not the predicate the changeset
		// claims protects them, and it stops being true the moment the shape
		// of this filter changes.
		if (clearedUserIds) {
			return withOwner(base, { in: clearedUserIds });
		}
		return refusedUserIds.length > 0
			? withOwner(base, { notIn: refusedUserIds })
			: base;
	}

	for (const model of personalBearingModels()) {
		if (model.name === "AuditLog") {
			continue; // last, and inside its own transaction
		}

		const where = scope(model);
		if (!where) {
			continue;
		}

		const delegate = delegateFor<Delegate>(client(), model.name);
		if (!delegate) {
			uncounted.push(`${model.name} — no Prisma delegate`);
			continue;
		}

		try {
			const found = await delegate.count({ where });
			if (found === 0) {
				continue;
			}
			counts[model.name] = found;
			if (apply) {
				await deleteInBatches(delegate, where);
			}
		} catch (error) {
			uncounted.push(
				`${model.name} — ${(error as Error).message.split("\n")[0]}`,
			);
		}
	}

	// The audit trail last, and only with the switch its trigger requires. It
	// permits DELETE this way and permits no UPDATE at all, which is why the
	// drop is possible where re-tenanting these rows was not.
	//
	// `organizationId: null` does NOT mean "personal" on this table — it is the
	// one model here where that is false. `auditLogWhere` carries the three
	// reasons and what it can and cannot separate; deleting what it selects
	// therefore takes `--drop-audit` rather than riding on `--apply`.
	const auditWhere = auditLogWhere(clearedUserIds, refusedUserIds);

	try {
		const auditRows = await db.auditLog.count({ where: auditWhere });
		if (auditRows > 0) {
			counts.AuditLog = auditRows;
			if (apply && !dropAudit) {
				uncounted.push(
					`AuditLog — ${auditRows} rows match and were NOT deleted. ` +
						"A null tenant on this table also means an organization " +
						"whose trail outlived it and a system actor with no " +
						"organization, and neither is distinguishable from a " +
						"personal row by predicate. Pass --drop-audit to accept " +
						"that and delete anyway.",
				);
			}
			if (apply && dropAudit) {
				for (;;) {
					const page = await db.auditLog.findMany({
						where: auditWhere,
						select: { id: true },
						take: BATCH,
					});
					if (page.length === 0) {
						break;
					}
					await db.$transaction(async (tx) => {
						await tx.$executeRawUnsafe(
							"SET LOCAL app.audit_allow_delete = 'on'",
						);
						await tx.auditLog.deleteMany({
							where: { id: { in: page.map((row) => row.id) } },
						});
					});
					if (page.length < BATCH) {
						break;
					}
				}
			}
		}
	} catch (error) {
		uncounted.push(`AuditLog — ${(error as Error).message.split("\n")[0]}`);
	}

	return { counts, uncounted };
}

// ─── Driver ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	const startedAt = new Date().toISOString();
	const single = flagValue("--user");
	if (!single && !all) {
		console.error("Pass --user <id> or --all.");
		process.exit(2);
	}

	// Every user, not just those without a membership: personal rows belong to
	// whoever wrote them, and having since been given an organization does not
	// delete them. Once signup provisions one for everyone, a member-less
	// selector would converge on nobody and clear nothing while reporting a
	// clean run.
	const userIds = single
		? [single]
		: (await db.user.findMany({ select: { id: true } })).map(
				(user) => user.id,
			);

	console.log(
		`\n${apply ? "DROPPING" : "DRY RUN —"} personal context` +
			`\n  users in scope ....... ${userIds.length}` +
			`\n  models to sweep ...... ${personalBearingModels().length}` +
			`\n  batch size ........... ${BATCH}\n`,
	);

	console.log("Phase A — subscriptions, files, embeddings (per user)");
	const phaseA = await runPhaseA(userIds);
	console.log(
		`  cleared ${phaseA.cleared.length}, refused ${phaseA.refused.length}` +
			`  (subscriptions=${phaseA.cancelled} objects=${phaseA.objects} vectors=${phaseA.vectors})`,
	);
	for (const { userId, reason } of phaseA.refused) {
		console.log(`    REFUSED ${userId} — ${reason}`);
	}

	// Stopping here is right when applying — a refusal means the rows of exactly
	// the person whose subscription or files could not be reached, and taking
	// them is the failure the refusal exists to prevent.
	//
	// It is wrong on a DRY RUN, which deletes nothing either way. Stopping there
	// hides phase B entirely, so the report an operator is told to read before
	// applying accounts for no models at all — and phase B's scope is the half
	// worth reading. It has been wrong before: a sweep that selected every row
	// with no organization would have taken the seeded MCP catalog and the
	// system prompts, which have no organization AND no owner.
	if (phaseA.cleared.length === 0 && userIds.length > 0) {
		if (apply) {
			console.log(
				"\nNo user cleared phase A, so nothing is deleted. Fix the refusals above and re-run.\n",
			);
			return;
		}
		console.log(
			"\nNo user cleared phase A. Nothing would be deleted in a real run —\n" +
				"  the sweep below is reported anyway, because that is what this run is for.\n",
		);
	}

	console.log("\nPhase B — relational rows (per model)");
	const phaseB = await runPhaseB(
		single ? phaseA.cleared : null,
		phaseA.refused.map((entry) => entry.userId),
	);

	const rows = Object.entries(phaseB.counts).sort((a, b) => b[1] - a[1]);
	const total = rows.reduce((sum, [, value]) => sum + value, 0);
	console.log(
		`  ${rows.length} model(s) holding ${total} row(s)${apply ? ", deleted" : ""}`,
	);
	for (const [model, count] of rows.slice(0, 20)) {
		console.log(`    ${model} ${count}`);
	}
	if (rows.length > 20) {
		console.log(`    … and ${rows.length - 20} more`);
	}
	for (const entry of phaseB.uncounted) {
		console.log(`    UNCOUNTED ${entry}`);
	}

	// A record an operator can read afterwards, per user, with a timestamp.
	//
	// The console output above is the run; this is the evidence of it. It
	// deliberately does NOT go to the audit log: an audit row about dropping a
	// user's data is keyed to that user with no organization, which makes it a
	// personal row — the next run would sweep the record of the previous one.
	if (reportPath) {
		const { writeFileSync } = await import("node:fs");
		const finishedAt = new Date().toISOString();
		const report = {
			startedAt,
			finishedAt,
			mode: apply ? "apply" : "dry-run",
			usersInScope: userIds.length,
			users: [
				...phaseA.cleared.map((userId) => ({
					userId,
					status: "cleared" as const,
				})),
				...phaseA.refused.map(({ userId, reason }) => ({
					userId,
					status: "refused" as const,
					reason,
				})),
			],
			objectsRemoved: phaseA.objects,
			subscriptionsCancelled: phaseA.cancelled,
			models: phaseB.counts,
			uncounted: phaseB.uncounted,
		};
		writeFileSync(reportPath, `${JSON.stringify(report, null, "\t")}\n`);
		console.log(`  report written to ${reportPath}`);
	}

	console.log(
		`\n${apply ? "Done" : "Dry run complete — nothing was changed. Re-run with --apply."}\n`,
	);
}

main()
	.catch((error) => {
		console.error("[drop-personal-context] failed:", error);
		process.exitCode = 1;
	})
	.finally(() => db.$disconnect());
