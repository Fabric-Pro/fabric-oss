"use client";

import { cn } from "@ui/lib";
import type React from "react";

/** A small segmented control (two to four options). */
export function Segmented<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: { value: T; label: string; icon?: React.ReactNode }[];
	onChange: (v: T) => void;
}) {
	return (
		<div className="space-y-1.5">
			<p className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
				{label}
			</p>
			<div
				role="group"
				aria-label={label}
				className="flex rounded-md border border-border/60 p-0.5"
			>
				{options.map((o) => {
					const active = o.value === value;
					return (
						<button
							key={o.value}
							type="button"
							aria-pressed={active}
							onClick={() => onChange(o.value)}
							className={cn(
								"flex flex-1 items-center justify-center gap-1 whitespace-nowrap rounded px-1.5 py-1 font-medium text-xs transition-colors",
								active
									? "bg-primary text-primary-foreground"
									: "text-muted-foreground hover:bg-accent hover:text-foreground",
							)}
						>
							{o.icon}
							{o.label}
						</button>
					);
				})}
			</div>
		</div>
	);
}
