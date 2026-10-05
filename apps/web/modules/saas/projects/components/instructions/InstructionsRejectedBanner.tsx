"use client";

import type { InstructionRejection } from "@repo/database";
import { Button } from "@ui/components/button";
import { AlertTriangleIcon, RefreshCwIcon, UploadIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	InstructionFindingsTable,
	TRUNCATED_REASON,
} from "./InstructionFindingsTable";

// The row `rejectAbandonedInstructionSnapshot` writes when a snapshot never
// finished (`path: "(upload)"`). It says nothing about any file.
const ABANDONED_REASON = "abandoned";

/** The element id the sync status block's "See findings" link points at. */
export const REJECTED_BANNER_ID = "instructions-rejected-banner";

/**
 * Explains a rejected upload file by file, while whatever version was
 * published stays published. The table is `InstructionFindingsTable`, shared
 * with the published view's deferred-scan findings; a trailing `reason ===
 * "truncated"` row is not a file, so it is excluded from the title's count
 * here and rendered by the table as a summary line.
 *
 * When every row is the abandonment marker the snapshot never reached its
 * checks, so the banner drops the file table and the "fix these files" body
 * for a neutral one: nothing is wrong with the files.
 */
export function InstructionsRejectedBanner({
	rejection,
	onUploadAgain,
	mode = "upload",
	branch = null,
	commit: refusedCommit = null,
	publishedCommit = null,
	onSyncAgain,
	repositoryBacked = false,
	publishedVersion = null,
}: {
	rejection: InstructionRejection[];
	/**
	 * The version still published while this one is refused. Said outright,
	 * because a refused sync of a commit that is already on the branch is
	 * exactly the case where "what do my agents read now?" is the question.
	 */
	publishedVersion?: number | null;
	/**
	 * Upload mode: offer "Upload again". Absent while a repository is the
	 * project's source of truth, where an upload would be refused.
	 */
	onUploadAgain?: () => void;
	/**
	 * Where the rejected files came from, which decides where they are fixed
	 * (plan Decision 29). A synced version is fixed in the repository, so
	 * "Upload again" would send someone to the wrong place.
	 */
	mode?: "upload" | "repository" | "commit";
	/**
	 * A direct commit to the synced branch that the scan refused (Fizzy #2878
	 * §10): nothing was pushed, so there is no commit to name, and the way on is
	 * to fix the files and commit again. `branch` is where it would have gone.
	 */
	branch?: string | null;
	/**
	 * Repository mode: the commit of the branch the sync refused. A refused
	 * commit is named as git names it, so what is wrong is a commit to fix.
	 */
	commit?: string | null;
	/** Repository mode: the commit Fabric's copy stays at while this one is refused. */
	publishedCommit?: string | null;
	/** Repository mode: start another sync. Absent for a member who cannot. */
	onSyncAgain?: () => void;
	/**
	 * The project's instructions now come from a repository. An upload-mode
	 * rejection then points there rather than at the source folder.
	 */
	repositoryBacked?: boolean;
}) {
	const t = useTranslations("projects.codingInstructions.rejectedBanner");
	const rows = rejection.filter((r) => r.reason !== TRUNCATED_REASON);
	const secretCount = new Set(
		rows.filter((r) => r.reason === "secret").map((r) => r.path),
	).size;
	const abandoned =
		rows.length > 0 && rows.every((r) => r.reason === ABANDONED_REASON);
	const repository = mode === "repository";
	const commit = mode === "commit";
	const refusedSha7 = refusedCommit ? refusedCommit.slice(0, 7) : null;
	const publishedSha7 = publishedCommit ? publishedCommit.slice(0, 7) : null;
	// The suffix every copy key of this mode carries.
	const variant = commit
		? "Commit"
		: repository
			? refusedSha7 !== null
				? "RepositoryCommit"
				: "Repository"
			: "";
	const title = abandoned
		? t(`titleAbandoned${variant}`, { sha7: refusedSha7 ?? "" })
		: secretCount > 0
			? t(
					`titleSecrets${secretCount === 1 ? "Singular" : "Plural"}${variant}`,
					{ count: secretCount, sha7: refusedSha7 ?? "" },
				)
			: t(
					`titleChecks${rows.length === 1 ? "Singular" : "Plural"}${variant}`,
					{ count: rows.length, sha7: refusedSha7 ?? "" },
				);
	const body = abandoned
		? `bodyAbandoned${variant}`
		: commit || repository
			? `body${variant}`
			: repositoryBacked
				? "bodyUploadRepositoryBacked"
				: "body";
	return (
		<div
			// The status block's "See findings" scrolls and focuses here.
			id={REJECTED_BANNER_ID}
			tabIndex={-1}
			className={
				abandoned
					? "overflow-hidden rounded-lg border border-border bg-muted/40"
					: "overflow-hidden rounded-lg border border-destructive/40 bg-destructive/5"
			}
		>
			<div className="flex items-start gap-3 p-5">
				<AlertTriangleIcon
					className={
						abandoned
							? "mt-0.5 size-5 text-muted-foreground"
							: "mt-0.5 size-5 text-destructive"
					}
					aria-hidden="true"
				/>
				<div className="flex flex-col gap-1">
					<h2
						className={
							abandoned
								? "font-semibold text-base"
								: "font-semibold text-base text-destructive"
						}
					>
						{title}
					</h2>
					<p className="max-w-prose">
						{t(body, { ref: branch ?? "" })}
					</p>
					{publishedVersion === null ? null : (
						<p className="max-w-prose text-muted-foreground text-sm">
							{repository && publishedSha7 !== null
								? t("publishedStaysRepositoryCommit", {
										sha7: publishedSha7,
									})
								: t(
										repository || commit
											? "publishedStaysRepository"
											: "publishedStays",
										{ version: publishedVersion },
									)}
						</p>
					)}
				</div>
			</div>
			{abandoned ? null : (
				<InstructionFindingsTable
					findings={rejection}
					className="mx-5 mb-5"
				/>
			)}
			{commit ? null : repository ? (
				onSyncAgain ? (
					<div className="px-5 pb-5">
						<Button onClick={onSyncAgain}>
							<RefreshCwIcon
								className="size-4"
								aria-hidden="true"
							/>
							{t("syncAgain")}
						</Button>
					</div>
				) : null
			) : onUploadAgain ? (
				<div className="px-5 pb-5">
					<Button onClick={onUploadAgain}>
						<UploadIcon className="size-4" aria-hidden="true" />
						{t("uploadAgain")}
					</Button>
				</div>
			) : null}
		</div>
	);
}
