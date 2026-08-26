/**
 * One-time backfill: fill the `summary` on `PendingBacklogProposal` rows that
 * were persisted with an empty summary (monitored-source proposals whose
 * analyzer output had no top-level summary). Derives the headline from the
 * stored proposal JSON — the same `deriveProposalHeadline` used at write time
 * now that `createPendingBacklogProposal` / the monitor activities store it.
 *
 * Idempotent (only touches empty-summary rows). Dry-run by default; pass --apply.
 */
import { db } from "../prisma/client";
import { deriveProposalHeadline } from "../prisma/queries/projects/pending-backlog-proposals";

const apply = process.argv.includes("--apply");

async function main() {
	let updated = 0;
	let unresolved = 0;

	const rows = await db.pendingBacklogProposal.findMany({
		where: { summary: "" },
		select: { id: true, proposal: true },
	});
	for (const row of rows) {
		const headline = deriveProposalHeadline(row.proposal);
		if (!headline) {
			unresolved += 1;
			continue;
		}
		if (apply) {
			await db.pendingBacklogProposal.update({
				where: { id: row.id },
				data: { summary: headline },
			});
		} else {
			console.log(`WOULD set summary for ${row.id}: ${headline}`);
		}
		updated += 1;
	}

	console.log(
		`done. updated=${updated} unresolved=${unresolved} mode=${apply ? "APPLY" : "DRY-RUN"}`,
	);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error("Backfill failed:", err);
		process.exit(1);
	});
