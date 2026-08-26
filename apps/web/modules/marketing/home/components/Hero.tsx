"use client";

import { ArrowUpIcon, ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

// ─── Background ───────────────────────────────────────────────────────────────

function HeroBackground() {
	return (
		<div className="pointer-events-none absolute inset-0 overflow-hidden">
			<div
				className="absolute inset-0"
				style={{
					backgroundImage:
						"radial-gradient(circle, rgba(0,0,0,0.13) 1px, transparent 1px)",
					backgroundSize: "32px 32px",
				}}
			/>
		</div>
	);
}

// ─── Animated prompt input ────────────────────────────────────────────────────

const PROMPTS = [
	"What did we decide about pricing in last week's call?",
	"Summarise all open bugs from this sprint.",
	"Draft a PRD for the new onboarding flow.",
	"Who owns the authentication service?",
	"What changed in the Q2 roadmap?",
	"Find all customer feedback on the dashboard.",
];

function AnimatedPromptInput() {
	const [promptIndex, setPromptIndex] = useState(0);
	const [displayed, setDisplayed] = useState("");
	const [phase, setPhase] = useState<"typing" | "pause" | "erasing">(
		"typing",
	);

	useEffect(() => {
		const current = PROMPTS[promptIndex];

		if (phase === "typing") {
			if (displayed.length < current.length) {
				const t = setTimeout(
					() => setDisplayed(current.slice(0, displayed.length + 1)),
					38,
				);
				return () => clearTimeout(t);
			}
			const t = setTimeout(() => setPhase("pause"), 2200);
			return () => clearTimeout(t);
		}

		if (phase === "pause") {
			const t = setTimeout(() => setPhase("erasing"), 600);
			return () => clearTimeout(t);
		}

		if (phase === "erasing") {
			if (displayed.length > 0) {
				const t = setTimeout(
					() => setDisplayed((d) => d.slice(0, -1)),
					18,
				);
				return () => clearTimeout(t);
			}
			setPromptIndex((i) => (i + 1) % PROMPTS.length);
			setPhase("typing");
		}
	}, [displayed, phase, promptIndex]);

	return (
		<div
			className="w-full max-w-2xl border border-[var(--mkt-border)] bg-[var(--mkt-bg-card)]"
			style={{
				boxShadow:
					"0 0 0 1px rgba(159,42,58,0.08), 0 8px 32px rgba(0,0,0,0.25)",
			}}
		>
			{/* Input row */}
			<div className="flex items-center gap-3 px-5 py-4">
				<span
					className="flex-1 text-left font-sans text-sm text-[var(--mkt-tx-3)]"
					style={{ minHeight: "1.4em" }}
					aria-hidden="true"
				>
					{displayed}
					<span className="ml-0.5 inline-block h-[1em] w-px translate-y-[2px] animate-pulse bg-[var(--mkt-red)]" />
				</span>
				<button
					type="button"
					className="flex h-7 w-7 flex-shrink-0 items-center justify-center border border-[var(--mkt-red)] text-[var(--mkt-red)] transition-colors hover:bg-[var(--mkt-red)] hover:text-white"
					aria-label="Send"
				>
					<ArrowUpIcon className="size-3.5" />
				</button>
			</div>
			{/* Bottom toolbar */}
			<div className="flex items-center gap-3 border-t border-[var(--mkt-border)] px-5 py-2.5">
				<span className="font-sans text-[10px] uppercase tracking-[0.18em] text-[var(--mkt-tx-5)]">
					Ask Fabric
				</span>
				<div className="h-3 w-px bg-[var(--mkt-border)]" />
				<span className="font-sans text-[10px] uppercase tracking-[0.18em] text-[var(--mkt-red)] opacity-80">
					Deep Research
				</span>
				<div className="h-3 w-px bg-[var(--mkt-border)]" />
				<span className="font-sans text-[10px] uppercase tracking-[0.18em] text-[var(--mkt-tx-5)]">
					Web Search
				</span>
			</div>
		</div>
	);
}

// ─── Hero ─────────────────────────────────────────────────────────────────────

export function Hero() {
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	return (
		<div className="relative flex min-h-screen flex-col overflow-hidden bg-[var(--mkt-bg-hero)] text-[var(--mkt-tx-1)]">
			<HeroBackground />

			{/* Center content */}
			<div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 pt-24 text-center">
				{/* Category label */}
				<p
					className={`mb-8 font-sans text-[12px] uppercase tracking-[0.3em] text-[var(--mkt-red)] marketing-hero-in marketing-hero-in-delay-1 ${mounted ? "" : "opacity-0"}`}
				>
					A TechFabric product · AI connected to your docs, apps, and
					people
				</p>

				{/* Main headline */}
				<h1
					className={`max-w-4xl text-[var(--mkt-tx-1)] marketing-hero-in marketing-hero-in-delay-2 ${mounted ? "" : "opacity-0"}`}
					style={{
						fontFamily:
							"var(--font-serif, 'EB Garamond', Georgia, serif)",
						fontSize: "clamp(2.5rem, 6vw, 5rem)",
						fontWeight: 400,
						lineHeight: "1.08",
						letterSpacing: "-0.02em",
					}}
				>
					Give your whole team superpowers.
				</h1>

				{/* Simple subheading */}
				<p
					className={`mt-5 max-w-xl font-sans text-lg leading-relaxed text-[var(--mkt-tx-3)] marketing-hero-in marketing-hero-in-delay-3 ${mounted ? "" : "opacity-0"}`}
				>
					Fabric is the AI platform connected to your docs, apps, and
					people — with deep software delivery capabilities for the
					teams that ship.
				</p>

				{/* Animated prompt input */}
				<div
					className={`mt-10 flex w-full max-w-2xl justify-center marketing-hero-in marketing-hero-in-delay-3 ${mounted ? "" : "opacity-0"}`}
				>
					<AnimatedPromptInput />
				</div>

				{/* CTA buttons */}
				<div
					className={`mt-8 flex flex-col items-center gap-4 sm:flex-row marketing-hero-in marketing-hero-in-delay-4 ${mounted ? "" : "opacity-0"}`}
				>
					<Link
						href="/auth/login"
						className="inline-block border border-[var(--mkt-red)] px-10 py-3 font-sans text-[12px] uppercase tracking-[0.25em] text-[var(--mkt-red)] transition-colors duration-200 hover:bg-[var(--mkt-red)] hover:text-white"
					>
						Get Started Free
					</Link>
					<Link
						href="https://techfabric.com/contact"
						data-fabric-placement="hero"
						className="font-sans text-[12px] uppercase tracking-[0.2em] text-[var(--mkt-tx-4)] transition-colors hover:text-[var(--mkt-tx-2)]"
					>
						Schedule a Demo →
					</Link>
				</div>

				{/* Trust strip */}
				<div
					className={`mt-10 flex flex-wrap items-center justify-center gap-x-8 gap-y-2 marketing-hero-in marketing-hero-in-delay-4 ${mounted ? "" : "opacity-0"}`}
				>
					{[
						"Every team. Every question.",
						"50+ specialized agents",
						"100+ MCP integrations",
						"Free — bring your own AI keys",
					].map((item) => (
						<span
							key={item}
							className="font-sans text-[11px] uppercase tracking-[0.15em] text-[var(--mkt-tx-4)]"
						>
							{item}
						</span>
					))}
				</div>
			</div>

			{/* Scroll indicator */}
			<div className="relative z-10 flex flex-col items-center gap-2 pb-10 text-[var(--mkt-tx-4)]">
				<span className="font-sans text-[11px] uppercase tracking-[0.25em]">
					Scroll Down
				</span>
				<ChevronDownIcon className="size-4 motion-safe:animate-bounce" />
			</div>
		</div>
	);
}
