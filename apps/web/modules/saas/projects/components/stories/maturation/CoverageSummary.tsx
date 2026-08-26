"use client";

import { CoverageRing } from "@saas/projects/components/test-cases/CoverageRing";
import { useTranslations } from "next-intl";

/**
 * How much of this feature's specification is actually covered, as one figure.
 *
 * The traceability matrix below already contains this, row by row. It is
 * repeated here because "are we near done?" is a question people ask before
 * they are willing to read forty rows, and a matrix answers it only by being
 * counted — which nobody does.
 *
 * The denominator is acceptance CRITERIA, not cases. Ten cases against one
 * criterion is not coverage; it is ten cases against one criterion, and a
 * percentage over case count would call that a finished feature.
 */
export function CoverageSummary({
	criteria,
	covered,
	cases,
	truncated,
}: {
	criteria: number;
	covered: number;
	cases: number;
	/** The linked-case list is paginated and not fully loaded. */
	truncated: boolean;
}) {
	const t = useTranslations("projects.stories.maturation.qa.coverageSummary");

	if (criteria === 0) {
		return null;
	}

	const pct = Math.round((covered / criteria) * 100);
	const gap = criteria - covered;

	return (
		<section
			aria-labelledby="qa-coverage-summary"
			className="rounded-xl border bg-card p-4"
		>
			<h3 id="qa-coverage-summary" className="app-editorial-label">
				{t("heading")}
			</h3>

			<div className="mt-3 flex items-center gap-4">
				<CoverageRing
					value={pct}
					ariaLabel={t("ringAria", { pct, covered, criteria })}
				/>
				<div className="min-w-0">
					<p className="font-semibold text-foreground text-lg tabular-nums">
						{t("coveredOf", { covered, criteria })}
					</p>
					<p className="text-muted-foreground text-xs leading-relaxed">
						{gap > 0 ? t("gap", { count: gap }) : t("noGap")}
					</p>
				</div>
			</div>

			<p className="mt-3 border-border/60 border-t pt-3 text-muted-foreground text-xs leading-relaxed">
				{t("caseCount", { count: cases })}
				{truncated && ` ${t("truncated")}`}
			</p>
		</section>
	);
}
