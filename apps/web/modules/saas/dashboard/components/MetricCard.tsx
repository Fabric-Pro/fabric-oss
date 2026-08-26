"use client";

import { Card, CardContent } from "@ui/components/card";
import { cn } from "@ui/lib";
import type { LucideIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

interface MetricCardProps {
	title: string;
	value: number | string;
	subtitle?: string;
	icon?: LucideIcon | ComponentType<{ className?: string }>;
	customIcon?: ReactNode;
	trend?: number;
	trendLabel?: string;
	iconClassName?: string;
	onClick?: () => void;
	loading?: boolean;
}

export function MetricCard({
	title,
	value,
	subtitle,
	icon: Icon,
	customIcon,
	trend,
	trendLabel,
	iconClassName,
	onClick,
	loading,
}: MetricCardProps) {
	const trendPositive = trend !== undefined && trend >= 0;

	return (
		<Card
			className={cn(
				"relative overflow-hidden transition-shadow duration-150 border",
				onClick &&
					"cursor-pointer hover:shadow-md hover:border-primary/30",
			)}
			onClick={onClick}
		>
			<CardContent className="p-4">
				{loading ? (
					<div className="space-y-3">
						<div className="h-3 w-20 animate-pulse rounded bg-muted" />
						<div className="h-8 w-14 animate-pulse rounded bg-muted" />
						<div className="h-3 w-28 animate-pulse rounded bg-muted" />
					</div>
				) : (
					<>
						{/* Label + icon */}
						<div className="flex items-center justify-between mb-2.5">
							<p className="text-[10px] font-bold text-muted-foreground uppercase tracking-[0.12em]">
								{title}
							</p>
							{customIcon ? (
								<div className="text-muted-foreground/30">
									{customIcon}
								</div>
							) : Icon ? (
								<Icon
									className={cn(
										"h-3.5 w-3.5 text-muted-foreground/25",
										iconClassName,
									)}
								/>
							) : null}
						</div>

						{/* Value */}
						<div className="mt-2.5">
							<div className="text-3xl font-extrabold tabular-nums leading-none tracking-tight">
								{value}
							</div>

							{trend !== undefined ? (
								<div
									className={cn(
										"flex items-center gap-1 mt-2 text-[11px] font-semibold",
										trendPositive
											? "text-success"
											: "text-destructive",
									)}
								>
									<span>
										{trendPositive ? "▲" : "▼"}{" "}
										{trendPositive ? "+" : ""}
										{trend}%
									</span>
									{trendLabel && (
										<span className="text-muted-foreground font-normal">
											{trendLabel}
										</span>
									)}
								</div>
							) : subtitle ? (
								<p className="text-xs text-muted-foreground mt-2 truncate">
									{subtitle}
								</p>
							) : null}
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}
