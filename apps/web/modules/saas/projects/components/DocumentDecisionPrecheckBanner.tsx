"use client";

import {
	countDistinctDecisions,
	extractDecisionPrecheck,
} from "@repo/agent-types";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { AlertTriangleIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

type Props = {
	projectId: string;
	documentId: string;
	organizationId: string | null;
	/** Raw `ProjectDocument.decisionPrecheck` JSON from the document read. */
	decisionPrecheck: unknown;
	/** The document's current saved content hash, for staleness comparison. */
	currentContentHash: string | null;
	/** Called after the override is logged so the parent can refresh the read. */
	onAcknowledged?: () => void;
};

/**
 * Inline warning shown above the editor when the async decision pre-check
 * flagged the generated document as contradicting one or more logged
 * architecture decisions.
 *
 * Renders only while the finding is fresh — `status: "conflicts"` AND the judged
 * `checkedContentHash` still matches the document's current content hash; a
 * later edit/regeneration changes the hash and the warning silently disappears.
 *
 * "Keep anyway" is the logged override + accept: it records the immutable
 * `decision.override_accepted` audit row(s) and clears the finding. Discard /
 * regenerate / revert via the editor's version-history controls is the
 * not-logged cancel equivalent and never reaches this banner. A `role="alert"`
 * region (surfaced after an async check completes), keyboard-operable, amber
 * pairing that clears WCAG AA in light + dark.
 */
export function DocumentDecisionPrecheckBanner({
	projectId,
	documentId,
	organizationId,
	decisionPrecheck,
	currentContentHash,
	onAcknowledged,
}: Props) {
	const t = useTranslations("projects.decisionPrecheck");
	const [acknowledged, setAcknowledged] = useState(false);
	const acknowledgeMutation = useMutation({
		mutationFn: () =>
			orpcClient.projects.documents.acknowledgeDecisionPrecheck({
				projectId,
				documentId,
				organizationId,
			}),
		onSuccess: () => {
			setAcknowledged(true);
			onAcknowledged?.();
		},
		onError: () => {
			// "Keep anyway" is the sole mutating control here and its whole point
			// is to write the immutable override audit row. On failure onSuccess
			// never fires, so without this the spinner just stops and the banner
			// re-renders unchanged — the reviewer has no way to tell the override
			// was NOT logged. Surface a toast and an inline (AT-announced) error.
			toast.error(t("keepAnywayError"));
		},
	});

	const precheck = extractDecisionPrecheck(decisionPrecheck);
	const isFresh =
		precheck?.status === "conflicts" &&
		!!precheck.checkedContentHash &&
		precheck.checkedContentHash === currentContentHash;

	if (acknowledged || !precheck || !isFresh) {
		return null;
	}

	const count = countDistinctDecisions(precheck.findings);

	return (
		<Alert className="mx-4 mt-2 w-auto border-amber-500/30 bg-amber-500/10 text-amber-700 [&>svg]:text-amber-700 dark:text-amber-400 dark:[&>svg]:text-amber-400">
			<AlertTriangleIcon aria-hidden="true" />
			<AlertTitle>{t("documentBannerTitle", { count })}</AlertTitle>
			<AlertDescription className="text-amber-700 dark:text-amber-400">
				<p>{t("documentBannerBody")}</p>
				<ul className="mt-1 space-y-1">
					{precheck.findings.map((finding, index) => (
						<li key={`${finding.decisionId}-${index}`}>
							<span className="font-medium">
								{finding.decisionIdentifier} —{" "}
								{finding.decisionTitle}
							</span>{" "}
							·{" "}
							{finding.conflictType === "reintroduces_rejected"
								? t("conflictType.reintroduces_rejected")
								: t("conflictType.violates_accepted")}
							{finding.natureOfConflict && (
								<span className="block">
									{finding.natureOfConflict}
								</span>
							)}
						</li>
					))}
				</ul>
				<div className="mt-2">
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={acknowledgeMutation.isPending}
						aria-label={t("keepAnywayAria")}
						onClick={() => acknowledgeMutation.mutate()}
					>
						{acknowledgeMutation.isPending && (
							<Loader2Icon
								className="mr-1.5 size-3.5 animate-spin"
								aria-hidden="true"
							/>
						)}
						{t("keepAnyway")}
					</Button>
					{acknowledgeMutation.isError && (
						<p
							role="alert"
							className="mt-2 text-sm text-destructive"
						>
							{t("keepAnywayError")}
						</p>
					)}
				</div>
			</AlertDescription>
		</Alert>
	);
}
