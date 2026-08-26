"use client";

import Image from "next/image";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

interface TemporalLogoProps {
	className?: string;
	size?: number;
	variant?: "auto" | "light" | "dark";
}

export function TemporalLogo({
	className = "",
	size = 24,
	variant = "auto",
}: TemporalLogoProps) {
	const { resolvedTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	// Avoid hydration mismatch
	useEffect(() => {
		setMounted(true);
	}, []);

	if (variant === "auto" && !mounted) {
		// Return a placeholder during SSR to avoid hydration mismatch
		return (
			<div className={className} style={{ width: size, height: size }} />
		);
	}

	const logoSrc =
		variant === "light"
			? "/images/temporal-dark.svg"
			: variant === "dark"
				? "/images/temporal.svg"
				: resolvedTheme === "dark"
					? "/images/temporal-dark.svg"
					: "/images/temporal.svg";

	return (
		<Image
			src={logoSrc}
			alt="Temporal"
			width={size}
			height={size}
			className={className}
		/>
	);
}
