"use client";

import { Button } from "@ui/components/button";
import { MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ColorModeToggle() {
	const { resolvedTheme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	// Avoid hydration mismatch by only rendering after mount
	useEffect(() => {
		setMounted(true);
	}, []);

	const toggleTheme = () => {
		setTheme(resolvedTheme === "dark" ? "light" : "dark");
	};

	if (!mounted) {
		// Return placeholder during SSR to avoid hydration mismatch
		return (
			<Button
				variant="ghost"
				size="icon"
				disabled
				aria-label="Toggle theme"
			>
				<MoonIcon className="size-4" />
			</Button>
		);
	}

	return (
		<Button
			variant="ghost"
			size="icon"
			onClick={toggleTheme}
			data-test="color-mode-toggle"
			aria-label={
				resolvedTheme === "dark"
					? "Switch to light mode"
					: "Switch to dark mode"
			}
			title={
				resolvedTheme === "dark"
					? "Switch to light mode"
					: "Switch to dark mode"
			}
		>
			{resolvedTheme === "dark" ? (
				<SunIcon className="size-4" />
			) : (
				<MoonIcon className="size-4" />
			)}
		</Button>
	);
}
