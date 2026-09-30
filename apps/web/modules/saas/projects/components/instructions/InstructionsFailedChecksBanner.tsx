"use client";

import { Button } from "@ui/components/button";
import { useTranslations } from "next-intl";

/**
 * A version whose checks could not finish (R30), while whatever version was
 * published stays published. FAILED is the checks breaking, never a verdict
 * on the files or on the folder limits, so every variant says so.
 *
 * Which body and which actions show follows what the viewer can actually do:
 * `finalize` re-runs the checks on the staged files in place, which works for
 * an upload version in upload mode and a synced version in repository mode. An
 * upload version in a repository-backed project can no longer be published
 * at all (the publish refuses it once the repository is the source), so the
 * only way forward is a sync.
 */
export function InstructionsFailedChecksBanner({
	version,
	publishedVersion,
	mode,
	canRetry,
	stale,
	canEdit,
	retrying,
	onRetry,
	onUploadAgain,
}: {
	version: number;
	publishedVersion: number | null;
	/** Where the failed version came from, which decides what a retry re-checks. */
	mode: "upload" | "repository";
	/** The viewer can edit, and the failed version matches the project's source. */
	canRetry: boolean;
	/**
	 * The version's source is no longer the project's: an upload in a
	 * repository-backed project, or a synced version once sync is off. It
	 * can no longer be published, so a retry is pointless.
	 */
	stale: boolean;
	/** Only a viewer who cannot edit is told to ask someone else. */
	canEdit: boolean;
	retrying: boolean;
	onRetry: () => void;
	/** Upload mode only; absent while a repository is the source. */
	onUploadAgain?: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.publishedView");
	const body = stale
		? t(mode === "repository" ? "failedBodyStaleSynced" : "failedBodyStale")
		: canEdit
			? t(
					mode === "repository"
						? "failedBodyRepository"
						: "failedBodyUpload",
				)
			: t("failedBodyNoAccess");
	return (
		<div
			role="alert"
			className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
		>
			<h2 className="font-semibold text-destructive">
				{t("failedTitle", { version })}
			</h2>
			<p className="text-muted-foreground text-sm">
				{body}
				{publishedVersion === null
					? null
					: ` ${t("failedPublishedStays", { published: publishedVersion })}`}
			</p>
			{canRetry ? (
				<div className="flex flex-wrap gap-2">
					<Button
						variant="outline"
						disabled={retrying}
						onClick={onRetry}
					>
						{t("retryChecksButton")}
					</Button>
					{onUploadAgain ? (
						<Button variant="ghost" onClick={onUploadAgain}>
							{t("uploadAgainButton")}
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	);
}
