"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { MonitorCogIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

const COLOR_MODE_OPTIONS = [
	{ value: "system", icon: MonitorCogIcon, label: "System" },
	{ value: "light", icon: SunIcon, label: "Light" },
	{ value: "dark", icon: MoonIcon, label: "Dark" },
] as const;

export function ColorModeToggle() {
	const { setTheme, theme } = useTheme();
	const [mounted, setMounted] = useState(false);
	const [value, setValue] = useState<string>("system");

	useEffect(() => {
		setMounted(true);
	}, []);

	useEffect(() => {
		if (theme) {
			setValue(theme);
		}
	}, [theme]);

	const activeIndex = COLOR_MODE_OPTIONS.findIndex((o) => o.value === value);

	if (!mounted) {
		return (
			<div className="relative inline-flex items-center gap-0 rounded-full bg-muted p-0.5">
				<div
					className="absolute left-0.5 top-0.5 h-7 w-7 rounded-full bg-background shadow-sm border border-border"
					aria-hidden="true"
				/>
				{COLOR_MODE_OPTIONS.map((option, index) => {
					const Icon = option.icon;
					return (
						<button
							key={option.value}
							type="button"
							className={cn(
								"relative z-10 flex h-7 w-7 items-center justify-center rounded-full transition-colors",
								index === 0
									? "text-foreground"
									: "text-muted-foreground",
							)}
							aria-label={`${option.label} mode`}
							aria-pressed={index === 0}
							disabled
						>
							<Icon className="size-3.5" />
						</button>
					);
				})}
			</div>
		);
	}

	return (
		<TooltipProvider delayDuration={0}>
			<div className="relative inline-flex items-center gap-0 rounded-full bg-muted p-0.5">
				{/* Sliding active indicator */}
				<div
					className="absolute left-0.5 top-0.5 h-7 w-7 rounded-full bg-background shadow-sm border border-border transition-transform duration-200 ease-in-out"
					style={{ transform: `translateX(${activeIndex * 100}%)` }}
					aria-hidden="true"
				/>
				{COLOR_MODE_OPTIONS.map((option) => {
					const Icon = option.icon;
					const isActive = option.value === value;
					return (
						<Tooltip key={option.value}>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={() => {
										setValue(option.value);
										setTheme(option.value);
									}}
									className={cn(
										"relative z-10 flex h-7 w-7 items-center justify-center rounded-full transition-colors",
										"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
										isActive
											? "text-foreground"
											: "text-muted-foreground hover:text-foreground",
									)}
									aria-label={`${option.label} mode`}
									aria-pressed={isActive}
								>
									<Icon className="size-3.5" />
								</button>
							</TooltipTrigger>
							<TooltipContent>{option.label}</TooltipContent>
						</Tooltip>
					);
				})}
			</div>
		</TooltipProvider>
	);
}
