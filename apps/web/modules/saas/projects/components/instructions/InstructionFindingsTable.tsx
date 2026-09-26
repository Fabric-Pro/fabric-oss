"use client";

import type { InstructionRejection } from "@repo/database";
import { useTranslations } from "next-intl";

// `capRejections` (packages/temporal/src/activities/project-instructions.ts)
// caps a gate's rejection list at 100 and appends this sentinel row instead
// of an unbounded array — recognizable by `reason`, never a real file.
export const TRUNCATED_REASON = "truncated";

/**
 * One row per finding: the file, what was found, and where — the table the
 * rejected-upload banner has always shown, extracted so the published view
 * can show a deferred secret scan's findings (Fizzy #2737) in the same shape
 * and with the same labels. Both lists are `InstructionRejection[]` written by
 * the same activity module, so one rendering serves both.
 *
 * `detail` (set only when `reason === "secret"`) is the scan rule id, mapped
 * to a human label via `secretLabels`; any other `reason` maps via
 * `reasonLabels`. A trailing `reason === "truncated"` row is not a file — it
 * is left out of the table and rendered as a translated summary line built
 * from its `detail` (`"<n> more"`).
 */
export function InstructionFindingsTable({
	findings,
	className,
}: {
	findings: InstructionRejection[];
	/** Placement classes from the caller (margins); the table styles itself. */
	className?: string;
}) {
	const t = useTranslations("projects.codingInstructions.rejectedBanner");
	const secretLabels = t.raw("secretLabels") as Record<string, string>;
	const reasonLabels = t.raw("reasonLabels") as Record<string, string>;
	const truncatedRow = findings.find((r) => r.reason === TRUNCATED_REASON);
	const rows = findings.filter((r) => r.reason !== TRUNCATED_REASON);
	return (
		<div
			className={`${className ? `${className} ` : ""}overflow-hidden rounded-md border border-border bg-background`}
		>
			<div className="grid grid-cols-[1fr_220px_80px] gap-3 bg-muted px-3.5 py-2 font-medium text-muted-foreground text-xs">
				<span>{t("columnFile")}</span>
				<span>{t("columnFound")}</span>
				<span className="text-right">{t("columnWhere")}</span>
			</div>
			{rows.map((r, i) => (
				<div
					key={`${r.path}-${i}`}
					className="grid grid-cols-[1fr_220px_80px] items-center gap-3 border-border border-t px-3.5 py-2.5"
				>
					<code className="text-xs">{r.path}</code>
					<span className="text-muted-foreground text-sm">
						{r.reason === "secret"
							? r.detail?.startsWith("filename:")
								? t("credentialFile")
								: (secretLabels[r.detail ?? ""] ?? r.detail)
							: (reasonLabels[r.reason] ?? r.reason)}
					</span>
					<span className="text-right font-mono text-muted-foreground text-xs">
						{r.line ? t("lineLabel", { line: r.line }) : ""}
					</span>
				</div>
			))}
			{truncatedRow ? (
				<p className="border-border border-t px-3.5 py-2.5 text-muted-foreground text-xs">
					{t("truncatedSummary", {
						detail: truncatedRow.detail ?? "",
					})}
				</p>
			) : null}
		</div>
	);
}
