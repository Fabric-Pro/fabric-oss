"use client";

import { useTranslations } from "next-intl";
import {
	type SelectionSummaryModel,
	translateSelectionMessage,
} from "./lib/selection-row";
import type { RepositorySyncNamespace } from "./RepositorySyncSelectionTree";

/**
 * The line under the selection tree that says what will sync (Fizzy #2750
 * §6). The count is live (`<output>`, announced politely as it changes) and
 * worded so it never promises the number: the run can still skip a file.
 * With nothing ticked it says so, and that line (`nothingSelectedId`) is
 * the reason the dialog's Save points at.
 */
export function SelectionSummary({
	namespace,
	summary,
	nothingSelectedId,
}: {
	namespace: RepositorySyncNamespace;
	summary: SelectionSummaryModel;
	nothingSelectedId: string;
}) {
	const t = useTranslations(namespace);
	if (summary.nothingSelected) {
		return (
			<p id={nothingSelectedId} className="text-muted-foreground text-xs">
				{translateSelectionMessage(t, summary.nothingSelected)}
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-0.5 text-muted-foreground text-xs">
			<p>
				{summary.lead ? (
					<span className="text-foreground">
						{translateSelectionMessage(t, summary.lead)}
					</span>
				) : null}
				{summary.count ? (
					<>
						{" "}
						<output>
							{translateSelectionMessage(t, summary.count)}
						</output>
					</>
				) : null}
			</p>
			{summary.notes.map((note) => (
				<p key={note.key}>{translateSelectionMessage(t, note)}</p>
			))}
		</div>
	);
}
