"use client";

import type { DecisionConflictFinding } from "@repo/agent-types";
import { AlertTriangleIcon } from "lucide-react";
import { useTranslations } from "next-intl";

type Props = {
	findings: DecisionConflictFinding[];
};

/**
 * Advisory amber note rendered inside a backlog change card when the async
 * decision pre-check flagged that change as contradicting one or more logged
 * architecture decisions. It names each conflicting decision (identifier +
 * title), the nature of the conflict, and whether the change violates an
 * accepted decision or reintroduces a rejected one.
 *
 * Advisory only — it never gates "Apply Selected". Rendered from findings that
 * already ride on the proposal at mount, so it is a `role="status"` region
 * (not `role="alert"`, which is reserved for warnings injected after an in-view
 * async check completes). Amber pairing matches the file's existing
 * inline-warning idiom (`bodyMergeFallback`) and clears WCAG AA in light + dark.
 */
export function DecisionConflictNote({ findings }: Props) {
	const t = useTranslations("projects.decisionPrecheck");
	if (findings.length === 0) {
		return null;
	}
	return (
		// biome-ignore lint/a11y/useSemanticElements: an inline contradiction warning is a polite status region, not a form output; <div role="status"> is the WAI-ARIA idiom (matches the file's other inline notes) and the explicit role is what the tests assert on.
		<div
			role="status"
			className="mt-1 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-400"
		>
			<div className="flex items-start gap-1.5">
				<AlertTriangleIcon
					className="mt-0.5 size-3.5 shrink-0"
					aria-hidden="true"
				/>
				<div className="min-w-0 space-y-1">
					<p className="font-medium">{t("changeNoteLabel")}</p>
					<ul className="space-y-1">
						{findings.map((finding, index) => (
							<li key={`${finding.decisionId}-${index}`}>
								<span className="font-medium">
									{finding.decisionIdentifier} —{" "}
									{finding.decisionTitle}
								</span>{" "}
								·{" "}
								{finding.conflictType ===
								"reintroduces_rejected"
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
				</div>
			</div>
		</div>
	);
}
