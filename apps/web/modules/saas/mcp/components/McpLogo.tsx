"use client";

import Image from "next/image";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

interface McpLogoProps {
	className?: string;
	size?: number;
}

export function McpLogo({ className = "", size = 24 }: McpLogoProps) {
	const { resolvedTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	// Avoid hydration mismatch
	useEffect(() => {
		setMounted(true);
	}, []);

	if (!mounted) {
		// Return a placeholder during SSR to avoid hydration mismatch
		return (
			<div className={className} style={{ width: size, height: size }} />
		);
	}

	// Use dark PNG for dark mode, SVG for light mode
	const logoSrc =
		resolvedTheme === "dark" ? "/images/mcp-dark.png" : "/images/mcp.svg";

	return (
		<Image
			src={logoSrc}
			alt="MCP"
			width={size}
			height={size}
			className={className}
		/>
	);
}
