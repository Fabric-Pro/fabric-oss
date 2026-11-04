"use client";

/**
 * The AI rules review as Rules health shows it, from its structured findings
 * (`reviewRules`): one section per shared category, in the shared order and
 * under the shared headings, and the counts line the panel and the edits
 * dialog both show, so the two can never tell different stories.
 */

import type {
	RuleFinding,
	RuleFindingCategory,
	RuleFindingsSummary,
} from "@repo/instructions/rule-findings";
import { RULE_FINDING_CATEGORIES } from "@repo/instructions/rule-findings";
import {
	RULE_FINDING_HEADINGS,
	RULE_FINDING_LABELS,
	ruleReviewSummaryLine,
} from "@saas/projects/lib/rule-suggestions";
import { Badge } from "@ui/components/badge";
import { Markdown } from "@ui/components/markdown";

/**
 * A summary's Markdown at the panel's own size: headings no larger than the
 * text around them, and tight block spacing.
 */
const REVIEW_MARKDOWN_CLASS =
	"prose-headings:mt-3 prose-headings:mb-1 prose-headings:font-semibold prose-headings:text-sm prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-pre:my-2";

export function RuleCategoryBadges({
	categories,
}: {
	categories: readonly RuleFindingCategory[];
}) {
	if (categories.length === 0) {
		return null;
	}
	return (
		<span className="flex flex-wrap gap-1">
			{categories.map((category) => (
				<Badge
					key={category}
					variant="outline"
					data-testid={`rule-category-${category}`}
				>
					{RULE_FINDING_LABELS[category]}
				</Badge>
			))}
		</span>
	);
}

export function RuleReviewSummary({
	summary,
}: {
	summary: RuleFindingsSummary;
}) {
	return (
		<p data-testid="rule-review-summary" className="font-medium text-xs">
			{ruleReviewSummaryLine(summary)}
		</p>
	);
}

export function RuleReviewFindings({
	findings,
}: {
	findings: readonly RuleFinding[];
}) {
	const sections = RULE_FINDING_CATEGORIES.map((category) => ({
		category,
		items: findings.filter((finding) => finding.category === category),
	})).filter((section) => section.items.length > 0);
	if (sections.length === 0) {
		return (
			<p className="text-muted-foreground text-xs">
				The review found nothing to change.
			</p>
		);
	}
	return (
		<div className="flex flex-col gap-3">
			{sections.map((section) => (
				<section
					key={section.category}
					aria-labelledby={`rule-review-${section.category}`}
					className="flex flex-col gap-1"
				>
					<h3
						id={`rule-review-${section.category}`}
						className="font-semibold text-sm"
					>
						{RULE_FINDING_HEADINGS[section.category]}
					</h3>
					<ul className="flex flex-col gap-2">
						{section.items.map((finding, index) => (
							<li
								key={`${section.category}-${index}`}
								className="flex flex-col gap-0.5 text-xs"
							>
								<p className="break-all">
									{finding.files.map((file) => (
										<code key={file} className="mr-2">
											{file}
										</code>
									))}
								</p>
								<Markdown className={REVIEW_MARKDOWN_CLASS}>
									{finding.summary}
								</Markdown>
							</li>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}
