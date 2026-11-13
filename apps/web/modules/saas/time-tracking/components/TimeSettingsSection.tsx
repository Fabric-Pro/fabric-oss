"use client";

import type { ReactNode } from "react";
import { InfoHint } from "./InfoHint";

/** A titled group of settings with its explanation behind an (i). */
export function TimeSettingsSection({
	headingId,
	title,
	hintLabel,
	hint,
	children,
}: {
	headingId: string;
	title: string;
	hintLabel: string;
	hint: string;
	children: ReactNode;
}) {
	return (
		<section className="space-y-2" aria-labelledby={headingId}>
			<div className="flex items-center gap-1">
				<h3 id={headingId} className="font-semibold text-sm">
					{title}
				</h3>
				<InfoHint label={hintLabel}>{hint}</InfoHint>
			</div>
			{children}
		</section>
	);
}

/** One setting in a card: its label on the left, its control on the right. */
export function TimeSettingRow({
	labelId,
	label,
	children,
}: {
	labelId: string;
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 border-border border-t px-4 py-3.5 first:border-t-0">
			<span
				id={labelId}
				className="min-w-0 flex-[1_1_240px] font-medium text-sm"
			>
				{label}
			</span>
			<div className="flex items-center gap-3">{children}</div>
		</div>
	);
}
