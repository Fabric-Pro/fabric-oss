"use client";

import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { PublishBeforeScanOption } from "./PublishBeforeScanOption";

/**
 * The two verdicts this dialog can be opened for — a scan that TERMINATED
 * with the version flagged. PENDING is deliberately excluded: History
 * refuses a still-running scan unconditionally, with no acknowledgement to
 * offer here (`InstructionsHistory`'s `SCAN_PENDING_STATUS`), so this dialog
 * never opens for one.
 */
type FlaggedScanStatus = "ISSUES_FOUND" | "INCOMPLETE";

/**
 * History's "publish anyway" flow for a version flagged by the after-publish
 * secret scan (Fizzy #2760).
 *
 * A version whose deferred scan finished flagged — ISSUES_FOUND or
 * INCOMPLETE — is refused by the server unless the caller acknowledges
 * publishing it anyway — the same choice, in the same words, as the upload
 * dialog's own fast-path option (`PublishBeforeScanOption`, rendered here
 * with `publishOnReady` fixed true since this dialog's only purpose is that
 * choice). The confirm button stays disabled until both its checkbox and its
 * acknowledgement are ticked, mirroring the upload dialog's own gate.
 *
 * Mounted only while `InstructionsHistory` holds a row to confirm, so closing
 * it (cancelling or a successful publish) unmounts it and discards its ticks
 * along with it — there is nothing to reset by hand.
 */
export function PublishFlaggedVersionDialog({
	open,
	onOpenChange,
	version,
	rollback,
	scanStatus,
	pending,
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	version: number;
	/** Whether publishing this version would take the project BACK to it. */
	rollback: boolean;
	scanStatus: FlaggedScanStatus;
	/** The shared publish mutation's pending state, so Confirm cannot double-fire. */
	pending: boolean;
	onConfirm: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.history");
	const [checked, setChecked] = useState(false);
	const [acknowledged, setAcknowledged] = useState(false);
	const scanSentenceKey: Record<FlaggedScanStatus, string> = {
		ISSUES_FOUND: "flaggedScanIssuesSentence",
		INCOMPLETE: "flaggedScanIncompleteSentence",
	};
	const ready = checked && acknowledged;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("flaggedDialogTitle")}</DialogTitle>
					<DialogDescription>
						{t(rollback ? "rollbackConfirm" : "publishConfirm", {
							version,
						})}
					</DialogDescription>
				</DialogHeader>
				<p className="text-muted-foreground text-sm">
					{t(scanSentenceKey[scanStatus])}
				</p>
				<PublishBeforeScanOption
					idPrefix="history-flagged"
					publishOnReady
					checked={checked}
					onCheckedChange={setChecked}
					acknowledged={acknowledged}
					onAcknowledgedChange={setAcknowledged}
					disabled={pending}
				/>
				<DialogFooter>
					<Button
						variant="outline"
						disabled={pending}
						onClick={() => onOpenChange(false)}
					>
						{t("cancelAction")}
					</Button>
					<Button disabled={pending || !ready} onClick={onConfirm}>
						{t("confirmAction")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
