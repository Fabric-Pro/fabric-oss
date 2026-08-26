"use client";

import { cn } from "@ui/lib";
import { useScrollReveal } from "./use-scroll-reveal";

const SERIF: React.CSSProperties = {
	fontFamily: "var(--font-sans, 'EB Garamond', Georgia, serif)",
};

const LINEAGE_LINES = [
	{ text: "Stakeholder call Jan 28", color: "muted" as const },
	{
		text: "↓ ACH payments requested",
		color: "accent" as const,
		indent: true,
	},
	{ text: "PRD §3.2 updated", color: "muted" as const },
	{
		text: "↓ Payment scope expanded",
		color: "accent" as const,
		indent: true,
	},
	{ text: "JIRA-1847 created", color: "muted" as const },
	{
		text: "↓ New story: ACH verification",
		color: "accent" as const,
		indent: true,
	},
] as const;

const DIFF_LINES = [
	{ text: "  Epic: Checkout Redesign", color: "muted" as const },
	{ text: "- Story: Support credit card only", color: "del" as const },
	{ text: "+ Story: Support credit card + ACH", color: "add" as const },
	{ text: "+ AC: ACH requires bank verification", color: "add" as const },
	{ text: "  Story: Apply discount codes", color: "muted" as const },
	{ text: "+ Linked: stakeholder call 01/28", color: "add" as const },
] as const;

type LineColor = "muted" | "accent" | "del" | "add";

const COLOR: Record<LineColor, string> = {
	muted: "text-[var(--mkt-tx-4)]",
	accent: "text-[var(--mkt-red)]",
	del: "text-[#b91c1c] dark:text-[#f87171]",
	add: "text-[#0f6f35] dark:text-[#4ade80]",
};

const BG: Record<LineColor, string> = {
	muted: "",
	accent: "",
	del: "bg-[var(--mkt-diff-del)]",
	add: "bg-[var(--mkt-diff-add)]",
};

export function TrustSection() {
	const { ref, isRevealed } = useScrollReveal();

	return (
		<section id="trust" className="bg-[var(--mkt-bg-card)] py-24 lg:py-36">
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
							Traceability
						</span>
					</div>
					<h2
						className="max-w-xl text-[var(--mkt-tx-1)]"
						style={{
							...SERIF,
							fontSize: "clamp(2rem, 5vw, 3.25rem)",
							fontWeight: 400,
							lineHeight: "1.15",
						}}
					>
						Every answer has a source. Every change has a reason.
					</h2>
					<p
						className="mt-5 max-w-lg text-[var(--mkt-tx-3)]"
						style={{
							...SERIF,
							fontStyle: "italic",
							fontSize: "1.1rem",
							lineHeight: 1.7,
						}}
					>
						Whether it's a pricing decision or a code change, Fabric
						shows where it came from — so you act with confidence,
						not guesswork.
					</p>
				</div>

				{/* Two trace blocks */}
				<div className="grid grid-cols-1 gap-0 border border-[var(--mkt-border)] lg:grid-cols-2">
					{/* Decision Lineage */}
					<div className="border-b border-[var(--mkt-border)] p-8 lg:border-b-0 lg:border-r">
						<p className="mb-2 font-sans text-[11px] uppercase tracking-[0.2em] text-[var(--mkt-tx-4)]">
							Decision Lineage
						</p>
						<p
							className="mb-6 text-[var(--mkt-tx-3)]"
							style={{ fontSize: "0.96rem", lineHeight: 1.6 }}
						>
							Every artifact links back to the conversation,
							meeting, or decision that created it.
						</p>
						<div className="border border-[var(--mkt-border)] bg-[var(--mkt-bg-hover)] p-5 font-mono text-[0.8rem] leading-7">
							{LINEAGE_LINES.map((line, i) => (
								<div
									key={`${line.text}-${i}`}
									className={cn(
										COLOR[line.color],
										"indent" in line && line.indent
											? "pl-5"
											: "",
									)}
								>
									{line.text}
								</div>
							))}
						</div>
					</div>

					{/* Artifact Diffs */}
					<div className="p-8">
						<p className="mb-2 font-sans text-[11px] uppercase tracking-[0.2em] text-[var(--mkt-tx-4)]">
							Artifact Diffs
						</p>
						<p
							className="mb-6 text-[var(--mkt-tx-3)]"
							style={{ fontSize: "0.96rem", lineHeight: 1.6 }}
						>
							When context changes, Fabric shows exactly what
							moved and why — no guessing needed.
						</p>
						<div className="border border-[var(--mkt-border)] bg-[var(--mkt-bg-hover)] p-5 font-mono text-[0.8rem] leading-7">
							{DIFF_LINES.map((line, i) => (
								<div
									key={`${line.text}-${i}`}
									className={cn(
										COLOR[line.color],
										BG[line.color],
									)}
								>
									{line.text}
								</div>
							))}
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
