"use client";

import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { AlertTriangleIcon, HistoryIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { InstructionsSnapshot } from "../../lib/instructions-snapshot";
import {
	InstructionFindingsTable,
	SCAN_FAILED_REASON,
} from "./InstructionFindingsTable";

/**
 * What the published version's own deferred secret scan says (Fizzy #2737):
 * a version published before its scan, then one of four things: the scan is
 * running, it found possible secrets, it could not check every file but found
 * some in the rest, or it could not check every file and found nothing.
 *
 * Read off the pointer row so the alert follows the query that polls it (see
 * `CodingInstructionsTab`). Renders nothing for a version with no deferred
 * scan, or one whose scan passed.
 */
export function InstructionsDeferredScanAlerts({
	published,
	onOpenHistory,
}: {
	published: InstructionsSnapshot;
	onOpenHistory: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.publishedView");
	const deferredScan = published.deferredScanStatus ?? null;
	// An INCOMPLETE scan names each file that defeated its last attempt
	// (`scan_failed`) and keeps whatever it established around them.
	const incompleteFindings =
		deferredScan === "INCOMPLETE"
			? (published.deferredScanFindings ?? [])
			: [];
	// Whether it found anything besides the files it could not read, which is
	// what decides between "found possible secrets" and "nothing was found".
	// A truncation sentinel counts as found: the rows it stands for are not
	// here to say otherwise, and the stronger warning is the safe mistake.
	const incompleteFoundSomething = incompleteFindings.some(
		(r) => r.reason !== SCAN_FAILED_REASON,
	);
	const incompleteNamesUnreadable = incompleteFindings.some(
		(r) => r.reason === SCAN_FAILED_REASON,
	);
	const historyButton = (
		<div>
			<Button variant="outline" onClick={onOpenHistory}>
				<HistoryIcon className="size-4" aria-hidden="true" />
				{t("deferredScanHistoryButton")}
			</Button>
		</div>
	);

	if (deferredScan === "PENDING") {
		return (
			// `status`, not `alert`: the scan is running and nothing is
			// wrong yet. It appears on a poll, with nothing to announce it.
			<Alert variant="warning" role="status">
				<AlertTriangleIcon aria-hidden="true" />
				<AlertTitle>
					{t("deferredScanPendingTitle", {
						version: published.version,
					})}
				</AlertTitle>
				<AlertDescription>
					{t("deferredScanPendingBody")}
				</AlertDescription>
			</Alert>
		);
	}
	if (deferredScan === "ISSUES_FOUND") {
		return (
			<Alert variant="error">
				<AlertTriangleIcon aria-hidden="true" />
				<AlertTitle>
					{t("deferredScanIssuesTitle", {
						version: published.version,
					})}
				</AlertTitle>
				<AlertDescription className="flex flex-col gap-3">
					<p>
						{t("deferredScanIssuesBody", {
							version: published.version,
						})}
					</p>
					{published.deferredScanFindings &&
					published.deferredScanFindings.length > 0 ? (
						<InstructionFindingsTable
							findings={published.deferredScanFindings}
							className="text-foreground"
						/>
					) : null}
					{historyButton}
				</AlertDescription>
			</Alert>
		);
	}
	if (deferredScan === "INCOMPLETE" && incompleteFoundSomething) {
		return (
			// A scan that could not check every file but found something
			// in the rest: what it found is shown, as for ISSUES_FOUND,
			// with the files it could not read among the rows.
			<Alert variant="error">
				<AlertTriangleIcon aria-hidden="true" />
				<AlertTitle>
					{t("deferredScanIncompleteFindingsTitle", {
						version: published.version,
					})}
				</AlertTitle>
				<AlertDescription className="flex flex-col gap-3">
					<p>
						{/* "Marked" copy only when a row IS marked: a
						    verdict recorded before the scan named its
						    unreadable files has none to point at. */}
						{t(
							incompleteNamesUnreadable
								? "deferredScanIncompleteFindingsUnreadableBody"
								: "deferredScanIncompleteFindingsBody",
							{ version: published.version },
						)}
					</p>
					<InstructionFindingsTable
						findings={incompleteFindings}
						className="text-foreground"
					/>
					{historyButton}
				</AlertDescription>
			</Alert>
		);
	}
	if (deferredScan === "INCOMPLETE") {
		return (
			// Nothing found. When the scan named the files it could not
			// read, they are listed; a verdict with no file to name (the
			// workflow's last resort, or the reaper's) keeps the plain copy.
			<Alert variant="warning">
				<AlertTriangleIcon aria-hidden="true" />
				<AlertTitle>
					{t("deferredScanIncompleteTitle", {
						version: published.version,
					})}
				</AlertTitle>
				{incompleteFindings.length > 0 ? (
					<AlertDescription className="flex flex-col gap-3">
						<p>{t("deferredScanIncompleteUnreadableBody")}</p>
						<InstructionFindingsTable
							findings={incompleteFindings}
							className="text-foreground"
						/>
					</AlertDescription>
				) : (
					<AlertDescription>
						{t("deferredScanIncompleteBody")}
					</AlertDescription>
				)}
			</Alert>
		);
	}
	return null;
}
