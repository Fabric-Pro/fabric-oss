"use client";

import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import type { ReactNode } from "react";

type PageHeaderProps = {
	title: string;
	description?: string;
	/** Backwards-compatible alias for description. */
	subtitle?: string;
	label?: string;
	actions?: ReactNode;
	/**
	 * Optional element rendered inline, right after the title — e.g. an info
	 * (i) popover that explains the page. Additive; existing callers are
	 * unaffected.
	 */
	titleAdornment?: ReactNode;
	/**
	 * When set, a quiet "Get started" compass appears next to the title that
	 * opens this page's detailed tour. Renders nothing if the page has no tour,
	 * so it's safe to pass on any page.
	 */
	getStartedPageId?: string;
	className?: string;
};

export function PageHeader({
	title,
	description,
	subtitle,
	label,
	actions,
	titleAdornment,
	getStartedPageId,
	className,
}: PageHeaderProps) {
	const body = description ?? subtitle;
	// `label` is accepted for compatibility but no longer drawn: every app
	// page sits under a breadcrumb that already names the section, so the
	// kicker repeated it and cost a line. The header is one compact block:
	// 22px title, one-line description, actions on the same row.
	void label;
	return (
		<header
			className={[
				"flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-center sm:justify-between",
				className,
			]
				.filter(Boolean)
				.join(" ")}
		>
			<div className="min-w-0">
				<div className="flex items-center gap-1.5">
					<h1 className="text-[22px] font-medium leading-7 tracking-[-0.02em] text-foreground">
						{title}
					</h1>
					{titleAdornment}
					{getStartedPageId ? (
						<PageTourButton pageId={getStartedPageId} />
					) : null}
				</div>
				{body ? (
					<p className="mt-1 max-w-2xl text-[13px] leading-5 text-muted-foreground">
						{body}
					</p>
				) : null}
			</div>
			{actions ? <div className="shrink-0">{actions}</div> : null}
		</header>
	);
}
