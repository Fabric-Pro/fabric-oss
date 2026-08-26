"use client";

import { ListChecksIcon } from "lucide-react";
import { useTranslations } from "next-intl";

export function JobsEmptyState() {
	const t = useTranslations("app.jobs");
	return (
		<div className="relative flex flex-col items-center justify-center px-6 py-12 text-center">
			<div
				aria-hidden
				className="absolute inset-0 opacity-40 [background-image:radial-gradient(circle,_var(--color-muted-foreground)_1px,_transparent_1px)] [background-size:16px_16px]"
			/>
			<div className="relative flex size-12 items-center justify-center rounded-full bg-card text-muted-foreground shadow-sm">
				<ListChecksIcon className="size-5" />
			</div>
			<p className="relative mt-4 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
				{t("sectionLabel")}
			</p>
			<h3 className="relative mt-2 font-serif text-xl text-foreground">
				{t("empty.title")}
			</h3>
			{/* Guidance, not just absence: the empty state has to explain what
			    would appear here, or it reads as "broken" rather than "idle". */}
			<p className="relative mt-1 max-w-xs text-sm text-muted-foreground">
				{t("empty.description")}
			</p>
		</div>
	);
}
