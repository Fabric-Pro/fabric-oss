"use client";

import { cn } from "@ui/lib";
import {
	AlignJustify,
	ArrowRightLeft,
	ClipboardList,
	ListChecks,
	ShieldCheck,
} from "lucide-react";
import { useScrollReveal } from "./use-scroll-reveal";

function ConductorIcon({
	size = 24,
	strokeWidth = 1.5,
	style,
}: {
	size?: number;
	strokeWidth?: number;
	style?: React.CSSProperties;
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={strokeWidth}
			strokeLinecap="round"
			strokeLinejoin="round"
			style={style}
			aria-hidden="true"
		>
			{/* Head */}
			<circle cx="12" cy="4" r="2" />
			{/* Body */}
			<line x1="12" y1="6" x2="12" y2="14" />
			{/* Left arm */}
			<line x1="12" y1="9" x2="5.5" y2="6.5" />
			{/* Baton extending from left hand */}
			<line x1="5.5" y1="6.5" x2="3" y2="4" />
			{/* Right arm */}
			<line x1="12" y1="9" x2="18.5" y2="6.5" />
			{/* Legs */}
			<line x1="12" y1="14" x2="9.5" y2="20" />
			<line x1="12" y1="14" x2="14.5" y2="20" />
		</svg>
	);
}

function SpindleIcon({
	size = 24,
	strokeWidth = 1.5,
	style,
}: {
	size?: number;
	strokeWidth?: number;
	style?: React.CSSProperties;
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={strokeWidth}
			strokeLinecap="round"
			strokeLinejoin="round"
			style={style}
			aria-hidden="true"
		>
			{/* Top spike */}
			<line x1="12" y1="1" x2="12" y2="10.5" />
			{/* Whorl — oval wound thread mass */}
			<ellipse cx="12" cy="15" rx="5.5" ry="4.5" />
			{/* Thread coils on whorl */}
			<path d="M7.5 12.5Q12 11 16.5 12.5" />
			<path d="M6.5 15Q12 13.5 17.5 15" />
			<path d="M7.5 17.5Q12 16.5 16.5 17.5" />
			{/* Trailing loose thread flying off upper-right */}
			<path d="M16.5 11.5Q20 8 19 3" />
			{/* Bottom rod below whorl */}
			<line x1="12" y1="19.5" x2="12" y2="23" />
		</svg>
	);
}

function SpoolIcon({
	size = 24,
	strokeWidth = 1.5,
	style,
}: {
	size?: number;
	strokeWidth?: number;
	style?: React.CSSProperties;
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={strokeWidth}
			strokeLinecap="round"
			strokeLinejoin="round"
			style={style}
			aria-hidden="true"
		>
			{/* Spool outline: cap → top flange → body → bottom flange */}
			<path d="M9 1h6v2h6v2.5h-4v13h4v2.5H3v-2.5h4v-13H3V3h6V1z" />
			{/* Diagonal thread lines on body */}
			<line x1="9" y1="5.5" x2="17" y2="13.5" />
			<line x1="7" y1="8" x2="17" y2="18" />
			<line x1="7" y1="13" x2="12.5" y2="18.5" />
		</svg>
	);
}

const SERIF: React.CSSProperties = {
	fontFamily: "var(--font-sans, 'EB Garamond', Georgia, serif)",
};

const AGENTS = [
	{
		Icon: ConductorIcon,
		name: "Loom",
		badge: "primary",
		role: "Main Orchestrator",
		desc: "Assesses complexity and delegates to specialists. Routes simple tasks for immediate execution, complex ones for planning.",
		accent: "#b45309",
	},
	{
		Icon: ListChecks,
		name: "Tapestry",
		badge: "primary",
		role: "Execution Engine",
		desc: "Brings plans to life step-by-step. Manages the shared workspace and coordinates specialists with human checkpoints.",
		accent: "#b45309",
	},
	{
		Icon: ArrowRightLeft,
		name: "Shuttle",
		badge: "all",
		role: "Implementation Specialist",
		desc: "The builder. Implements changes across frontend, backend, database, or infrastructure based on your tech stack.",
		accent: "#0891b2",
	},
	{
		Icon: ClipboardList,
		name: "Pattern",
		badge: "subagent",
		role: "Strategic Planner",
		desc: "Researches best practices and produces step-by-step execution plans. Breaks complex tasks into actionable checkpoints.",
		accent: "#6b7280",
	},
	{
		Icon: SpoolIcon,
		name: "Thread",
		badge: "subagent",
		role: "Codebase Explorer",
		desc: "Navigates your codebase to find patterns, understand structure, and answer questions with precise file references.",
		accent: "#0d9488",
	},
	{
		Icon: SpindleIcon,
		name: "Spindle",
		badge: "subagent",
		role: "External Researcher",
		desc: "Fetches documentation, searches web, reads APIs. Synthesizes findings with source citations.",
		accent: "#d97706",
	},
	{
		Icon: AlignJustify,
		name: "Weft",
		badge: "subagent",
		role: "Quality Reviewer",
		desc: "Reviews code and implementation for quality, readability, and best practices. Focused on constructive feedback.",
		accent: "#16a34a",
	},
	{
		Icon: ShieldCheck,
		name: "Warp",
		badge: "subagent",
		role: "Security Auditor",
		desc: "Audits for security vulnerabilities. Skeptical bias — rejects by default on security patterns.",
		accent: "var(--mkt-red)",
	},
];

export function WeaveAgentsSection() {
	const { ref, isRevealed } = useScrollReveal();

	return (
		<section id="agents" className="py-24 lg:py-36">
			<div
				ref={ref}
				className={cn(
					"relative mx-auto max-w-5xl px-6 transition-all duration-700 lg:px-8",
					isRevealed
						? "translate-y-0 opacity-100"
						: "translate-y-8 opacity-0",
				)}
			>
				{/* Editorial header */}
				<div className="mb-16">
					<div className="mb-7 flex items-center gap-3">
						<div className="h-4 w-0.5 flex-shrink-0 bg-[var(--mkt-red)]" />
						<span className="font-sans text-[12px] uppercase tracking-[0.25em] text-[var(--mkt-red)]">
							Your AI Team
						</span>
					</div>
					<div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
						<h2
							className="max-w-xl text-[var(--mkt-tx-1)]"
							style={{
								...SERIF,
								fontSize: "clamp(2rem, 5vw, 3.25rem)",
								fontWeight: 400,
								lineHeight: "1.15",
							}}
						>
							Specialists for every kind of work.
						</h2>
						<p
							className="max-w-sm text-[var(--mkt-tx-3)] lg:text-right"
							style={{
								...SERIF,
								fontStyle: "italic",
								fontSize: "1.05rem",
								lineHeight: 1.7,
							}}
						>
							From answering questions to shipping code — Fabric's
							agents cover the full spectrum of your team's needs.
						</p>
					</div>
				</div>

				{/* Agent grid */}
				<div className="border border-[var(--mkt-border)]">
					{/* Orchestration row — 2 general agents */}
					<div className="grid grid-cols-1 gap-px bg-[var(--mkt-border)] sm:grid-cols-2">
						{AGENTS.slice(0, 2).map(({ Icon, ...agent }, index) => (
							<div
								key={agent.name}
								className={cn(
									"group relative bg-[var(--mkt-bg-card)] p-7 transition-colors duration-200 hover:bg-[var(--mkt-bg-hover)]",
									isRevealed
										? "translate-y-0 opacity-100"
										: "translate-y-4 opacity-0",
								)}
								style={{
									borderTop: `2px solid ${agent.accent}`,
									transitionDelay: `${index * 50}ms`,
								}}
							>
								<div className="mb-4">
									<Icon
										size={22}
										strokeWidth={1.5}
										style={{ color: agent.accent }}
									/>
								</div>
								<div className="mb-3 flex flex-wrap items-center gap-2">
									<span
										className="text-[var(--mkt-tx-1)]"
										style={{
											...SERIF,
											fontSize: "1.2rem",
											fontWeight: 400,
										}}
									>
										{agent.name}
									</span>
									<span className="rounded-sm border border-[var(--mkt-border2)] px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-[0.12em] text-[var(--mkt-tx-5)]">
										{agent.badge}
									</span>
								</div>
								<p
									className="mb-2 font-sans font-medium text-[var(--mkt-tx-2)]"
									style={{
										fontSize: "0.8rem",
										letterSpacing: "0.01em",
									}}
								>
									{agent.role}
								</p>
								<p
									className="font-sans text-[var(--mkt-tx-4)]"
									style={{
										fontSize: "0.82rem",
										lineHeight: 1.65,
									}}
								>
									{agent.desc}
								</p>
							</div>
						))}
					</div>

					{/* For software teams — labeled divider */}
					<div className="flex items-center gap-4 border-t border-[var(--mkt-border)] bg-[var(--mkt-bg-alt)] px-7 py-3">
						<div className="h-px flex-1 bg-[var(--mkt-border)]" />
						<span className="font-sans text-[10px] uppercase tracking-[0.25em] text-[var(--mkt-tx-4)]">
							For software teams
						</span>
						<div className="h-px flex-1 bg-[var(--mkt-border)]" />
					</div>

					{/* Software specialist agents */}
					<div className="grid grid-cols-1 gap-px bg-[var(--mkt-border)] sm:grid-cols-2 lg:grid-cols-3">
						{AGENTS.slice(2).map(({ Icon, ...agent }, index) => (
							<div
								key={agent.name}
								className={cn(
									"group relative bg-[var(--mkt-bg-card)] p-7 transition-colors duration-200 hover:bg-[var(--mkt-bg-hover)]",
									isRevealed
										? "translate-y-0 opacity-100"
										: "translate-y-4 opacity-0",
								)}
								style={{
									borderTop: `2px solid ${agent.accent}`,
									transitionDelay: `${(index + 2) * 50}ms`,
								}}
							>
								<div className="mb-4">
									<Icon
										size={22}
										strokeWidth={1.5}
										style={{ color: agent.accent }}
									/>
								</div>
								<div className="mb-3 flex flex-wrap items-center gap-2">
									<span
										className="text-[var(--mkt-tx-1)]"
										style={{
											...SERIF,
											fontSize: "1.2rem",
											fontWeight: 400,
										}}
									>
										{agent.name}
									</span>
									<span className="rounded-sm border border-[var(--mkt-border2)] px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-[0.12em] text-[var(--mkt-tx-5)]">
										{agent.badge}
									</span>
								</div>
								<p
									className="mb-2 font-sans font-medium text-[var(--mkt-tx-2)]"
									style={{
										fontSize: "0.8rem",
										letterSpacing: "0.01em",
									}}
								>
									{agent.role}
								</p>
								<p
									className="font-sans text-[var(--mkt-tx-4)]"
									style={{
										fontSize: "0.82rem",
										lineHeight: 1.65,
									}}
								>
									{agent.desc}
								</p>
							</div>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}
