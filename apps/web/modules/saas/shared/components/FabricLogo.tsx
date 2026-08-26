"use client";

import Image from "next/image";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

interface FabricLogoProps {
	className?: string;
	size?: number;
	variant?: "auto" | "light" | "dark" | "inverse";
}

export function FabricLogo({
	className = "",
	size = 24,
	variant = "auto",
}: FabricLogoProps) {
	const { resolvedTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	// Avoid hydration mismatch
	useEffect(() => {
		setMounted(true);
	}, []);

	if ((variant === "auto" || variant === "inverse") && !mounted) {
		// Return a placeholder during SSR to avoid hydration mismatch
		return (
			<div className={className} style={{ width: size, height: size }} />
		);
	}

	const iconSrc =
		variant === "light"
			? "/images/fabric-icon-white.svg"
			: variant === "dark"
				? "/images/fabric-icon-black.svg"
				: variant === "inverse"
					? resolvedTheme === "dark"
						? "/images/fabric-icon-black.svg"
						: "/images/fabric-icon-white.svg"
					: resolvedTheme === "dark"
						? "/images/fabric-icon-white.svg"
						: "/images/fabric-icon-black.svg";

	return (
		<Image
			src={iconSrc}
			alt="Fabric AI"
			width={size}
			height={size}
			className={className}
			loading="eager"
			style={{ width: size, height: size, flexShrink: 0 }}
		/>
	);
}
