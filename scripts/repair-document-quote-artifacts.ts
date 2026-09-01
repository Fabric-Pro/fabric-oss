#!/usr/bin/env npx tsx
/**
 * One-time repair for tilde-prefixed typographic-quote artifacts in stored
 * project documents (Fizzy #2210).
 *
 * Affected documents carry runs like `~“`, `~“~“`, `~“~“~“~“` in place of a
 * single quote — the run doubling with each regeneration, so the damage grows
 * every time someone retries. The forward guard lives in
 * `normalizeQuoteArtifacts`, applied wherever generated content is persisted;
 * this script repairs what was written before that guard existed. Both use the
 * SAME function on purpose: a count that disagrees with the repair is worse than
 * either alone, because the disagreement is what gets believed.
 *
 * DRY RUN IS THE DEFAULT. It reports what would change and writes nothing.
 *
 *   DATABASE_URL=... pnpm exec tsx scripts/repair-document-quote-artifacts.ts
 *   DATABASE_URL=... pnpm exec tsx scripts/repair-document-quote-artifacts.ts --apply
 *
 * Options:
 *   --apply              Perform the writes. Without it nothing is written.
 *   --project <id>       Limit to one project. The first --apply need not be
 *                        all-or-nothing across every tenant.
 *   --limit <n>          Stop after n documents (default: no limit).
 *   --report <path>      Write a JSON record of every document touched.
 *
 * Safety properties, each of which exists because of a specific failure mode:
 *
 *  - Every repair is ONE transaction: re-read, derive, snapshot, then update
 *    under a compare-and-set on `{ id, version }`. A guard that reads and then
 *    writes outside a transaction is decorative — a member can save in the gap
 *    and the script would overwrite their fresh content.
 *  - A version mismatch is REPORTED, never overwritten. Someone edited the
 *    document while we worked; their edit wins and the row is left for a later
 *    pass.
 *  - The pre-repair snapshot is the rollback. Nothing else here restores a
 *    document if the transform misfires, and the transform's evidence base is
 *    deliberately weak: no code producing the corruption was ever found.
 *  - The snapshot carries the author of the content IT HOLDS — the document's
 *    prior editor, never this repair. Stamping an automated writer onto text a
 *    person wrote is exactly the ledger inversion that makes version history
 *    lie about who changed what.
 *
 * Cross-package imports are relative paths, not package names: only a few
 * workspace packages resolve from the repository root.
 */

import { db } from "@repo/database";
import { QUOTE_REPAIR_AUTHOR_ID } from "../packages/utils/lib/document-version-author";
import { normalizeQuoteArtifacts } from "../packages/utils/lib/quote-artifacts";

/**
 * Stamped on the repaired row. Imported rather than redeclared: a sentinel the
 * shared author resolver does not know renders as "Unknown user", i.e. a deleted
 * account, so version history would show this repair as a vanished person's edit.
 */
const REPAIR_AUTHOR_ID = QUOTE_REPAIR_AUTHOR_ID;

/**
 * Candidate predicate: a tilde IMMEDIATELY followed by a typographic quote.
 *
 * Deliberately not a bare `contains: "~"`. That matches every legitimate
 * strikethrough, URL, path and "~2 seconds" in the corpus, and each false
 * positive still costs a full document body over the wire before JS can discard
 * it. There are only four typographic quotes, so the precise shape is expressible
 * as an OR without dropping to raw SQL.
 *
 * Still only a PRE-filter: `normalizeQuoteArtifacts` decides for real, because
 * the balanced-strikethrough exclusion is not expressible here.
 */
const ARTIFACT_PREFIXES = ["~\u2018", "~\u2019", "~\u201C", "~\u201D"];
const CANDIDATE_WHERE = {
	OR: ARTIFACT_PREFIXES.map((prefix) => ({ content: { contains: prefix } })),
};

/**
 * `already-clean` and `conflict` are kept apart deliberately. Both mean "left
 * unchanged", but only one means "re-run to catch this": a document that was
 * already clean needs nothing, while one lost to a concurrent edit is still
 * outstanding. Collapsing them would leave the report file — the artifact anyone
 * reads after a non-interactive run — unable to say which.
 */
type Outcome =
	| { status: "repaired"; documentId: string; removed: number }
	| { status: "already-clean"; documentId: string }
	| { status: "skipped-pending-proposal"; documentId: string }
	| { status: "conflict"; documentId: string }
	| { status: "failed"; documentId: string; reason: string };

/**
 * Thrown when the compare-and-set loses. A class rather than a sentinel string:
 * matching `error.message === "version-conflict"` across a transaction boundary
 * would misclassify any future error that happened to carry the same text as a
 * benign, re-runnable conflict — and this repo already has a typed shape for
 * exactly this case (`DocumentVersionConflictError`).
 */
class RepairVersionConflict extends Error {
	constructor() {
		super("version-conflict");
		this.name = "RepairVersionConflict";
	}
}

function flagValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
	const apply = process.argv.includes("--apply");
	const projectId = flagValue("--project");
	const limitRaw = flagValue("--limit");
	// A bad --limit must not silently become "no limit". `Number.parseInt("abc")`
	// is NaN and `"0"` is 0; both are falsy, so the bound would vanish and an
	// operator expecting a five-document canary would rewrite the whole corpus.
	let limit: number | undefined;
	if (limitRaw !== undefined) {
		limit = Number.parseInt(limitRaw, 10);
		if (!Number.isInteger(limit) || limit < 1) {
			console.error(
				`--limit must be a positive integer (got ${limitRaw}).`,
			);
			process.exitCode = 1;
			return;
		}
	}
	const reportPath = flagValue("--report");
	const startedAt = new Date().toISOString();

	// Re-derive the affected set here rather than trusting any figure recorded
	// when this was planned — a prior pass, or the forward guard, may already
	// have shrunk it.
	// Page through candidates until `--limit` AFFECTED documents are found, not
	// the first `--limit` rows that merely contain a tilde-quote pair. Those two
	// are very different: a legitimate `~'90s` matches the SQL predicate but is
	// not corruption, so a limit applied to candidates can fill entirely with
	// clean rows, print "Nothing to repair", and — because the order is stable —
	// report the same false all-clear on every re-run. A bounded canary that
	// cannot converge is worse than no canary.
	const PAGE_SIZE = 200;
	const affected: Array<{ id: string; content: string }> = [];
	let scanned = 0;
	let cursor: string | undefined;

	while (true) {
		const page = await db.projectDocument.findMany({
			where: {
				...CANDIDATE_WHERE,
				...(projectId ? { projectId } : {}),
			},
			select: { id: true, content: true },
			orderBy: { id: "asc" },
			take: PAGE_SIZE,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
		});

		if (page.length === 0) {
			break;
		}
		scanned += page.length;
		cursor = page[page.length - 1]?.id;

		for (const doc of page) {
			if (normalizeQuoteArtifacts(doc.content) !== doc.content) {
				affected.push(doc);
				if (limit && affected.length >= limit) {
					break;
				}
			}
		}

		if (limit && affected.length >= limit) {
			break;
		}
		if (page.length < PAGE_SIZE) {
			break;
		}
	}

	console.log(
		`Scanned ${scanned} candidate document(s); ${affected.length} carry quote artifacts.`,
	);

	if (affected.length === 0) {
		console.log("Nothing to repair.");
		return;
	}

	if (!apply) {
		for (const doc of affected.slice(0, 20)) {
			const runs =
				doc.content.length -
				normalizeQuoteArtifacts(doc.content).length;
			console.log(`  would repair ${doc.id} (${runs} chars removed)`);
		}
		if (affected.length > 20) {
			console.log(`  … and ${affected.length - 20} more`);
		}
		console.log(
			"\nDry run — nothing was written. Re-run with --apply to repair.",
		);
		return;
	}

	// Only the ids are needed from here on — every repair re-reads its content
	// fresh inside its own transaction. Holding the bodies would pin the whole
	// affected set in memory for the run's duration for nothing.
	const affectedIds = affected.map((doc) => doc.id);
	const outcomes: Outcome[] = [];

	for (const documentId of affectedIds) {
		try {
			const outcome = await db.$transaction(async (tx) => {
				// Read INSIDE the transaction: the scan above may be minutes old.
				const current = await tx.projectDocument.findUnique({
					where: { id: documentId },
					select: {
						id: true,
						content: true,
						version: true,
						lastEditedBy: true,
						userId: true,
						organizationId: true,
					},
				});

				if (!current) {
					return {
						status: "failed" as const,
						documentId: documentId,
						reason: "document disappeared during the run",
					};
				}

				// A stored proposal is pinned to the version it was drafted from, so
				// bumping the version here would make accepting it lose its CAS —
				// and the accept path does not merely refuse, it DISCARDS the draft.
				// Deleting a review someone was asked to do, to fix a quote
				// character, is not a trade worth making: leave these for a pass
				// after the proposal is resolved.
				const pending = await tx.documentAutoRefreshSettings.findUnique(
					{
						where: { documentId: current.id },
						select: { pendingContent: true },
					},
				);
				if (pending?.pendingContent) {
					return {
						status: "skipped-pending-proposal" as const,
						documentId,
					};
				}

				const repaired = normalizeQuoteArtifacts(current.content);
				if (repaired === current.content) {
					// Fixed between the scan and now — nothing outstanding.
					return {
						status: "already-clean" as const,
						documentId,
					};
				}

				// The snapshot holds the PRE-repair content, so it carries the
				// author of that content — not this repair.
				const existingSnapshot = await tx.documentVersion.findFirst({
					where: {
						documentId: current.id,
						version: current.version,
					},
					select: { id: true },
				});

				if (!existingSnapshot) {
					await tx.documentVersion.create({
						data: {
							documentId: current.id,
							version: current.version,
							content: current.content,
							changedBy: current.lastEditedBy,
							changeDescription:
								"Content before automated quote-artifact repair (Fizzy #2210)",
							userId: current.userId,
							organizationId: current.organizationId,
						},
					});
				}

				// Compare-and-set: the database arbitrates, not a prior read.
				const { count } = await tx.projectDocument.updateMany({
					// Content is in the predicate as well as version. Not every
					// writer bumps the version — `saveProjectDocument` and
					// `updateDocument({ skipVersionBump })` both rewrite the body
					// and leave it alone — so a version-only guard would let a
					// regeneration that landed mid-transaction be overwritten with
					// the stale body while this reported "repaired".
					where: {
						id: current.id,
						version: current.version,
						content: current.content,
					},
					data: {
						content: repaired,
						version: current.version + 1,
						lastEditedBy: REPAIR_AUTHOR_ID,
						// The embed sweep uses contentHash to decide whether
						// anything changed. Leave it and retrieval keeps serving
						// the pre-repair, corrupted text indefinitely — the repair
						// would be invisible to every downstream generation.
						contentHash: null,
					},
				});

				if (count !== 1) {
					// Someone saved between our read and our write. Their edit
					// wins; the transaction rolls the snapshot back with it.
					throw new RepairVersionConflict();
				}

				return {
					status: "repaired" as const,
					documentId: current.id,
					removed: current.content.length - repaired.length,
				};
			});

			outcomes.push(outcome);
			if (outcome.status === "repaired") {
				console.log(
					`  repaired ${outcome.documentId} (${outcome.removed} chars removed)`,
				);
			} else if (outcome.status === "skipped-pending-proposal") {
				console.log(
					`  SKIPPED ${outcome.documentId} — has a proposal awaiting review`,
				);
			} else if (outcome.status === "already-clean") {
				console.log(
					`  SKIPPED ${outcome.documentId} — already clean when re-read`,
				);
			}
		} catch (error) {
			const reason =
				error instanceof Error ? error.message : String(error);
			if (error instanceof RepairVersionConflict) {
				console.log(
					`  CONFLICT ${documentId} — edited while we worked; left unchanged`,
				);
				outcomes.push({
					status: "conflict",
					documentId: documentId,
				});
			} else {
				// Report and continue: one bad row must not abandon the rest.
				console.error(`  FAILED ${documentId} — ${reason}`);
				outcomes.push({
					status: "failed",
					documentId: documentId,
					reason,
				});
			}
		}
	}

	const tally = (status: Outcome["status"]) =>
		outcomes.filter((o) => o.status === status).length;
	console.log(
		`\nrepaired ${tally("repaired")} · already clean ${tally(
			"already-clean",
		)} · pending proposal ${tally(
			"skipped-pending-proposal",
		)} · conflicts ${tally("conflict")} · failed ${tally("failed")}`,
	);

	// Report first. The re-verification below is the single most expensive query
	// in this script, and if it throws after writes have already landed the
	// operator would be left with no machine-readable record of a destructive run.
	if (reportPath) {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			reportPath,
			`${JSON.stringify(
				{ startedAt, finishedAt: new Date().toISOString(), outcomes },
				null,
				2,
			)}\n`,
		);
		console.log(`Report written to ${reportPath}`);
	}

	// A row that failed for a real reason is not a successful run. Without this an
	// operator (or any automation gating on the exit code) reads a run where every
	// document errored as a clean pass.
	if (tally("failed") > 0) {
		process.exitCode = 1;
	}

	// Re-verify against the database rather than trusting the tally above.
	const remaining = await db.projectDocument.findMany({
		where: {
			...CANDIDATE_WHERE,
			...(projectId ? { projectId } : {}),
		},
		select: { id: true, content: true },
	});
	const stillAffected = remaining.filter(
		(doc) => normalizeQuoteArtifacts(doc.content) !== doc.content,
	).length;
	console.log(
		stillAffected === 0
			? "\nNo document carries quote artifacts any more.\n"
			: `\n${stillAffected} document(s) still carry artifacts — re-run to pick up conflicts.\n`,
	);
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(() => db.$disconnect());
