"use client";

/**
 * Severity-rubric editor (G5) — four fixed rows (Critical / High / Medium /
 * Low) whose definitions the user can edit. The rubric is injected into the
 * scanner prompt so the model bands findings the way this project wants. Like
 * custom rules, it applies on the NEXT scan and never re-grades existing
 * findings (the (i) note states this).
 *
 * Controlled: the parent (`ScanConfigCard`) owns the draft array and dirties on
 * change, exactly like the custom-rules list.
 */

import { Badge } from "@ui/components/badge";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { useId } from "react";
import {
	type ScanSeverity,
	SEVERITY_BADGE_VARIANT,
	SEVERITY_LABEL,
	SEVERITY_ORDER,
	type SeverityRubricEntry,
} from "./lib";
import { InfoHint } from "./ScanInfo";

export function SeverityRubricEditor({
	rubric,
	disabled,
	onChange,
}: {
	rubric: ReadonlyArray<SeverityRubricEntry>;
	disabled?: boolean;
	onChange: (next: SeverityRubricEntry[]) => void;
}) {
	const fieldId = useId();

	// Index by severity so the four rows always render in worst-first order,
	// even if the stored array is sparse or reordered.
	const bySeverity = new Map<ScanSeverity, string>();
	for (const entry of rubric) {
		bySeverity.set(entry.severity, entry.definition);
	}

	const setDefinition = (severity: ScanSeverity, definition: string) => {
		const next = SEVERITY_ORDER.map((s) => ({
			severity: s,
			definition: s === severity ? definition : (bySeverity.get(s) ?? ""),
		}));
		onChange(next);
	};

	return (
		<div className="space-y-3">
			<div className="min-w-0">
				<div className="flex items-center gap-1.5">
					<p className="font-medium text-sm">Severity rubric</p>
					<InfoHint label="About the severity rubric" wide>
						<p>
							Defines what{" "}
							<span className="font-medium text-foreground">
								Critical / High / Medium / Low
							</span>{" "}
							mean for this project. The scanner uses these
							definitions to band each finding, so you can tune
							severity to your own risk appetite.
						</p>
						<p className="mt-1.5">
							Seeded with CVSS-aligned defaults. Edits{" "}
							<span className="font-medium text-foreground">
								apply on the next scan
							</span>{" "}
							and don't re-grade existing findings — you can still
							adjust any finding's severity by hand.
						</p>
					</InfoHint>
				</div>
				<p className="text-muted-foreground text-xs">
					Describe what each severity level means for this project.
					Applies on the next scan.
				</p>
			</div>

			<ul className="space-y-2.5">
				{SEVERITY_ORDER.map((severity) => {
					const rowId = `${fieldId}-${severity}`;
					return (
						<li
							key={severity}
							className="grid gap-1.5 rounded-lg border border-border bg-background p-3 sm:grid-cols-[7rem_1fr] sm:items-start sm:gap-3"
						>
							<div className="flex items-center gap-2 pt-1.5">
								<Badge
									variant={SEVERITY_BADGE_VARIANT[severity]}
								>
									{SEVERITY_LABEL[severity]}
								</Badge>
							</div>
							<div className="grid gap-1.5">
								<Label htmlFor={rowId} className="sr-only">
									{SEVERITY_LABEL[severity]} definition
								</Label>
								<Textarea
									id={rowId}
									value={bySeverity.get(severity) ?? ""}
									onChange={(e) =>
										setDefinition(severity, e.target.value)
									}
									disabled={disabled}
									maxLength={1000}
									rows={2}
									placeholder={`What makes a finding ${SEVERITY_LABEL[severity]} in this project?`}
								/>
							</div>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
