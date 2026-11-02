"use client";

import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import type { ReactNode } from "react";

type Props = {
	eyebrow: string;
	title: string;
	description: string;
	badges?: ReactNode;
	aside: ReactNode;
	/** When set, a quiet "Get started" compass next to the title opens this
	 * page's detailed tour (renders nothing if the page has no tour). */
	getStartedPageId?: string;
};

export function ProjectSectionHero({
	eyebrow,
	title,
	description,
	badges,
	aside,
	getStartedPageId,
}: Props) {
	return (
		<div className="app-surface overflow-hidden rounded-lg">
			<div className="grid gap-0 xl:grid-cols-[minmax(0,1.5fr)_360px]">
				<div className="relative p-6 sm:p-8">
					<div className="app-dot-grid pointer-events-none absolute inset-0 opacity-[0.04] dark:opacity-[0.03]" />
					<div className="relative max-w-3xl">
						<p className="app-editorial-label">{eyebrow}</p>
						<div className="mt-2.5 flex items-center gap-1.5">
							<h2 className="font-sans text-xl font-semibold tracking-[-0.015em] text-foreground sm:text-2xl">
								{title}
							</h2>
							{getStartedPageId ? (
								<PageTourButton pageId={getStartedPageId} />
							) : null}
						</div>
						<p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
							{description}
						</p>
						{badges ? (
							<div className="mt-6 flex flex-wrap gap-2">
								{badges}
							</div>
						) : null}
					</div>
				</div>

				<div className="border-t border-border/70 bg-muted/25 p-6 xl:border-t-0 xl:border-l">
					{aside}
				</div>
			</div>
		</div>
	);
}
