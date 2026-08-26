"use client";

import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useState } from "react";

interface ThemeToggleProps {
	variant?: "floating" | "inline";
	className?: string;
}

/**
 * Theme toggle button that can render as a floating control (default)
 * or inline element when embedded inside toolbars.
 */
export function ThemeToggle({
	variant = "floating",
	className,
}: ThemeToggleProps) {
	const { resolvedTheme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	// Avoid hydration mismatch by only rendering after mount
	useEffect(() => {
		setMounted(true);
	}, []);

	const buttonClasses = useMemo(() => {
		const baseClasses = "rounded-lg border bg-card";
		const variantClasses =
			variant === "floating"
				? "fixed right-20 top-8 z-50 shadow-lg hover:bg-accent transition-colors"
				: "shadow-sm hover:bg-muted";

		return cn(baseClasses, variantClasses, className);
	}, [className, variant]);

	const toggleTheme = () => {
		setTheme(resolvedTheme === "dark" ? "light" : "dark");
	};

	if (!mounted) {
		return (
			<Button
				variant="ghost"
				size="icon"
				className={buttonClasses}
				disabled
			>
				<SunIcon className="size-4" aria-hidden="true" />
			</Button>
		);
	}

	return (
		<Button
			variant="ghost"
			size="icon"
			className={buttonClasses}
			onClick={toggleTheme}
			aria-label={
				resolvedTheme === "dark"
					? "Switch to light mode"
					: "Switch to dark mode"
			}
		>
			{resolvedTheme === "dark" ? (
				<SunIcon className="size-4" aria-hidden="true" />
			) : (
				<MoonIcon className="size-4" aria-hidden="true" />
			)}
		</Button>
	);
}
