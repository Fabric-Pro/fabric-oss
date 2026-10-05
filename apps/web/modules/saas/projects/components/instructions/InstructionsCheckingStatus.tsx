"use client";

import { Button } from "@ui/components/button";
import { Progress } from "@ui/components/progress";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	checkPhaseMessageKey,
	checkProgressMessageKey,
	snapshotCheckProgress,
} from "../../lib/instructions-check-progress";
import { shortCommit } from "../../lib/instructions-repository-sync";
import type { InstructionsSnapshot } from "../../lib/instructions-snapshot";

/**
 * Where the newest version's checks have got, or that the tab is waiting for
 * the pointer to move onto a version that passed them.
 *
 * Rendered outside the published/empty choice of the header, not as a third
 * branch of it: a REPLACE upload is checked while the previous version is still
 * published, so as a branch this line was unreachable in the one case that
 * needs it and the tab looked untouched until the poll swapped the new version
 * in. `aria-live` because it appears on a poll, with no interaction to
 * announce it. Styled as a pill in the primary colour with a spinner, like the
 * published badge: as a plain muted sentence it sat under the summary and read
 * as part of it. The element is always rendered so the live region exists
 * before the text arrives; the pill classes apply only while there is
 * something to say.
 *
 * Only the phase is announced (the sr-only span); the count beside it changes
 * on every poll and is `aria-hidden`, so it is not read out each time. The
 * words differ for an upload, a synced commit (named once known) and a direct
 * commit to the branch.
 */
export function InstructionsCheckingStatus({
	checking,
	publishing,
	onDiscard,
	discarding = false,
}: {
	/** The newest version while its checks run, else null. */
	checking: InstructionsSnapshot | null;
	/** The checks passed and the tab waits for the published pointer. */
	publishing: boolean;
	/**
	 * Discard the upload being waited on. Given only when the viewer may and the
	 * row is an upload nobody finished (Fizzy #2878 follow-up): one whose browser
	 * never reached storage, or whose tab was closed, stays RECEIVING with
	 * nothing to move it, and this is the way out.
	 */
	onDiscard?: () => void;
	/** The discard is in flight. */
	discarding?: boolean;
}) {
	const t = useTranslations("projects.codingInstructions.publishedView");
	// Where the checks have got, from the snapshot's own progress columns; null
	// (and so today's plain "Checking your upload") whenever they are unset.
	const checkProgress = checking ? snapshotCheckProgress(checking) : null;
	const busy = Boolean(checking) || publishing;
	return (
		<div className="flex flex-col gap-1.5">
			<p
				aria-live="polite"
				className={
					busy
						? "inline-flex w-fit items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 font-medium text-primary text-sm"
						: "text-sm"
				}
			>
				{busy ? (
					<Loader2Icon
						className="size-3.5 motion-safe:animate-spin"
						aria-hidden="true"
					/>
				) : null}
				{checkProgress ? (
					<>
						<span className="sr-only">
							{t(checkPhaseMessageKey(checkProgress.phase))}
						</span>
						<span aria-hidden="true">
							{t(checkProgressMessageKey(checkProgress.phase), {
								done: checkProgress.done,
								total: checkProgress.total,
							})}
						</span>
					</>
				) : checking ? (
					t(
						checking.proposalDestination === "REPOSITORY_COMMIT"
							? "checkingSummaryCommit"
							: checking.source === "REPOSITORY"
								? checking.sourceCommitSha
									? "checkingSummaryRepositoryCommit"
									: "checkingSummaryRepository"
								: "checkingSummaryUpload",
						{ sha7: shortCommit(checking.sourceCommitSha) ?? "" },
					)
				) : publishing ? (
					t("publishing")
				) : (
					""
				)}
			</p>
			{checkProgress && checkProgress.total > 0 ? (
				<Progress
					aria-hidden="true"
					className="h-1 w-48"
					value={(checkProgress.done / checkProgress.total) * 100}
				/>
			) : null}
			{checking && onDiscard ? (
				<div>
					<Button
						size="sm"
						variant="outline"
						disabled={discarding}
						onClick={onDiscard}
					>
						{t("discardUploadButton")}
					</Button>
				</div>
			) : null}
		</div>
	);
}
