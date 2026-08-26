"use client";

import { cn } from "@ui/lib";
import Image from "next/image";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function Logo({ className }: { className?: string }) {
	const { resolvedTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	// Avoid hydration mismatch
	useEffect(() => {
		setMounted(true);
	}, []);

	if (!mounted) {
		// Return a placeholder during SSR to avoid hydration mismatch
		return (
			<span
				className={cn(
					"flex items-center justify-center font-semibold text-foreground leading-none",
					className,
				)}
			>
				<div className="h-8 w-[102px]" />
			</span>
		);
	}

	// Use white logo for dark mode, black logo for light mode
	const logoSrc =
		resolvedTheme === "dark"
			? "/images/fabric-white-logo.svg"
			: "/images/fabric-black-logo.svg";

	return (
		<span
			className={cn(
				"flex items-center justify-center font-semibold text-foreground leading-none",
				className,
			)}
		>
			<Image
				src={logoSrc}
				alt="Fabric AI"
				width={102}
				height={32}
				className="h-8 w-auto"
				loading="eager"
				style={{ height: 32, width: "auto", flexShrink: 0 }}
			/>
		</span>
	);
}
