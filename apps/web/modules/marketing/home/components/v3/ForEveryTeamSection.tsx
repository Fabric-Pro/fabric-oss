"use client";

import { cn } from "@ui/lib";
import {
	BarChart2Icon,
	CodeIcon,
	HeadphonesIcon,
	MegaphoneIcon,
	TrendingUpIcon,
	UsersIcon,
} from "lucide-react";
import type { ElementType } from "react";
import { useScrollReveal } from "./use-scroll-reveal";

const SERIF: React.CSSProperties = {
	fontFamily: "var(--font-serif, 'EB Garamond', Georgia, serif)",
};

interface TeamCard {
	label: string;
	headline: string;
	description: string;
	Icon: ElementType;
	accent: string;
}

const TEAMS: TeamCard[] = [
	{
		label: "Company & Leadership",
		headline: "Instant answers from every meeting, doc, and decision.",
		description:
			"No more hunting through Slack archives. Ask Fabric anything about your company's history, strategy, or decisions — and get an answer grounded in what actually happened.",
		Icon: BarChart2Icon,
		accent: "#b45309",
	},
	{
		label: "Engineering",
		headline: "From spec to shipped code, automatically.",
		description:
			"Coding agents that understand your architecture and follow your conventions. PRDs become stories. Stories become pull requests. Changes stay traceable.",
		Icon: CodeIcon,
		accent: "var(--mkt-red)",
	},
	{
		label: "Sales",
		headline: "Every product update and past deal, in seconds.",
		description:
			"Stop digging through email threads for pricing history. Fabric knows every product change, competitive insight, and conversation — so your team closes with confidence.",
		Icon: TrendingUpIcon,
		accent: "#0891b2",
	},
	{
		label: "Support",
		headline: "Answer customer questions with full product context.",
		description:
			"Fabric surfaces the right answer from your docs, past tickets, and product history — so your team responds faster and escalates less.",
		Icon: HeadphonesIcon,
		accent: "#16a34a",
	},
	{
		label: "Marketing",
		headline: "On-brand answers, in seconds.",
		description:
			"Fabric knows your messaging, campaigns, and competitive positioning. Brief writers, answer questions, and keep every asset aligned — without hunting through folders.",
		Icon: MegaphoneIcon,
		accent: "#7c3aed",
	},
	{
		label: "HR & Ops",
		headline: "Company knowledge that onboards itself.",
		description:
			"Policies, processes, and people information — always up to date and always accessible. New hires get answers from Fabric on day one.",
		Icon: UsersIcon,
		accent: "#6b7280",
	},
];

export function ForEveryTeamSection() {
	const { ref, isRevealed } = useScrollReveal();

	return (
		<section className="bg-[var(--mkt-bg-card)] py-24 lg:py-36">
			<div
				ref={ref}
				className={cn(
					"mx-auto max-w-5xl px-6 transition-all duration-700 lg:px-8",
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
							For Every Team
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
							Improve productivity for every department.
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
							One platform. Every team gets answers grounded in
							what your company actually knows.
						</p>
					</div>
				</div>

				{/* Team cards — editorial grid */}
				<div className="border border-[var(--mkt-border)] bg-[var(--mkt-border)]">
					<div className="grid grid-cols-1 gap-px sm:grid-cols-2 lg:grid-cols-3">
						{TEAMS.map(({ Icon, ...team }, index) => (
							<div
								key={team.label}
								className={cn(
									"group bg-[var(--mkt-bg-card)] p-8 transition-colors duration-200 hover:bg-[var(--mkt-bg-hover)]",
									isRevealed
										? "translate-y-0 opacity-100"
										: "translate-y-4 opacity-0",
								)}
								style={{
									borderTop: `2px solid ${team.accent}`,
									transitionDelay: `${index * 80}ms`,
								}}
							>
								<div className="mb-5 flex items-center gap-3">
									<Icon
										className="size-4 flex-shrink-0"
										style={{ color: team.accent }}
										strokeWidth={1.5}
									/>
									<span className="font-sans text-[11px] uppercase tracking-[0.2em] text-[var(--mkt-tx-4)]">
										{team.label}
									</span>
								</div>
								<h3
									className="mb-3 text-[var(--mkt-tx-1)]"
									style={{
										...SERIF,
										fontSize: "1.15rem",
										fontWeight: 400,
										lineHeight: "1.3",
									}}
								>
									{team.headline}
								</h3>
								<p
									className="text-[var(--mkt-tx-3)]"
									style={{
										fontSize: "0.9rem",
										lineHeight: 1.65,
									}}
								>
									{team.description}
								</p>
							</div>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}
