"use client";

import { cn } from "@ui/lib";
import Image from "next/image";
import Link from "next/link";
import { useScrollReveal } from "./use-scroll-reveal";

const SERIF: React.CSSProperties = {
	fontFamily: "var(--font-serif, 'EB Garamond', Georgia, serif)",
};

const INTEGRATIONS = [
	{ name: "Slack", src: "/integrations/Slack.png", invertDark: false },
	{ name: "Gmail", src: "/integrations/Gmail.png", invertDark: false },
	{ name: "GitHub", src: "/integrations/Github.png", invertDark: true },
	{ name: "Notion", src: "/integrations/Notion.png", invertDark: false },
	{
		name: "Salesforce",
		src: "/integrations/Salesforce.png",
		invertDark: false,
	},
	{ name: "HubSpot", src: "/integrations/HubSpot.png", invertDark: false },
	{ name: "Teams", src: "/integrations/Teams.png", invertDark: false },
	{
		name: "Google Drive",
		src: "/integrations/GoogleDrive.png",
		invertDark: false,
	},
	{ name: "Jira", src: "/integrations/Jira.svg", invertDark: false },
	{
		name: "Confluence",
		src: "/integrations/Confluence.svg",
		invertDark: false,
	},
	{ name: "GitLab", src: "/integrations/Gitlab.png", invertDark: false },
	{ name: "Linear", src: "/integrations/Linear.png", invertDark: false },
	{ name: "Zendesk", src: "/integrations/Zendesk.svg", invertDark: false },
	{ name: "Gong", src: "/integrations/Gong.png", invertDark: false },
	{ name: "Asana", src: "/integrations/Asana.png", invertDark: false },
	{ name: "Dropbox", src: "/integrations/Dropbox.png", invertDark: false },
	{ name: "OneDrive", src: "/integrations/OneDrive.png", invertDark: false },
	{ name: "Box", src: "/integrations/Box.png", invertDark: false },
];

export function IntegrationsSection() {
	const { ref, isRevealed } = useScrollReveal();

	return (
		<section className="bg-[var(--mkt-bg-alt)] py-24 lg:py-36">
			<div
				ref={ref}
				className={cn(
					"mx-auto max-w-5xl px-6 transition-all duration-700 lg:px-8",
					isRevealed
						? "translate-y-0 opacity-100"
						: "translate-y-8 opacity-0",
				)}
			>
				<div className="grid grid-cols-1 items-start gap-16 lg:grid-cols-[1fr_2fr] lg:gap-12">
					{/* Left — editorial copy */}
					<div className="lg:sticky lg:top-24">
						<div className="mb-7 flex items-center gap-3">
							<div className="h-4 w-0.5 flex-shrink-0 bg-[var(--mkt-red)]" />
							<span className="font-sans text-[12px] uppercase tracking-[0.25em] text-[var(--mkt-red)]">
								Connections
							</span>
						</div>
						<h2
							className="mb-5 text-[var(--mkt-tx-1)]"
							style={{
								...SERIF,
								fontSize: "clamp(1.75rem, 4vw, 2.75rem)",
								fontWeight: 400,
								lineHeight: "1.15",
							}}
						>
							Fabric connects to all your apps.
						</h2>
						<p
							className="mb-8 text-[var(--mkt-tx-3)]"
							style={{
								fontSize: "1rem",
								lineHeight: 1.7,
							}}
						>
							Plug-and-play. Syncs updates in real time. Respects
							your access controls so the right people always see
							the right information.
						</p>
						<Link
							href="https://techfabric.com/contact"
							data-fabric-placement="integrations"
							className="inline-block border border-[var(--mkt-red)] px-8 py-3 font-sans text-[11px] uppercase tracking-[0.25em] text-[var(--mkt-red)] transition-colors duration-200 hover:bg-[var(--mkt-red)] hover:text-white"
						>
							See All Integrations →
						</Link>
					</div>

					{/* Right — logo grid */}
					<div className="border border-[var(--mkt-border)] bg-[var(--mkt-border)]">
						<div className="grid grid-cols-3 gap-px sm:grid-cols-6">
							{INTEGRATIONS.map(
								({ name, src, invertDark }, index) => (
									<div
										key={name}
										className={cn(
											"flex flex-col items-center justify-center gap-2.5 bg-[var(--mkt-bg-alt)] p-5 transition-colors duration-200 hover:bg-[var(--mkt-bg-hover)]",
											isRevealed
												? "opacity-100"
												: "opacity-0",
										)}
										style={{
											transitionProperty:
												"opacity, background-color",
											transitionDuration: isRevealed
												? `${200 + index * 40}ms, 200ms`
												: "200ms",
										}}
									>
										<Image
											src={src}
											alt={name}
											width={36}
											height={36}
											className={cn(
												"object-contain",
												invertDark && "dark:invert",
											)}
											style={{ width: 36, height: 36 }}
										/>
										<span className="text-center font-sans text-[8px] uppercase leading-tight tracking-[0.12em] text-[var(--mkt-tx-5)]">
											{name}
										</span>
									</div>
								),
							)}
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
