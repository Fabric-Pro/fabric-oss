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
	return (
		<header
			className={[
				"flex flex-col gap-4 border-b border-border/60 pb-5 sm:flex-row sm:items-end sm:justify-between",
				className,
			]
				.filter(Boolean)
				.join(" ")}
		>
			<div className="min-w-0">
				{label ? (
					<p className="app-editorial-label mb-2">{label}</p>
				) : null}
				<div className="flex items-center gap-1.5">
					<h1 className="text-3xl font-normal tracking-tight text-foreground/95 sm:text-4xl">
						{title}
					</h1>
					{titleAdornment}
					{getStartedPageId ? (
						<PageTourButton pageId={getStartedPageId} />
					) : null}
				</div>
				{body ? (
					<p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
						{body}
					</p>
				) : null}
			</div>
			{actions ? <div className="shrink-0">{actions}</div> : null}
		</header>
	);
}
