"use client";

import type { InstructionRejection } from "@repo/database";
import { Button } from "@ui/components/button";
import { AlertTriangleIcon, UploadIcon } from "lucide-react";
import { useTranslations } from "next-intl";

// `capRejections` (packages/temporal/src/activities/project-instructions.ts)
// caps a gate's rejection list at 100 and appends this sentinel row instead
// of an unbounded array — recognizable by `reason`, never a real file.
const TRUNCATED_REASON = "truncated";

/**
 * Explains a rejected upload file by file, while whatever version was
 * published stays published. `detail` (set only when `reason === "secret"`)
 * is the scan rule id, mapped to a human label via `secretLabels`; any other
 * `reason` (hash/size mismatch, missing, or a failed scan) maps via
 * `reasonLabels`. A trailing `reason === "truncated"` row is not a file —
 * it is excluded from both the title's count and the table, and rendered
 * instead as a translated summary line built from its `detail` (`"<n>
 * more"`).
 */
export function InstructionsRejectedBanner({
	rejection,
	onUploadAgain,
}: {
	rejection: InstructionRejection[];
	onUploadAgain: () => void;
}) {
	const t = useTranslations("projects.codingInstructions.rejectedBanner");
	const secretLabels = t.raw("secretLabels") as Record<string, string>;
	const reasonLabels = t.raw("reasonLabels") as Record<string, string>;
	const truncatedRow = rejection.find((r) => r.reason === TRUNCATED_REASON);
	const rows = rejection.filter((r) => r.reason !== TRUNCATED_REASON);
	const secretCount = new Set(
		rows.filter((r) => r.reason === "secret").map((r) => r.path),
	).size;
	const title =
		secretCount > 0
			? t(
					secretCount === 1
						? "titleSecretsSingular"
						: "titleSecretsPlural",
					{ count: secretCount },
				)
			: t(
					rows.length === 1
						? "titleChecksSingular"
						: "titleChecksPlural",
					{ count: rows.length },
				);
	return (
		<div className="overflow-hidden rounded-lg border border-destructive/40 bg-destructive/5">
			<div className="flex items-start gap-3 p-5">
				<AlertTriangleIcon
					className="mt-0.5 size-5 text-destructive"
					aria-hidden="true"
				/>
				<div className="flex flex-col gap-1">
					<h2 className="font-semibold text-base text-destructive">
						{title}
					</h2>
					<p className="max-w-prose">{t("body")}</p>
				</div>
			</div>
			<div className="mx-5 mb-5 overflow-hidden rounded-md border border-border bg-background">
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
			<div className="px-5 pb-5">
				<Button onClick={onUploadAgain}>
					<UploadIcon className="size-4" aria-hidden="true" />
					{t("uploadAgain")}
				</Button>
			</div>
		</div>
	);
}
