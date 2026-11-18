"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useState } from "react";

export type LikelyDuplicateReport = Awaited<
	ReturnType<typeof orpcClient.reports.instances.findDuplicates>
>["duplicates"][number];

/** The title and prompt of a report about to be created. */
export type ReportCandidate = { name: string; prompt: string };

/** Whether the person chose to continue past a warning. */
type Proceed = (continuedPastWarning: boolean) => void;

type PendingWarning = {
	duplicates: LikelyDuplicateReport[];
	proceed: Proceed;
};

function sameCandidate(a: ReportCandidate, b: ReportCandidate): boolean {
	const normalize = (value: string) =>
		value.trim().replace(/\s+/g, " ").toLowerCase();
	return (
		normalize(a.name) === normalize(b.name) &&
		normalize(a.prompt) === normalize(b.prompt)
	);
}

/**
 * Asks, before a report is created, whether one with the same title or prompt
 * already exists. Without one, creating proceeds at once; with one, the
 * warning waits for the person to cancel, continue or open the existing report.
 * A candidate they already continued past is not asked about again. The check
 * is advisory: when it cannot answer, creating proceeds.
 */
export function useLikelyDuplicateGuard({
	organizationId,
	projectId,
	acknowledged,
}: {
	organizationId: string | null;
	projectId?: string;
	acknowledged?: ReportCandidate;
}) {
	const [pending, setPending] = useState<PendingWarning | null>(null);
	const [isChecking, setIsChecking] = useState(false);

	const guard = async (candidate: ReportCandidate, proceed: Proceed) => {
		if (acknowledged && sameCandidate(candidate, acknowledged)) {
			proceed(true);
			return;
		}
		setIsChecking(true);
		let duplicates: LikelyDuplicateReport[] = [];
		try {
			const result = await orpcClient.reports.instances.findDuplicates({
				organizationId,
				projectId,
				name: candidate.name,
				prompt: candidate.prompt,
			});
			duplicates = result.duplicates;
		} catch {
			// Advisory: a check that cannot answer does not stop creating.
		}
		setIsChecking(false);
		if (duplicates.length === 0) {
			proceed(false);
			return;
		}
		setPending({ duplicates, proceed });
	};

	return {
		guard,
		isChecking,
		dialogProps: {
			duplicates: pending?.duplicates ?? null,
			onCancel: () => setPending(null),
			onContinue: () => {
				const proceed = pending?.proceed;
				setPending(null);
				proceed?.(true);
			},
		},
	};
}
