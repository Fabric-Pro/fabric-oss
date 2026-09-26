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
	onSyncAgain,
	repositoryBacked = false,
}: {
	rejection: InstructionRejection[];
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
	mode?: "upload" | "repository";
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
	const title = abandoned
		? t(repository ? "titleAbandonedRepository" : "titleAbandoned")
		: secretCount > 0
			? t(
					secretCount === 1
						? repository
							? "titleSecretsSingularRepository"
							: "titleSecretsSingular"
						: repository
							? "titleSecretsPluralRepository"
							: "titleSecretsPlural",
					{ count: secretCount },
				)
			: t(
					rows.length === 1
						? repository
							? "titleChecksSingularRepository"
							: "titleChecksSingular"
						: repository
							? "titleChecksPluralRepository"
							: "titleChecksPlural",
					{ count: rows.length },
				);
	const body = abandoned
		? repository
			? "bodyAbandonedRepository"
			: "bodyAbandoned"
		: repository
			? "bodyRepository"
			: repositoryBacked
				? "bodyUploadRepositoryBacked"
				: "body";
	return (
		<div
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
					<p className="max-w-prose">{t(body)}</p>
				</div>
			</div>
			{abandoned ? null : (
				<InstructionFindingsTable
					findings={rejection}
					className="mx-5 mb-5"
				/>
			)}
			{repository ? (
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
