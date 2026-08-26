"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Code2, Cpu } from "lucide-react";
import Image from "next/image";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

/**
 * FrameworkIcon Component
 *
 * Displays framework-specific icons for AI agent frameworks.
 * - LangGraph: Local logo from /public/images/langchain-color.png (light) or langchain-color-dark.png (dark)
 * - Other icons: Icons8 (https://icons8.com/) - see attribution in footer
 *
 * NOTE: Uses mounted state to prevent hydration mismatch for theme-dependent content.
 * See: rendering-hydration-no-flicker rule from Vercel React Best Practices
 */

interface FrameworkIconProps {
	framework: string;
	size?: number;
	showTooltip?: boolean;
	className?: string;
}

export function FrameworkIcon({
	framework,
	size = 16,
	showTooltip = true,
	className = "",
}: FrameworkIconProps) {
	// Prevent hydration mismatch for theme-dependent content
	// See: rendering-hydration-no-flicker rule from Vercel React Best Practices
	const [mounted, setMounted] = useState(false);
	const { theme, resolvedTheme } = useTheme();
	const isDark = mounted && (resolvedTheme === "dark" || theme === "dark");

	useEffect(() => {
		setMounted(true);
	}, []);

	const getFrameworkData = () => {
		switch (framework) {
			case "LANGGRAPH":
				return {
					name: "LangGraph",
					icon: (
						<Image
							src={
								isDark
									? "/images/langchain-color-dark.png"
									: "/images/langchain-color.png"
							}
							alt="LangGraph"
							width={size}
							height={size}
							className={className}
						/>
					),
				};
			case "MICROSOFT":
				return {
					name: "Microsoft",
					icon: (
						<Image
							src="https://img.icons8.com/color/48/microsoft.png"
							alt="Microsoft"
							width={size}
							height={size}
							className={className}
							unoptimized
						/>
					),
				};
			case "PYDANTIC_AI":
				return {
					name: "Pydantic AI",
					icon: (
						<Image
							src="https://img.icons8.com/color/48/python.png"
							alt="Pydantic AI"
							width={size}
							height={size}
							className={className}
							unoptimized
						/>
					),
				};
			case "CREWAI":
				return {
					name: "CrewAI",
					icon: (
						<svg
							width={size}
							height={size}
							viewBox="0 0 24 24"
							fill="none"
							className={className}
							aria-label="CrewAI"
						>
							<title>CrewAI</title>
							<circle
								cx="12"
								cy="8"
								r="2.5"
								fill="currentColor"
							/>
							<circle
								cx="7"
								cy="14"
								r="2.5"
								fill="currentColor"
								opacity="0.7"
							/>
							<circle
								cx="17"
								cy="14"
								r="2.5"
								fill="currentColor"
								opacity="0.7"
							/>
							<circle
								cx="12"
								cy="18"
								r="2"
								fill="currentColor"
								opacity="0.5"
							/>
							<path
								d="M12 10.5V15.5M9.5 14L7 14M14.5 14H17"
								stroke="currentColor"
								strokeWidth="1.5"
								opacity="0.5"
							/>
						</svg>
					),
				};
			case "AUTOGEN":
				return {
					name: "AutoGen",
					icon: (
						<svg
							width={size}
							height={size}
							viewBox="0 0 24 24"
							fill="none"
							className={className}
							aria-label="AutoGen"
						>
							<title>AutoGen</title>
							<path
								d="M12 4L4 8L12 12L20 8L12 4Z"
								fill="currentColor"
								opacity="0.9"
							/>
							<path
								d="M12 12L4 16L12 20L20 16L12 12Z"
								fill="currentColor"
								opacity="0.5"
							/>
							<path
								d="M4 8V16M20 8V16"
								stroke="currentColor"
								strokeWidth="1.5"
								opacity="0.3"
							/>
						</svg>
					),
				};
			case "OPENAI":
				return {
					name: "OpenAI",
					icon: (
						<Image
							src="https://img.icons8.com/color/48/chatgpt.png"
							alt="OpenAI"
							width={size}
							height={size}
							className={className}
							unoptimized
						/>
					),
				};
			case "CUSTOM":
				return {
					name: "Custom",
					icon: <Code2 size={size} className={className} />,
				};
			default:
				return {
					name: framework,
					icon: <Cpu size={size} className={className} />,
				};
		}
	};

	const { name, icon } = getFrameworkData();

	if (!showTooltip) {
		return <div className="inline-flex items-center">{icon}</div>;
	}

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<div className="inline-flex items-center cursor-help">
						{icon}
					</div>
				</TooltipTrigger>
				<TooltipContent>
					<p className="text-xs">{name}</p>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
