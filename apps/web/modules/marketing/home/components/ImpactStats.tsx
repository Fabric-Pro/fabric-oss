"use client";

import { cn } from "@ui/lib";
import { useEffect, useRef, useState } from "react";

// Animated counter hook
function useCountUp(end: number, duration = 2000, start = 0) {
	const [count, setCount] = useState(start);
	const [isVisible, setIsVisible] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry.isIntersecting) {
					setIsVisible(true);
				}
			},
			{ threshold: 0.3 },
		);
		if (ref.current) {
			observer.observe(ref.current);
		}
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (!isVisible) {
			return;
		}
		let startTime: number | null = null;
		const step = (timestamp: number) => {
			if (!startTime) {
				startTime = timestamp;
			}
			const progress = Math.min((timestamp - startTime) / duration, 1);
			setCount(Math.floor(progress * (end - start) + start));
			if (progress < 1) {
				requestAnimationFrame(step);
			}
		};
		requestAnimationFrame(step);
	}, [isVisible, end, start, duration]);

	return { count, ref };
}

const SERIF: React.CSSProperties = {
	fontFamily: "var(--font-sans, 'EB Garamond', Georgia, serif)",
};

const stats = [
	{ value: 500, suffix: "K+", label: "Questions Answered" },
	{ value: 50, suffix: "K+", label: "Artifacts Generated" },
	{ value: 10, suffix: "M+", label: "Decisions Captured" },
	{ value: 95, suffix: "%", label: "Time Saved on Docs" },
];

const testimonials = [
	{
		quote: "Fabric transformed how we ship software. Our PRD-to-production time went from 2 weeks to 2 days.",
		author: "Jerry N.",
		role: "VP of Engineering",
		metrics: [
			{ value: "85%", label: "Faster shipping" },
			{ value: "10×", label: "More PRs / week" },
		],
	},
	{
		quote: "Our whole team — not just engineering — gets instant answers from Fabric. It's like having a company brain that's always up to date.",
		author: "Sarah K.",
		role: "Chief of Staff",
		metrics: [
			{ value: "70%", label: "Less time searching" },
			{ value: "4.9", label: "Team satisfaction" },
		],
	},
	{
		quote: "Onboarding used to take weeks. New hires now get answers from Fabric on day one. Our institutional knowledge finally works for us.",
		author: "Steve M.",
		role: "Director of Product",
		metrics: [
			{ value: "3×", label: "Faster onboarding" },
			{ value: "90%", label: "Less back-and-forth" },
		],
	},
];

function StatItem({
	value,
	suffix,
	label,
	index,
}: {
	value: number;
	suffix: string;
	label: string;
	index: number;
}) {
	const { count, ref } = useCountUp(value, 1800 + index * 150);
	return (
		<div
			ref={ref}
			className="border-l border-[var(--mkt-border)] py-8 pl-8 first:border-l-0 first:pl-0"
		>
			<div
				className="leading-none text-[var(--mkt-tx-1)]"
				style={{
					...SERIF,
					fontSize: "clamp(2.5rem, 6vw, 4rem)",
					fontWeight: 400,
				}}
			>
				{count}
				<span className="text-[var(--mkt-red)]">{suffix}</span>
			</div>
			<p className="mt-2 font-sans text-[12px] uppercase tracking-[0.2em] text-[var(--mkt-tx-4)]">
				{label}
			</p>
		</div>
	);
}

export function ImpactStats() {
	return (
		<section className="bg-[var(--mkt-bg-card)] py-24 lg:py-36">
			<div className="mx-auto max-w-5xl px-6 lg:px-8">
				{/* Editorial label */}
				<div className="mb-14 flex items-center gap-3">
					<div className="h-4 w-0.5 bg-[var(--mkt-red)] flex-shrink-0" />
					<span className="font-sans text-[12px] uppercase tracking-[0.25em] text-[var(--mkt-red)]">
						Proven Results
					</span>
				</div>

				{/* Stats row */}
				<div className="mb-20 grid grid-cols-2 gap-0 lg:grid-cols-4">
					{stats.map((stat, i) => (
						<StatItem key={stat.label} {...stat} index={i} />
					))}
				</div>

				{/* Section divider */}
				<div className="mb-14 border-t border-[var(--mkt-border)]" />

				{/* Section label for testimonials */}
				<p className="mb-10 font-sans text-[12px] uppercase tracking-[0.2em] text-[var(--mkt-tx-4)]">
					What Teams Are Saying
				</p>

				{/* Testimonials — editorial */}
				<div className="grid grid-cols-1 gap-0 border border-[var(--mkt-border)] lg:grid-cols-3">
					{testimonials.map((t, i) => (
						<div
							key={t.author}
							className={cn(
								"p-8 transition-colors hover:bg-[var(--mkt-bg-hover)]",
								i < 2 &&
									"border-b border-[var(--mkt-border)] lg:border-b-0 lg:border-r",
							)}
						>
							{/* Quote */}
							<blockquote
								className="mb-6 text-[var(--mkt-tx-2)]"
								style={{
									...SERIF,
									fontStyle: "italic",
									fontSize: "1.05rem",
									lineHeight: 1.7,
								}}
							>
								"{t.quote}"
							</blockquote>

							{/* Metrics */}
							<div className="mb-6 flex gap-6">
								{t.metrics.map((m) => (
									<div key={m.label}>
										<div
											className="text-[var(--mkt-red)]"
											style={{
												...SERIF,
												fontSize: "1.75rem",
												fontWeight: 400,
											}}
										>
											{m.value}
										</div>
										<div className="font-sans text-[11px] uppercase tracking-[0.15em] text-[var(--mkt-tx-4)]">
											{m.label}
										</div>
									</div>
								))}
							</div>

							{/* Author */}
							<div>
								<p
									className="text-[var(--mkt-tx-1)]"
									style={{ ...SERIF, fontSize: "0.95rem" }}
								>
									{t.author}
								</p>
								<p className="font-sans text-[12px] text-[var(--mkt-tx-4)]">
									{t.role}
								</p>
							</div>
						</div>
					))}
				</div>

				{/* Trusted by */}
				<div className="mt-16 text-center">
					<p className="mb-8 font-sans text-[11px] uppercase tracking-[0.2em] text-[var(--mkt-tx-4)]">
						Trusted by teams at
					</p>
					<div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
						{[
							"Vercel",
							"Stripe",
							"Linear",
							"Notion",
							"Figma",
							"Supabase",
						].map((name) => (
							<span
								key={name}
								className="font-sans text-[13px] font-normal tracking-tight text-[var(--mkt-tx-4)] transition-colors hover:text-[var(--mkt-tx-2)]"
							>
								{name}
							</span>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}
