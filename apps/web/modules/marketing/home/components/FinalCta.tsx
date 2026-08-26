"use client";

import { cn } from "@ui/lib";
import Link from "next/link";
import { useScrollReveal } from "./v3/use-scroll-reveal";

const linePaths = [
	"M0 604 L660 604 L980 170 L1600 170",
	"M0 614 L670 614 L986 228 L1600 228",
	"M0 624 L680 624 L995 286 L1600 286",
	"M0 634 L690 634 L1008 344 L1600 344",
	"M0 644 L700 644 L1024 402 L1600 402",
	"M0 654 L710 654 L1042 460 L1600 460",
	"M0 664 L720 664 L1062 518 L1600 518",
];

export function FinalCta() {
	const { ref, isRevealed } = useScrollReveal();

	return (
		<section className="overflow-hidden bg-[var(--mkt-bg-hero)]">
			<div
				ref={ref}
				className={cn(
					"relative mx-auto min-h-[560px] max-w-[1600px] px-6 py-12 transition-all duration-700 sm:px-8 lg:min-h-[680px] lg:px-10 lg:py-16",
					isRevealed
						? "translate-y-0 opacity-100"
						: "translate-y-8 opacity-0",
				)}
			>
				<div className="pointer-events-none absolute inset-0">
					<div
						className="absolute inset-x-0 bottom-0 h-[20%] bg-black"
						style={{
							clipPath:
								"polygon(0 42%, 66% 42%, 100% 0, 100% 100%, 0 100%)",
						}}
					/>

					<svg
						className="absolute inset-0 h-full w-full"
						viewBox="0 0 1600 760"
						fill="none"
						preserveAspectRatio="none"
						aria-hidden="true"
					>
						{linePaths.map((path, index) => (
							<path
								key={path}
								d={path}
								stroke="var(--mkt-border)"
								strokeWidth="1.6"
								strokeLinecap="square"
								opacity={1 - index * 0.05}
							/>
						))}
					</svg>
				</div>

				<div className="relative z-10 flex min-h-[460px] items-start lg:min-h-[540px]">
					<div className="max-w-[31rem] pt-10 sm:pt-12 lg:pt-16">
						<p className="mb-5 font-sans text-[clamp(1rem,1.55vw,1.75rem)] leading-none text-[var(--mkt-tx-4)]">
							Start your AI journey
						</p>

						<h2
							className="max-w-[12ch] text-[var(--mkt-tx-1)]"
							style={{
								fontFamily:
									"var(--font-sans, 'Instrument Sans', 'Helvetica Neue', Arial, sans-serif)",
								fontSize: "clamp(2rem, 3.55vw, 3.25rem)",
								fontWeight: 500,
								lineHeight: 0.96,
								letterSpacing: "-0.05em",
							}}
						>
							Empower your team with Generative AI
						</h2>

						<p className="mt-6 max-w-md font-sans text-base leading-7 text-[var(--mkt-tx-3)] sm:text-lg">
							Connect company knowledge, tools, and delivery loops
							so every team can ask better questions and move
							faster with grounded answers.
						</p>

						<div className="mt-12 flex flex-col gap-4 sm:flex-row sm:items-center">
							<Link
								href="https://techfabric.com/contact"
								data-fabric-placement="final-cta"
								className="inline-flex min-h-12 items-center justify-center border border-[#2b58d6] bg-[#171717] px-6 py-3 font-sans text-base font-medium text-white transition-colors duration-200 hover:bg-[#222222] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2b58d6] focus-visible:ring-offset-2"
							>
								Book a Demo
							</Link>
							<Link
								href="/auth/login"
								className="inline-flex min-h-12 items-center justify-center border border-[var(--mkt-border)] bg-[var(--mkt-bg-card)] px-6 py-3 font-sans text-base font-medium text-[var(--mkt-tx-1)] transition-colors duration-200 hover:bg-[var(--mkt-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mkt-red)] focus-visible:ring-offset-2"
							>
								Try Fabric Free
							</Link>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
