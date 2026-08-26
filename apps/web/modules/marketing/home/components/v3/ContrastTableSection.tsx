"use client";

import { cn } from "@ui/lib";
import { useScrollReveal } from "./use-scroll-reveal";

interface ComparisonRow {
	dimension: string;
	copilot: string;
	fabric: string;
}

const ROWS: ComparisonRow[] = [
	{
		dimension: "Context",
		copilot: "Starts fresh every conversation",
		fabric: "Persistent memory of your team, docs, and decisions",
	},
	{
		dimension: "Knowledge",
		copilot: "General world knowledge",
		fabric: "Grounded in your company's actual data",
	},
	{
		dimension: "Scope",
		copilot: "One question, one answer",
		fabric: "Connected across every tool and team",
	},
	{
		dimension: "Trust",
		copilot: "Hallucinated or uncited sources",
		fabric: "Every answer cites exactly where it came from",
	},
	{
		dimension: "Output",
		copilot: "Text you copy somewhere",
		fabric: "Answers with sources + connected artifacts",
	},
	{
		dimension: "Learning",
		copilot: "Same as day one",
		fabric: "Gets smarter as your team works",
	},
	{
		dimension: "Software delivery",
		copilot: "None",
		fabric: "Full SDLC automation for engineering teams",
	},
	{
		dimension: "Team benefit",
		copilot: "Individual sessions",
		fabric: "Shared knowledge that compounds over time",
	},
];

const SERIF: React.CSSProperties = {
	fontFamily: "var(--font-sans, 'EB Garamond', Georgia, serif)",
};

export function ContrastTableSection() {
	const { ref, isRevealed } = useScrollReveal();

	return (
		<section id="compare" className="bg-[var(--mkt-bg-alt)] py-24 lg:py-36">
			<div ref={ref} className="mx-auto max-w-5xl px-6 lg:px-8">
				{/* Editorial header */}
				<div
					className={cn(
						"mb-14 transition-all duration-700",
						isRevealed
							? "opacity-100 translate-y-0"
							: "opacity-0 translate-y-6",
					)}
				>
					<div className="mb-7 flex items-center gap-3">
						<div className="h-4 w-0.5 bg-[var(--mkt-red)] flex-shrink-0" />
						<span className="font-sans text-[12px] uppercase tracking-[0.25em] text-[var(--mkt-red)]">
							Fabric vs. The Status Quo
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
						Not a chatbot. Your team's AI brain.
					</h2>

					<p
						className="mt-5 max-w-lg text-[var(--mkt-tx-3)]"
						style={{
							...SERIF,
							fontStyle: "italic",
							fontSize: "1.15rem",
							lineHeight: 1.7,
						}}
					>
						Generic AI answers questions in isolation. Fabric
						understands your team — and gets smarter every day you
						use it.
					</p>
				</div>

				{/* Comparison table */}
				<div
					className={cn(
						"overflow-x-auto transition-all duration-700 delay-200",
						isRevealed
							? "opacity-100 translate-y-0"
							: "opacity-0 translate-y-8",
					)}
				>
					<table
						className="w-full border-collapse"
						style={{ fontSize: "0.95rem" }}
					>
						<thead>
							<tr className="border-b border-[var(--mkt-border)]">
								<th
									scope="col"
									className="py-4 pr-8 text-left font-sans text-[11px] uppercase tracking-[0.2em] text-[var(--mkt-tx-4)]"
								>
									{/* empty dimension col */}
								</th>
								<th
									scope="col"
									className="py-4 pr-8 text-left font-sans text-[11px] uppercase tracking-[0.2em] text-[var(--mkt-tx-4)]"
								>
									<span
										style={{
											fontStyle: "italic",
											fontFamily:
												"var(--font-sans, Georgia, serif)",
											fontSize: "1rem",
											fontWeight: 400,
											textTransform: "none",
											letterSpacing: 0,
										}}
									>
										Generic AI
									</span>
								</th>
								<th
									scope="col"
									className="py-4 text-left font-sans text-[11px] uppercase tracking-[0.2em] text-[var(--mkt-red)]"
								>
									<span
										style={{
											fontStyle: "italic",
											fontFamily:
												"var(--font-sans, Georgia, serif)",
											fontSize: "1rem",
											fontWeight: 400,
											textTransform: "none",
											letterSpacing: 0,
										}}
									>
										Fabric
									</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{ROWS.map((row) => (
								<tr
									key={row.dimension}
									className="border-b border-[var(--mkt-border)] transition-colors hover:bg-[var(--mkt-bg-card)]"
								>
									<td
										className="py-4 pr-8 font-sans text-[12px] uppercase tracking-[0.15em] text-[var(--mkt-tx-4)]"
										style={{ width: "15%" }}
									>
										{row.dimension}
									</td>
									<td
										className="py-4 pr-8 text-[var(--mkt-tx-4)]"
										style={{
											...SERIF,
											lineHeight: 1.6,
											width: "40%",
										}}
									>
										{row.copilot}
									</td>
									<td
										className="py-4 text-[var(--mkt-tx-1)]"
										style={{
											...SERIF,
											lineHeight: 1.6,
											width: "45%",
										}}
									>
										{row.fabric}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</section>
	);
}
