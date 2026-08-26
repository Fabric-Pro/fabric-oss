"use client";

import { cn } from "@ui/lib";
import {
	BookOpenIcon,
	CodeIcon,
	GlobeIcon,
	SearchIcon,
	ZapIcon,
} from "lucide-react";
import Image from "next/image";

function FabricIcon({
	size = 16,
	className,
}: {
	size?: number;
	className?: string;
}) {
	return (
		<>
			<Image
				src="/images/fabric-icon-black.svg"
				alt="Fabric"
				width={size}
				height={size}
				className={cn("object-contain dark:hidden", className)}
				style={{ width: size, height: size }}
			/>
			<Image
				src="/images/fabric-icon-white.svg"
				alt="Fabric"
				width={size}
				height={size}
				className={cn("hidden object-contain dark:block", className)}
				style={{ width: size, height: size }}
			/>
		</>
	);
}
import { useEffect, useState } from "react";
import { useScrollReveal } from "./v3/use-scroll-reveal";

const SERIF: React.CSSProperties = {
	fontFamily: "var(--font-serif, 'EB Garamond', Georgia, serif)",
};

// ─── Dot-grid background style ────────────────────────────────────────────────

const DOT_GRID: React.CSSProperties = {
	backgroundImage:
		"linear-gradient(to right, var(--mkt-border) 1px, transparent 1px), linear-gradient(to bottom, var(--mkt-border) 1px, transparent 1px)",
	backgroundSize: "40px 40px",
	backgroundPosition: "-1px -1px",
};

// ─── Model Picker UI ──────────────────────────────────────────────────────────

const MODELS = [
	{
		name: "Claude Opus 4.6",
		icon: "/integrations/Anthropic.svg",
		color: "#c96442",
	},
	{
		name: "GPT-4o",
		icon: "/integrations/Openai.svg",
		color: "#10a37f",
	},
	{
		name: "Gemini 1.5 Pro",
		icon: "/integrations/Gemini.svg",
		color: "#4285f4",
	},
];

const CONNECTORS = [
	{
		name: "Google Drive",
		icon: "/integrations/GoogleDrive.png",
		invertDark: false,
	},
	{ name: "Slack", icon: "/integrations/Slack.png", invertDark: false },
	{ name: "Jira", icon: "/integrations/Jira.svg", invertDark: false },
	{ name: "GitHub", icon: "/integrations/Github.png", invertDark: true },
];

function ModelPickerUI() {
	const [selectedModel, setSelectedModel] = useState(0);
	const [activeConnector, setActiveConnector] = useState(1); // Slack

	// Cycle through models and connectors
	useEffect(() => {
		const t = setInterval(() => {
			setSelectedModel((i) => (i + 1) % MODELS.length);
			setActiveConnector((i) => (i + 1) % CONNECTORS.length);
		}, 2200);
		return () => clearInterval(t);
	}, []);

	return (
		<div className="flex h-full flex-col items-start justify-center gap-3 p-5">
			{/* Model selector card */}
			<div
				className="w-full rounded-sm border border-[var(--mkt-border)] bg-[var(--mkt-bg-card)] shadow-sm"
				style={{ maxWidth: 220 }}
			>
				{MODELS.map((model, i) => (
					<div
						key={model.name}
						className={cn(
							"flex items-center gap-2.5 px-3 py-2 transition-colors duration-300",
							i === selectedModel
								? "bg-blue-50 dark:bg-blue-950/30"
								: "hover:bg-[var(--mkt-bg-hover)]",
							i < MODELS.length - 1 &&
								"border-b border-[var(--mkt-border)]",
						)}
					>
						<div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
							<Image
								src={model.icon}
								alt={model.name}
								width={16}
								height={16}
								className="object-contain"
								style={{ width: 16, height: 16 }}
							/>
						</div>
						<span
							className={cn(
								"flex-1 font-sans text-[11px] transition-colors duration-300",
								i === selectedModel
									? "font-medium text-[var(--mkt-tx-1)]"
									: "text-[var(--mkt-tx-3)]",
							)}
						>
							{model.name}
						</span>
						{i === selectedModel && (
							<div
								className="h-2 w-2 rounded-full"
								style={{ background: model.color }}
							/>
						)}
					</div>
				))}
				<div className="flex items-center gap-1.5 border-t border-[var(--mkt-border)] px-3 py-2">
					<span className="font-sans text-[10px] uppercase tracking-[0.15em] text-[var(--mkt-tx-5)]">
						Select Model
					</span>
				</div>
			</div>

			{/* Connectors card */}
			<div
				className="w-full rounded-sm border border-[var(--mkt-border)] bg-[var(--mkt-bg-card)] shadow-sm"
				style={{ maxWidth: 220 }}
			>
				<div className="flex items-center justify-between border-b border-[var(--mkt-border)] px-3 py-2">
					<span className="font-sans text-[10px] uppercase tracking-[0.15em] text-[var(--mkt-tx-5)]">
						Connectors
					</span>
					<span className="flex h-4 w-4 items-center justify-center rounded-full border border-[var(--mkt-border)] font-sans text-[9px] text-[var(--mkt-tx-5)]">
						+
					</span>
				</div>
				{CONNECTORS.map((connector, i) => (
					<div
						key={connector.name}
						className={cn(
							"flex items-center gap-2.5 px-3 py-2 transition-colors duration-300",
							i === activeConnector
								? "bg-blue-50 dark:bg-blue-950/30"
								: "",
							i < CONNECTORS.length - 1 &&
								"border-b border-[var(--mkt-border)]",
						)}
					>
						<div className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
							<Image
								src={connector.icon}
								alt={connector.name}
								width={14}
								height={14}
								className={cn(
									"object-contain",
									connector.invertDark && "dark:invert",
								)}
								style={{ width: 14, height: 14 }}
							/>
						</div>
						<span
							className={cn(
								"font-sans text-[11px] transition-colors duration-300",
								i === activeConnector
									? "font-medium text-[var(--mkt-tx-1)]"
									: "text-[var(--mkt-tx-3)]",
							)}
						>
							{connector.name}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

// ─── Chat Input UI ────────────────────────────────────────────────────────────

const TOOLS = [
	{ icon: SearchIcon, label: "Document Search" },
	{ icon: ZapIcon, label: "Image Generation" },
	{ icon: GlobeIcon, label: "Web Search" },
	{ icon: BookOpenIcon, label: "Deep Research", active: true },
	{ icon: CodeIcon, label: "Code Review" },
];

function ChatInputUI() {
	const [activeTool, setActiveTool] = useState(3);
	const [showDropdown, setShowDropdown] = useState(true);

	useEffect(() => {
		const t = setInterval(() => {
			setActiveTool((i) => (i + 1) % TOOLS.length);
		}, 1800);
		return () => clearInterval(t);
	}, []);

	return (
		<div className="flex h-full flex-col justify-center p-5">
			{/* Input card */}
			<div className="w-full border border-[var(--mkt-border)] bg-[var(--mkt-bg-card)] shadow-sm">
				{/* Input area */}
				<div className="px-4 py-3">
					<p className="font-sans text-sm text-[var(--mkt-tx-5)]">
						How can Fabric help you today
					</p>
				</div>
				{/* Toolbar */}
				<div className="flex items-center gap-2 border-t border-[var(--mkt-border)] px-3 py-2">
					<button
						type="button"
						className="flex h-6 w-6 items-center justify-center border border-[var(--mkt-border)] text-[var(--mkt-tx-5)] hover:border-[var(--mkt-tx-4)]"
					>
						<span className="font-sans text-[11px]">+</span>
					</button>
					<button
						type="button"
						className="flex h-6 w-6 items-center justify-center border border-[var(--mkt-border)] text-[var(--mkt-tx-5)]"
					>
						<svg
							width="10"
							height="10"
							viewBox="0 0 10 10"
							fill="none"
							aria-hidden="true"
						>
							<title>Settings</title>
							<rect
								x="1"
								y="4"
								width="8"
								height="1"
								fill="currentColor"
							/>
							<rect
								x="1"
								y="2"
								width="8"
								height="1"
								fill="currentColor"
							/>
							<rect
								x="1"
								y="6"
								width="8"
								height="1"
								fill="currentColor"
							/>
						</svg>
					</button>
					<div className="flex items-center gap-1.5 border border-blue-300 bg-blue-50 px-2 py-0.5 dark:border-blue-800 dark:bg-blue-950/40">
						<BookOpenIcon className="h-3 w-3 text-blue-600 dark:text-blue-400" />
						<span className="font-sans text-[10px] font-medium text-blue-600 dark:text-blue-400">
							{TOOLS[activeTool]?.label ?? "Deep Research"}
						</span>
					</div>
					<div className="flex-1" />
					<button
						type="button"
						className="flex h-6 w-6 items-center justify-center bg-[var(--mkt-tx-1)] text-[var(--mkt-bg-hero)]"
					>
						<svg
							width="10"
							height="10"
							viewBox="0 0 10 10"
							fill="none"
							aria-hidden="true"
						>
							<title>Send</title>
							<path
								d="M5 8V2M5 2L2 5M5 2L8 5"
								stroke="currentColor"
								strokeWidth="1.2"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</button>
				</div>
			</div>

			{/* Dropdown */}
			{showDropdown && (
				<div className="mt-1 border border-[var(--mkt-border)] bg-[var(--mkt-bg-card)] shadow-sm">
					{TOOLS.map((tool, i) => {
						const Icon = tool.icon;
						return (
							<div
								key={tool.label}
								className={cn(
									"flex items-center gap-2.5 px-3 py-2 font-sans text-[11px] transition-colors duration-300",
									i === activeTool
										? "bg-blue-50 text-blue-600 dark:bg-blue-950/30 dark:text-blue-400"
										: "text-[var(--mkt-tx-3)]",
									i < TOOLS.length - 1 &&
										"border-b border-[var(--mkt-border)]",
								)}
							>
								<Icon className="h-3.5 w-3.5 flex-shrink-0 opacity-70" />
								<span>{tool.label}</span>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

// ─── Chat Response UI ─────────────────────────────────────────────────────────

const SKELETON_WIDTHS = ["92%", "78%", "85%", "62%", "71%", "55%", "80%"];

function ChatResponseUI() {
	const [visibleLines, setVisibleLines] = useState(0);

	useEffect(() => {
		let t: ReturnType<typeof setTimeout>;
		if (visibleLines < SKELETON_WIDTHS.length) {
			t = setTimeout(
				() => setVisibleLines((v) => v + 1),
				visibleLines === 0 ? 600 : 300,
			);
		} else {
			t = setTimeout(() => setVisibleLines(0), 3000);
		}
		return () => clearTimeout(t);
	}, [visibleLines]);

	return (
		<div className="flex h-full flex-col justify-center p-5">
			<div className="w-full border border-[var(--mkt-border)] bg-[var(--mkt-bg-card)] shadow-sm">
				{/* Response body */}
				<div className="p-4">
					{/* Fabric icon */}
					<div className="mb-3 flex h-6 w-6 items-center justify-center">
						<FabricIcon size={20} />
					</div>

					{/* Skeleton lines */}
					<div className="space-y-2">
						{SKELETON_WIDTHS.map((width, i) => (
							<div
								key={i}
								className={cn(
									"h-2.5 rounded-sm bg-[var(--mkt-border)] transition-opacity duration-200",
									i < visibleLines
										? "opacity-100"
										: "opacity-0",
								)}
								style={{ width }}
							/>
						))}
					</div>

					{/* Badge */}
					{visibleLines >= 4 && (
						<div className="mt-3 inline-flex items-center gap-1.5 border border-[var(--mkt-border)] bg-[var(--mkt-bg-hover)] px-2 py-1">
							<div className="flex h-4 w-4 items-center justify-center">
								<FabricIcon size={14} />
							</div>
							<span className="font-sans text-[10px] text-[var(--mkt-tx-3)]">
								Fabric AI +5
							</span>
						</div>
					)}
				</div>

				{/* Source card */}
				{visibleLines >= SKELETON_WIDTHS.length && (
					<div className="border-t border-[var(--mkt-border)]">
						<div className="flex items-center justify-between px-3 py-1.5">
							<div className="flex items-center gap-1.5">
								<span className="font-sans text-[9px] text-[var(--mkt-tx-5)]">
									←
								</span>
								<span className="font-sans text-[9px] text-[var(--mkt-tx-5)]">
									→
								</span>
							</div>
							<span className="font-sans text-[9px] text-[var(--mkt-tx-5)]">
								1/6
							</span>
						</div>
						<div className="border-t border-[var(--mkt-border)] px-3 py-2">
							<div className="flex items-start gap-2">
								<div className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center">
									<FabricIcon size={14} />
								</div>
								<div className="flex-1 min-w-0">
									<p className="font-sans text-[10px] font-medium text-[var(--mkt-tx-1)]">
										Fabric: Your AI Platform for Every Team
									</p>
									<p className="mt-0.5 truncate font-sans text-[9px] text-[var(--mkt-tx-5)]">
										Fabric is the AI platform connected to
										your company's docs, apps, and pe...
									</p>
								</div>
							</div>
						</div>
					</div>
				)}

				{/* Action bar */}
				<div className="flex items-center justify-between border-t border-[var(--mkt-border)] px-3 py-1.5">
					<div className="flex items-center gap-2">
						{["⧉", "↑", "↓", "↺"].map((icon) => (
							<button
								key={icon}
								type="button"
								className="font-sans text-[11px] text-[var(--mkt-tx-5)] hover:text-[var(--mkt-tx-3)]"
							>
								{icon}
							</button>
						))}
					</div>
					<button
						type="button"
						className="flex items-center gap-1 font-sans text-[9px] text-[var(--mkt-tx-5)] hover:text-[var(--mkt-tx-3)]"
					>
						<SearchIcon className="h-2.5 w-2.5" />
						All Sources
					</button>
				</div>
			</div>
		</div>
	);
}

// ─── Feature Text Card ────────────────────────────────────────────────────────

interface FeatureCardProps {
	title: string;
	paragraphs: string[];
}

function FeatureCard({ title, paragraphs }: FeatureCardProps) {
	return (
		<div className="flex h-full flex-col justify-between p-7">
			<div>
				<p
					className="mb-4 text-[var(--mkt-tx-1)]"
					style={{
						fontFamily: "var(--font-sans)",
						fontSize: "1.1rem",
						fontWeight: 600,
						lineHeight: 1.3,
					}}
				>
					{title}
				</p>
				<div className="space-y-3">
					{paragraphs.map((text) => (
						<p
							key={text}
							className="font-sans text-sm leading-relaxed text-[var(--mkt-tx-3)]"
						>
							{text}
						</p>
					))}
				</div>
			</div>
		</div>
	);
}

// ─── Main Section ─────────────────────────────────────────────────────────────

export function FabricPlatformSection() {
	const { ref, isRevealed } = useScrollReveal();

	return (
		<section className="bg-[var(--mkt-bg-alt)] py-0">
			<div
				ref={ref}
				className={cn(
					"mx-auto max-w-6xl px-6 transition-all duration-700 lg:px-8",
					isRevealed
						? "translate-y-0 opacity-100"
						: "translate-y-6 opacity-0",
				)}
			>
				{/* Heading — right aligned, like Onyx */}
				<div className="py-12 text-right lg:py-16">
					<h2
						className="text-[var(--mkt-tx-1)]"
						style={{
							...SERIF,
							fontSize: "clamp(2rem, 5vw, 3.5rem)",
							fontWeight: 400,
							lineHeight: "1.1",
						}}
					>
						The Fabric Platform
					</h2>
				</div>

				{/* Bento grid */}
				<div
					className="grid w-full grid-cols-1 grid-rows-[auto] sm:grid-cols-2 lg:grid-cols-3"
					style={{
						...DOT_GRID,
						gap: "1px",
						border: "1px solid var(--mkt-border)",
					}}
				>
					{/* Row 1, Col 1: Powerful */}
					<div className="flex flex-col justify-between bg-[var(--mkt-bg-alt)]">
						<FeatureCard
							title="Powerful"
							paragraphs={[
								"Deep research, MCP, code interpreter, web search, and other advanced AI capabilities.",
								"Encourage collaboration with chat sharing, user feedback, and usage analytics.",
							]}
						/>
					</div>

					{/* Row 1, Col 2: Grounded Answers */}
					<div className="flex flex-col justify-between bg-[var(--mkt-bg-alt)]">
						<FeatureCard
							title="Grounded Answers"
							paragraphs={[
								"Answers grounded in your team's knowledge. Fabric combines hybrid-search, advanced RAG, contextual retrieval, and knowledge graphs for the most accurate responses.",
							]}
						/>
					</div>

					{/* Row 1, Col 3: Model picker + connectors */}
					<div
						className="flex flex-col bg-[var(--mkt-bg-alt)]"
						style={{ minHeight: 280 }}
					>
						<ModelPickerUI />
					</div>

					{/* Row 2, Col 1: Chat Input */}
					<div
						className="bg-[var(--mkt-bg-alt)]"
						style={{ minHeight: 280 }}
					>
						<ChatInputUI />
					</div>

					{/* Row 2, Col 2: Chat Response */}
					<div
						className="bg-[var(--mkt-bg-alt)]"
						style={{ minHeight: 280 }}
					>
						<ChatResponseUI />
					</div>

					{/* Row 2, Col 3: Customizable */}
					<div className="flex flex-col justify-between bg-[var(--mkt-bg-alt)]">
						<FeatureCard
							title="Customizable"
							paragraphs={[
								"Flexible configuration options for AI providers, search settings, connected apps, access controls, and much more.",
							]}
						/>
					</div>
				</div>

				{/* Bottom spacing */}
				<div className="py-12 lg:py-16" />
			</div>
		</section>
	);
}
