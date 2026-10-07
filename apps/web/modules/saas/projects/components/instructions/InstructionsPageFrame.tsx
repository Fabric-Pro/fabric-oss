"use client";

import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
	InstructionsActionBar,
	type InstructionsActions,
} from "./InstructionsActionBar";

export function InstructionsPageFrame({
	actions,
	badge,
	summary,
	notice,
	children,
}: {
	actions: InstructionsActions;
	badge?: ReactNode;
	summary?: ReactNode;
	notice?: ReactNode;
	children: ReactNode;
}) {
	const t = useTranslations("projects.codingInstructions.publishedView");
	return (
		<div className="flex h-full min-h-[600px] flex-col gap-4">
			{notice}
			<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
				<div className="flex min-w-0 flex-1 basis-80 flex-col gap-0.5">
					<div className="flex flex-wrap items-center gap-2.5">
						<h1 className="whitespace-nowrap font-semibold text-xl">
							{t("heading")}
						</h1>
						<PageTourButton pageId="coding-instructions" />
						{badge}
					</div>
					{summary}
				</div>
				<InstructionsActionBar actions={actions} />
			</div>
			{children}
		</div>
	);
}
