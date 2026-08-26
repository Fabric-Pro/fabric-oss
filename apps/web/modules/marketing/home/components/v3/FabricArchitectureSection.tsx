"use client";

import { cn } from "@ui/lib";
import { useScrollReveal } from "./use-scroll-reveal";

// ─── Styling constants ──────────────────────────────────────────────────────

const SERIF: React.CSSProperties = {
	fontFamily: "var(--font-serif, 'EB Garamond', Georgia, serif)",
};

const MONO: React.CSSProperties = {
	fontFamily:
		"ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace",
};

const AGENT_PROGRESS_KEYFRAMES = `
	@keyframes agent-cursor {
		0%, 100% { left: 0%; }
		50% { left: 52%; }
	}
	@keyframes agent-stipple-reveal {
		from { clip-path: inset(0 100% 0 0); }
		to { clip-path: inset(0 0% 0 0); }
	}
`;

// ─── Reusable: editorial box label (red bar + uppercase mono) ───────────────

function BoxLabel({ children }: { children: string }) {
	return (
		<div className="flex items-center gap-2">
			<div className="h-3 w-0.5 bg-[var(--mkt-red)] flex-shrink-0" />
			<span
				className="text-[var(--mkt-tx-2)]"
				style={{
					...MONO,
					fontSize: "0.72rem",
					letterSpacing: "0.06em",
					textTransform: "uppercase",
					fontWeight: 500,
				}}
			>
				{children}
			</span>
			<div className="flex-1 border-t border-[var(--mkt-border)]" />
		</div>
	);
}

// ─── Reusable: input/output labels (italic serif — warm, editorial) ─────────

function SignalLabels({
	items,
	align = "left",
}: {
	items: string[];
	align?: "left" | "right";
}) {
	return (
		<div
			className={cn(
				"space-y-1",
				align === "right" ? "text-right" : "text-left",
			)}
		>
			{items.map((item) => (
				<p
					key={item}
					className="text-[var(--mkt-tx-4)]"
					style={{
						...SERIF,
						fontSize: "0.88rem",
						fontStyle: "italic",
						lineHeight: 1.5,
					}}
				>
					{item}
				</p>
			))}
		</div>
	);
}

// ─── Animated agent bar ─────────────────────────────────────────────────────

function AgentProgressBar({ isRevealed }: { isRevealed: boolean }) {
	return (
		<div
			className="relative h-6 w-full overflow-hidden rounded-sm"
			style={{ backgroundColor: "var(--mkt-bg-alt)" }}
		>
			<style>{AGENT_PROGRESS_KEYFRAMES}</style>

			{/* Stipple dot pattern — full background */}
			<div
				className="absolute inset-0"
				style={{
					backgroundImage:
						"radial-gradient(circle, var(--mkt-tx-5) 0.8px, transparent 0.8px)",
					backgroundSize: "5px 5px",
					opacity: isRevealed ? 0.6 : 0,
					transition: "opacity 1s ease-out",
					animationName: isRevealed ? "agent-stipple-reveal" : "none",
					animationDuration: "2s",
					animationTimingFunction: "ease-out",
					animationFillMode: "forwards",
				}}
				aria-hidden="true"
			/>

			{/* Denser region — "completed" work */}
			<div
				className="absolute inset-y-0 left-0"
				style={{
					width: isRevealed ? "60%" : "0%",
					transition: "width 2.5s ease-out",
					backgroundImage:
						"radial-gradient(circle, var(--mkt-tx-3) 1px, transparent 1px)",
					backgroundSize: "5px 5px",
					opacity: 0.7,
				}}
				aria-hidden="true"
			/>

			{/* Animated cursor — sweeps continuously */}
			<div
				className="absolute inset-y-0"
				style={{
					width: "4%",
					minWidth: "6px",
					opacity: isRevealed ? 1 : 0,
					transition: "opacity 0.5s ease-out 2s",
					animationName: isRevealed ? "agent-cursor" : "none",
					animationDuration: "4s",
					animationTimingFunction: "ease-in-out",
					animationIterationCount: "infinite",
					animationDelay: "2.5s",
				}}
				aria-hidden="true"
			>
				<div
					className="h-full"
					style={{ backgroundColor: "var(--mkt-tx-2)" }}
				/>
			</div>
		</div>
	);
}

// ─── Desktop arrow (solid red) ──────────────────────────────────────────────

function ArrowRight() {
	return (
		<svg
			width="32"
			height="16"
			viewBox="0 0 32 16"
			fill="none"
			aria-hidden="true"
			className="text-[var(--mkt-red)]"
		>
			<path
				d="M0 8h28m0 0l-5-5m5 5l-5 5"
				stroke="currentColor"
				strokeWidth="1"
			/>
		</svg>
	);
}

// ─── Nested architecture diagram ────────────────────────────────────────────

function ArchitectureDiagram({ isRevealed }: { isRevealed: boolean }) {
	return (
		<div
			className={cn(
				"transition-all duration-700 delay-300",
				isRevealed
					? "opacity-100 translate-y-0"
					: "opacity-0 translate-y-8",
			)}
		>
			{/* ── Desktop: horizontal layout ────────────────────────────── */}
			<div className="hidden md:block">
				<div className="flex items-center gap-6 lg:gap-10">
					{/* Inbound signals — italic serif */}
					<div className="flex-shrink-0">
						<SignalLabels
							items={[
								"Meeting notes",
								"Company docs",
								"Slack · Teams",
								"Jira · GitHub",
								"Customer calls",
							]}
							align="right"
						/>
					</div>

					{/* Arrow in — red */}
					<div className="flex-shrink-0">
						<ArrowRight />
					</div>

					{/* ── Nested boxes ─────────────────────────────────────── */}
					<div className="flex-1 min-w-0">
						{/* FABRIC outer box */}
						<div className="border border-[var(--mkt-border)] bg-[var(--mkt-bg-card)]">
							<div className="px-5 pt-4 pb-2">
								<BoxLabel>Fabric</BoxLabel>
							</div>

							<div className="p-5 pt-3">
								{/* Context box */}
								<div className="border border-[var(--mkt-border)]">
									<div className="px-4 pt-3 pb-2">
										<BoxLabel>Context</BoxLabel>
									</div>

									<div className="p-4 pt-2">
										{/* Context items */}
										<div className="mb-4 flex flex-wrap gap-x-4 gap-y-1">
											{[
												"Plans",
												"Discussions",
												"Specs",
												"Technical designs",
												"Decisions",
												"Summaries",
												"Code",
											].map((item) => (
												<span
													key={item}
													className="text-[var(--mkt-tx-4)]"
													style={{
														...MONO,
														fontSize: "0.78rem",
													}}
												>
													{item}
												</span>
											))}
										</div>

										{/* Rules box */}
										<div className="border border-[var(--mkt-border)]">
											<div className="px-4 pt-3 pb-2">
												<BoxLabel>Rules</BoxLabel>
											</div>

											<div className="p-4 pt-2">
												{/* Rules items */}
												<div className="mb-4 flex flex-wrap gap-x-4 gap-y-1">
													{[
														"Automations",
														"Skills",
														"MCP Connections",
														"Permissions",
													].map((item) => (
														<span
															key={item}
															className="text-[var(--mkt-tx-4)]"
															style={{
																...MONO,
																fontSize:
																	"0.78rem",
															}}
														>
															{item}
														</span>
													))}
												</div>

												{/* Agents box */}
												<div className="border border-[var(--mkt-border)]">
													<div className="px-4 pt-3 pb-2">
														<BoxLabel>
															Agents
														</BoxLabel>
													</div>

													<div className="px-4 pb-4 pt-2">
														<AgentProgressBar
															isRevealed={
																isRevealed
															}
														/>
													</div>
												</div>
											</div>
										</div>
									</div>
								</div>
							</div>
						</div>
					</div>

					{/* Arrow out — red */}
					<div className="flex-shrink-0">
						<ArrowRight />
					</div>

					{/* Outbound — italic serif */}
					<div className="flex-shrink-0">
						<SignalLabels
							items={[
								"Instant answers",
								"Shipped code",
								"Reports & docs",
							]}
						/>
					</div>
				</div>
			</div>

			{/* ── Mobile: solid red spine + nested boxes ────────────────── */}
			<div className="block md:hidden">
				<div className="mx-auto" style={{ maxWidth: "22rem" }}>
					{/* Inbound: up-arrow + italic serif labels */}
					<div className="relative pl-7 pb-6">
						{/* Solid red spine */}
						<div
							className="absolute left-3 top-0 bottom-0 w-px bg-[var(--mkt-red)]"
							style={{ opacity: 0.4 }}
							aria-hidden="true"
						/>
						{/* Up arrow — red */}
						<svg
							width="10"
							height="10"
							viewBox="0 0 10 10"
							fill="none"
							aria-hidden="true"
							className="absolute left-[7.5px] top-0 text-[var(--mkt-red)]"
						>
							<path d="M5 0l4 5H1l4-5z" fill="currentColor" />
						</svg>
						<div className="space-y-0 pt-1">
							<SignalLabels
								items={[
									"Customer requests",
									"Bug reports",
									"Feedback",
								]}
							/>
						</div>
					</div>

					{/* FABRIC outer box */}
					<div className="relative border border-[var(--mkt-border)] bg-[var(--mkt-bg-card)]">
						{/* Red spine continues through the box */}
						<div
							className="absolute left-3 -top-1 -bottom-1 w-px bg-[var(--mkt-red)]"
							style={{ opacity: 0.4 }}
							aria-hidden="true"
						/>

						{/* FABRIC label */}
						<div className="pl-7 pr-4 pt-3 pb-2">
							<BoxLabel>Fabric</BoxLabel>
						</div>

						{/* Context box */}
						<div className="mx-3 mr-4 ml-7 mb-3 border border-[var(--mkt-border)]">
							<div className="px-3 pt-2.5 pb-1">
								<BoxLabel>Context</BoxLabel>
							</div>
							<div className="px-3 pb-3 space-y-0">
								{[
									"Plans",
									"Discussions",
									"Specs",
									"Technical designs",
									"Decisions",
									"Summaries",
									"Code",
								].map((item) => (
									<p
										key={item}
										className="text-[var(--mkt-tx-4)]"
										style={{
											...MONO,
											fontSize: "0.75rem",
											lineHeight: 1.7,
										}}
									>
										{item}
									</p>
								))}
							</div>

							{/* Rules box */}
							<div className="mx-3 mb-3 border border-[var(--mkt-border)]">
								<div className="px-3 pt-2.5 pb-1">
									<BoxLabel>Rules</BoxLabel>
								</div>
								<div className="px-3 pb-3 space-y-0">
									{[
										"Automations",
										"Skills",
										"Permissions",
									].map((item) => (
										<p
											key={item}
											className="text-[var(--mkt-tx-4)]"
											style={{
												...MONO,
												fontSize: "0.75rem",
												lineHeight: 1.7,
											}}
										>
											{item}
										</p>
									))}
								</div>

								{/* Agents box */}
								<div className="mx-3 mb-3 border border-[var(--mkt-border)]">
									<div className="px-3 pt-2.5 pb-1">
										<BoxLabel>Agents</BoxLabel>
									</div>
									<div className="px-3 pb-3 pt-1">
										<AgentProgressBar
											isRevealed={isRevealed}
										/>
									</div>
								</div>
							</div>
						</div>
					</div>

					{/* Outbound: red spine + down-arrow + italic serif */}
					<div className="relative pl-7 pt-6">
						{/* Red spine */}
						<div
							className="absolute left-3 top-0 bottom-0 w-px bg-[var(--mkt-red)]"
							style={{ opacity: 0.4 }}
							aria-hidden="true"
						/>
						{/* Down arrow — red */}
						<svg
							width="10"
							height="10"
							viewBox="0 0 10 10"
							fill="none"
							aria-hidden="true"
							className="absolute left-[7.5px] bottom-0 text-[var(--mkt-red)]"
						>
							<path d="M5 10l4-5H1l4 5z" fill="currentColor" />
						</svg>
						<p
							className="text-[var(--mkt-tx-4)]"
							style={{
								...SERIF,
								fontSize: "0.88rem",
								fontStyle: "italic",
							}}
						>
							Product
						</p>
					</div>
				</div>
			</div>
		</div>
	);
}

// ─── Editorial prose beneath diagram ────────────────────────────────────────

function ArchitectureNarrative({ isRevealed }: { isRevealed: boolean }) {
	return (
		<div
			className={cn(
				"mt-20 grid gap-12 md:grid-cols-3 md:gap-8 transition-all duration-700 delay-500",
				isRevealed
					? "opacity-100 translate-y-0"
					: "opacity-0 translate-y-8",
			)}
		>
			{/* Context */}
			<div>
				<div className="mb-4 flex items-center gap-2.5">
					<div className="h-3.5 w-0.5 bg-[var(--mkt-red)] flex-shrink-0" />
					<span
						className="text-[var(--mkt-red)]"
						style={{
							...MONO,
							fontSize: "0.7rem",
							letterSpacing: "0.15em",
							textTransform: "uppercase" as const,
						}}
					>
						Context
					</span>
				</div>
				<p
					className="text-[var(--mkt-tx-3)]"
					style={{
						fontSize: "0.96rem",
						lineHeight: 1.7,
					}}
				>
					Every signal your team generates — meetings, decisions,
					documents, code — becomes persistent, searchable context.
					Not a chat log. A knowledge base your whole team can query.
				</p>
			</div>

			{/* Rules */}
			<div>
				<div className="mb-4 flex items-center gap-2.5">
					<div className="h-3.5 w-0.5 bg-[var(--mkt-red)] flex-shrink-0" />
					<span
						className="text-[var(--mkt-red)]"
						style={{
							...MONO,
							fontSize: "0.7rem",
							letterSpacing: "0.15em",
							textTransform: "uppercase" as const,
						}}
					>
						Rules
					</span>
				</div>
				<p
					className="text-[var(--mkt-tx-3)]"
					style={{
						fontSize: "0.96rem",
						lineHeight: 1.7,
					}}
				>
					Automations trigger on real events. Skills encode your
					team's best practices. MCP connections bring your tools into
					one surface. Permissions keep humans in control.
				</p>
			</div>

			{/* Agents */}
			<div>
				<div className="mb-4 flex items-center gap-2.5">
					<div className="h-3.5 w-0.5 bg-[var(--mkt-red)] flex-shrink-0" />
					<span
						className="text-[var(--mkt-red)]"
						style={{
							...MONO,
							fontSize: "0.7rem",
							letterSpacing: "0.15em",
							textTransform: "uppercase" as const,
						}}
					>
						Agents
					</span>
				</div>
				<p
					className="text-[var(--mkt-tx-3)]"
					style={{
						fontSize: "0.96rem",
						lineHeight: 1.7,
					}}
				>
					Specialists for every kind of work — answering questions,
					researching topics, reviewing quality, and for engineering
					teams: writing, reviewing, and shipping code end-to-end.
				</p>
			</div>
		</div>
	);
}

// ─── Main section ───────────────────────────────────────────────────────────

export function FabricArchitectureSection() {
	const { ref, isRevealed } = useScrollReveal();

	return (
		<section ref={ref} className="bg-[var(--mkt-bg-alt)] py-24 lg:py-36">
			<div className="mx-auto max-w-5xl px-6 lg:px-8">
				{/* Editorial header */}
				<div
					className={cn(
						"mb-16 transition-all duration-700",
						isRevealed
							? "opacity-100 translate-y-0"
							: "opacity-0 translate-y-6",
					)}
				>
					{/* Red section label */}
					<div className="mb-7 flex items-center gap-3">
						<div className="h-4 w-0.5 bg-[var(--mkt-red)] flex-shrink-0" />
						<span className="font-sans text-[12px] uppercase tracking-[0.25em] text-[var(--mkt-red)]">
							How Fabric Works
						</span>
					</div>

					{/* Large serif headline */}
					<h2
						className="max-w-3xl text-[var(--mkt-tx-1)]"
						style={{
							...SERIF,
							fontSize: "clamp(2rem, 5vw, 3.5rem)",
							fontWeight: 400,
							lineHeight: "1.15",
						}}
					>
						Your knowledge. Connected. Working.
					</h2>

					{/* Editorial body */}
					<p
						className="mt-6 max-w-2xl text-[var(--mkt-tx-3)]"
						style={{
							fontSize: "1.1rem",
							lineHeight: 1.75,
						}}
					>
						Fabric builds a living knowledge base from every signal
						your team generates — meetings, decisions, docs, code —
						and puts it to work through configurable rules and
						coordinated agents.
					</p>
				</div>

				{/* The diagram */}
				<ArchitectureDiagram isRevealed={isRevealed} />

				{/* Layer explanations */}
				<ArchitectureNarrative isRevealed={isRevealed} />
			</div>
		</section>
	);
}
