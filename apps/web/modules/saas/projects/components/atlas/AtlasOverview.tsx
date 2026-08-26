"use client";

/**
 * Atlas "Overview" — a repository dashboard.
 *
 * A read-first landing for the Atlas tab: an editorial hero (a plain-language
 * summary of what the codebase does + a language-mix breakdown), a single
 * headline stat strip, and two content cards — the top business capabilities
 * and the detected tech stack — plus a one-click export of the whole analysis.
 *
 * Everything is derived on the client from the two graphs (technical + business)
 * and the analysis `status`, so the dashboard needs no dedicated endpoint. Each
 * capability is a jump-off point: clicking one opens it in the graph.
 */
import type { AtlasStatus, GraphMode } from "@repo/atlas/types";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@ui/components/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	ChevronRightIcon,
	Code2Icon,
	FileIcon,
	FilesIcon,
	GitBranchIcon,
	LayersIcon,
	type LucideIcon,
	NetworkIcon,
	PackageIcon,
	Share2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { AtlasTechStackPanel } from "./AtlasTechStackPanel";
import { AtlasTourPanel } from "./AtlasTourPanel";
import { resolveNodeCategory } from "./atlas-categories";
import { languageColorVar } from "./atlas-utils";

interface AtlasOverviewProps {
	projectId: string;
	organizationId: string | null;
	repositoryIntegrationId: string | null;
	status: AtlasStatus;
	onOpenNode: (mode: GraphMode, key: string) => void;
}

const MAX_LANGUAGES = 8;
const MAX_CAPABILITIES = 8;

/** Editorial section label: thin primary bar + uppercase wide tracking. */
function EditorialLabel({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-2">
			<span
				aria-hidden="true"
				className="h-4 w-0.5 rounded-full bg-primary"
			/>
			<span className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
				{children}
			</span>
		</div>
	);
}

export function AtlasOverview({
	projectId,
	organizationId,
	repositoryIntegrationId,
	status,
	onOpenNode,
}: AtlasOverviewProps) {
	const t = useTranslations("projects.atlas.overview");
	const tCat = useTranslations("projects.atlas.category");
	// Page of the inline hero walkthrough (always visible; 0 = intro, then one
	// page per business-tour capability).
	const [tourStep, setTourStep] = useState(0);

	const technicalQuery = useQuery(
		orpc.atlas.graph.queryOptions({
			input: {
				projectId,
				mode: "TECHNICAL",
				repositoryIntegrationId: repositoryIntegrationId ?? undefined,
				organizationId: organizationId ?? null,
			},
		}),
	);
	const businessQuery = useQuery(
		orpc.atlas.graph.queryOptions({
			input: {
				projectId,
				mode: "BUSINESS",
				repositoryIntegrationId: repositoryIntegrationId ?? undefined,
				organizationId: organizationId ?? null,
			},
		}),
	);

	const technicalNodes = technicalQuery.data?.nodes ?? [];
	const businessNodes = businessQuery.data?.nodes ?? [];

	// Language breakdown across the technical modules → counts + percentages.
	// Percentages are over the FULL set (not the capped display list) so they
	// always sum sensibly; the bars then render the top languages.
	const languageStats = useMemo(() => {
		const counts = new Map<string, number>();
		for (const node of technicalNodes) {
			if (node.kind === "MODULE" && node.language) {
				counts.set(node.language, (counts.get(node.language) ?? 0) + 1);
			}
		}
		const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
		const all = [...counts.entries()]
			.map(([language, count]) => ({
				language,
				count,
				pct: total > 0 ? Math.round((count / total) * 100) : 0,
			}))
			.sort(
				(a, b) =>
					b.count - a.count || a.language.localeCompare(b.language),
			);
		return { all, distinctCount: all.length };
	}, [technicalNodes]);

	const topLanguages = languageStats.all.slice(0, MAX_LANGUAGES);

	const moduleCount = useMemo(
		() => technicalNodes.filter((node) => node.kind === "MODULE").length,
		[technicalNodes],
	);

	const capabilityCount = useMemo(
		() => businessNodes.filter((node) => node.kind === "CAPABILITY").length,
		[businessNodes],
	);

	// Undirected degree of each business node — how connected a capability is.
	const connectionsByKey = useMemo(() => {
		const counts = new Map<string, number>();
		for (const edge of businessQuery.data?.edges ?? []) {
			counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
			counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
		}
		return counts;
	}, [businessQuery.data?.edges]);

	// Business capabilities (domains + capabilities), ranked by connectivity —
	// the natural "where does the value live" list.
	const allCapabilities = useMemo(
		() =>
			businessNodes
				.filter(
					(node) =>
						node.kind === "DOMAIN" || node.kind === "CAPABILITY",
				)
				.map((node) => ({
					node,
					connections: connectionsByKey.get(node.key) ?? 0,
				}))
				.sort(
					(a, b) =>
						b.connections - a.connections ||
						a.node.label.localeCompare(b.node.label),
				),
		[businessNodes, connectionsByKey],
	);
	const topCapabilities = allCapabilities.slice(0, MAX_CAPABILITIES);

	const repositoryName = status.repository?.repositoryName ?? "repository";
	// Short display name for the hero headline (drop any "owner/" prefix).
	const shortRepoName = repositoryName.split("/").pop() || repositoryName;
	const isLoading = technicalQuery.isLoading || businessQuery.isLoading;

	// Hero copy. Title prefers a future generated headline (Pass 3) and falls
	// back to a derived "{repo} — codebase map". Summary prefers the AI-narrated
	// business-tour intro (today's "what this codebase does"), then composes from
	// the top capability descriptions, then a generic line.
	const heroTitle = t("heroTitleFallback", { repo: shortRepoName });
	const heroSummary = useMemo(() => {
		const intro = status.businessTour?.intro?.trim();
		if (intro) {
			return intro;
		}
		const composed = topCapabilities
			.map(({ node }) => node.description?.trim())
			.filter((value): value is string => Boolean(value))
			.slice(0, 2)
			.join(" ");
		if (composed) {
			return composed;
		}
		return t("heroSummaryFallback");
	}, [status.businessTour?.intro, topCapabilities, t]);

	// Dominant ecosystem (npm / nuget / pip …) → tech-stack card sub-label.
	const techEcosystem = useMemo(() => {
		const counts = new Map<string, number>();
		for (const entry of status.techStack ?? []) {
			if (entry.ecosystem) {
				counts.set(
					entry.ecosystem,
					(counts.get(entry.ecosystem) ?? 0) + 1,
				);
			}
		}
		let best: string | null = null;
		let bestCount = 0;
		for (const [eco, count] of counts) {
			if (count > bestCount) {
				best = eco;
				bestCount = count;
			}
		}
		return best;
	}, [status.techStack]);

	const stats: {
		key: string;
		label: string;
		value: number;
		icon: typeof NetworkIcon;
	}[] = [
		{
			key: "nodes",
			label: t("statNodes"),
			value: status.nodeCount,
			icon: NetworkIcon,
		},
		{
			key: "relationships",
			label: t("statRelationships"),
			value: status.edgeCount,
			icon: Share2Icon,
		},
		{
			key: "files",
			label: t("statFiles"),
			value: status.filesAnalyzed,
			icon: FilesIcon,
		},
		{
			key: "modules",
			label: t("statModules"),
			value: moduleCount,
			icon: PackageIcon,
		},
		{
			key: "capabilities",
			label: t("statCapabilities"),
			value: capabilityCount,
			icon: LayersIcon,
		},
		{
			key: "languages",
			label: t("statLanguages"),
			value: languageStats.distinctCount,
			icon: Code2Icon,
		},
	];

	const hasTechStack = !!status.techStack && status.techStack.length > 0;

	return (
		<div className="space-y-4">
			{isLoading ? (
				<div className="space-y-4">
					<Skeleton className="h-72 w-full rounded-xl" />
					<div className="grid gap-4 lg:grid-cols-2">
						<Skeleton className="h-80 w-full rounded-xl" />
						<Skeleton className="h-80 w-full rounded-xl" />
					</div>
				</div>
			) : (
				<>
					{/* ── A. Hero (2 columns) ─────────────────────────────── */}
					{/* LEFT (the wider ~1.8fr column): the "what this codebase does"
					    block (editorial label + serif title + carousel tour) — the
					    description gets the room; the tour body is a fixed height so
					    paging never reflows the hero.
					    RIGHT (the narrower ~1fr column): a compact 2×3 grid of the
					    six headline stats with the language mix + analysed-commit
					    footer beneath. Below lg the two columns stack (text → stats
					    → languages). */}
					<div className="overflow-hidden rounded-xl border border-border/60">
						<div className="grid gap-px bg-border/60 lg:grid-cols-[1.8fr_1fr]">
							{/* LEFT — summary + inline tour. */}
							<div className="relative overflow-hidden bg-card px-6 py-5 lg:px-7 lg:py-6">
								<div
									aria-hidden="true"
									className="pointer-events-none absolute inset-0"
									style={{
										background:
											"radial-gradient(circle at top left, color-mix(in srgb, var(--primary) 10%, transparent), transparent 55%)",
									}}
								/>
								<div
									aria-hidden="true"
									className="pointer-events-none absolute inset-0 opacity-[0.04]"
									style={{
										backgroundImage:
											"radial-gradient(circle, var(--foreground) 1px, transparent 1px)",
										backgroundSize: "26px 26px",
										maskImage:
											"linear-gradient(to bottom, black, transparent 90%)",
										WebkitMaskImage:
											"linear-gradient(to bottom, black, transparent 90%)",
									}}
								/>
								<div className="relative z-10">
									<EditorialLabel>
										{t("heroLabel")}
									</EditorialLabel>
									<h2 className="mt-3 max-w-[26ch] font-serif text-2xl font-normal leading-tight tracking-tight text-foreground lg:text-[1.75rem]">
										{heroTitle}
									</h2>
									{/* Interactive onboarding walkthrough, inline in
									    the hero (tour intro is page 1, then one page
									    per capability). Falls back to the static
									    summary when there's no tour with steps. */}
									{status.businessTour &&
									status.businessTour.steps.length > 0 ? (
										<AtlasTourPanel
											variant="hero"
											heroBodyClassName="h-36"
											tour={status.businessTour}
											activeStep={tourStep}
											onStepChange={setTourStep}
											onFocusNode={(key) =>
												onOpenNode("BUSINESS", key)
											}
										/>
									) : (
										<p className="mt-4 text-sm leading-relaxed text-muted-foreground">
											{heroSummary}
										</p>
									)}
								</div>
							</div>

							{/* RIGHT — compact stats grid + language mix + footer. */}
							<div className="flex flex-col bg-card px-6 py-5 lg:px-7 lg:py-6">
								{/* Six small headline stat cards. 2 cols on mobile;
								    3 cols while the hero is stacked full-width
								    (sm→lg); back to a tight 2×3 once the column
								    narrows beside the description at lg. */}
								<div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2">
									{stats.map((stat) => {
										const Icon = stat.icon;
										return (
											<div
												key={stat.key}
												className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5"
											>
												<div className="flex items-center gap-1.5 text-muted-foreground">
													<Icon
														aria-hidden="true"
														className="size-3.5 shrink-0"
													/>
													<span className="truncate text-[10px] font-semibold uppercase tracking-[0.12em]">
														{stat.label}
													</span>
												</div>
												<div className="mt-1 text-lg font-semibold tabular-nums leading-none text-foreground">
													{stat.value.toLocaleString()}
												</div>
											</div>
										);
									})}
								</div>

								{/* Language mix — segmented proportion bar + legend. */}
								<div className="mt-4 border-t border-border/60 pt-4">
									<p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground/70">
										{t("languageMixLabel")}
									</p>
									{topLanguages.length === 0 ? (
										<p className="mt-3 text-sm text-muted-foreground">
											{t("empty")}
										</p>
									) : (
										<>
											{/* GitHub-style proportion bar (decorative;
											    the legend below is the accessible
											    representation). */}
											<div
												aria-hidden="true"
												className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-muted"
											>
												{topLanguages.map(
													({ language, pct }) => (
														<span
															key={language}
															className="h-full"
															style={{
																width: `${pct}%`,
																backgroundColor:
																	languageColorVar(
																		language,
																	),
															}}
														/>
													),
												)}
											</div>
											<ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
												{topLanguages.map(
													({
														language,
														count,
														pct,
													}) => (
														<li
															key={language}
															className="flex items-center gap-1.5 text-xs"
														>
															<span
																aria-hidden="true"
																className="size-2 shrink-0 rounded-full"
																style={{
																	backgroundColor:
																		languageColorVar(
																			language,
																		),
																}}
															/>
															<span className="capitalize text-foreground/90">
																{language}
															</span>
															<span className="tabular-nums text-muted-foreground">
																{pct === 0 &&
																count > 0
																	? "<1%"
																	: `${pct}%`}
															</span>
														</li>
													),
												)}
											</ul>
										</>
									)}
								</div>

								{/* "Analysed {sha} on {branch}" footer. */}
								{status.analyzedShortSha && status.branch && (
									<div className="mt-4 flex items-center border-t border-border/60 pt-3">
										<span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
											<GitBranchIcon
												aria-hidden="true"
												className="size-3.5 shrink-0 opacity-70"
											/>
											<span className="truncate">
												{t("heroAnalysed")}{" "}
												<code className="font-mono text-[11px] text-foreground/80">
													{status.analyzedShortSha}
												</code>{" "}
												{t("heroOnBranch", {
													branch: status.branch,
												})}
											</span>
										</span>
									</div>
								)}
							</div>
						</div>
					</div>

					{/* ── B. Two-column content ──────────────────────────── */}
					{/* `lg:items-stretch` keeps both cards the same height so the
					    Tech stack card (fixed-height, internally scrolling) aligns
					    with the Business capabilities card beside it. */}
					<div className="grid gap-4 lg:grid-cols-2 lg:items-stretch">
						{/* Business capabilities. */}
						<section className="rounded-xl border border-border/60 bg-card p-5">
							<div className="mb-3 flex items-center justify-between gap-2">
								<h3 className="text-sm font-medium text-foreground">
									{t("capabilitiesTitle")}
								</h3>
								{allCapabilities.length > 0 && (
									<button
										type="button"
										onClick={() =>
											onOpenNode("BUSINESS", "")
										}
										className="flex items-center gap-1 rounded text-xs text-primary transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
									>
										{t("capabilitiesViewAll", {
											count: allCapabilities.length,
										})}
										<ChevronRightIcon
											aria-hidden="true"
											className="size-3.5"
										/>
									</button>
								)}
							</div>
							{topCapabilities.length === 0 ? (
								<p className="text-sm text-muted-foreground">
									{t("empty")}
								</p>
							) : (
								<ul className="space-y-0.5">
									{topCapabilities.map(
										({ node, connections }) => {
											// Prefer the EFFECTIVE persisted category
											// (user override / AI value); a custom
											// value reads neutral via the resolver.
											const resolved =
												resolveNodeCategory({
													label: node.label,
													filePath: node.filePath,
													description:
														node.description,
													kind: node.kind,
													category: node.category,
												});
											const fileCount =
												typeof node.metrics
													?.fileCount === "number"
													? node.metrics.fileCount
													: null;
											return (
												<CapabilityRow
													key={node.key}
													label={node.label}
													description={
														node.description
													}
													categoryColor={
														resolved.colorVar
													}
													CategoryIcon={resolved.Icon}
													categoryLabel={
														resolved.known
															? tCat(
																	resolved.known,
																)
															: resolved.value
													}
													fileCount={fileCount}
													filesTitle={
														fileCount === null
															? null
															: t(
																	"capabilityFiles",
																	{
																		count: fileCount,
																	},
																)
													}
													connections={connections}
													connectionsTitle={t(
														"capabilityConnections",
														{ count: connections },
													)}
													onOpen={() =>
														onOpenNode(
															"BUSINESS",
															node.key,
														)
													}
												/>
											);
										},
									)}
								</ul>
							)}
						</section>

						{/* Tech stack. */}
						<section className="flex flex-col rounded-xl border border-border/60 bg-card p-5">
							<div className="mb-3 flex items-center justify-between gap-2">
								<h3 className="text-sm font-medium text-foreground">
									{t("techStackTitle")}
								</h3>
								{techEcosystem && (
									<span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
										{techEcosystem}
									</span>
								)}
							</div>
							{hasTechStack ? (
								<AtlasTechStackPanel
									techStack={status.techStack ?? []}
									embedded
								/>
							) : (
								<p className="text-sm text-muted-foreground">
									{t("empty")}
								</p>
							)}
						</section>
					</div>
				</>
			)}
		</div>
	);
}

// ── Capability row ───────────────────────────────────────────────────────────

interface CapabilityRowProps {
	label: string;
	description: string | null;
	/** Effective category swatch colour (preset token or neutral). */
	categoryColor: string;
	/** Effective category glyph (preset icon, or a tag for custom). */
	CategoryIcon: LucideIcon;
	categoryLabel: string;
	fileCount: number | null;
	filesTitle: string | null;
	connections: number;
	connectionsTitle: string;
	onOpen: () => void;
}

function CapabilityRow({
	label,
	description,
	categoryColor: color,
	CategoryIcon: Icon,
	categoryLabel,
	fileCount,
	filesTitle,
	connections,
	connectionsTitle,
	onOpen,
}: CapabilityRowProps) {
	const tTooltip = useTranslations("tooltips.atlas");

	return (
		<li>
			<Tooltip>
				<TooltipTrigger asChild>
					{/* No aria-label here on purpose: the button's accessible name
					    comes from its contents (capability, description, counts),
					    which is what identifies the row. The tooltip carries the
					    "what happens on click" copy. */}
					<button
						type="button"
						onClick={onOpen}
						className="group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<span
							role="img"
							aria-label={categoryLabel}
							className="grid size-8 shrink-0 place-items-center rounded-lg"
							style={{
								color,
								backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`,
								border: `1px solid color-mix(in srgb, ${color} 26%, transparent)`,
							}}
						>
							<Icon aria-hidden="true" className="size-4" />
						</span>
						<span className="min-w-0 flex-1">
							<span className="block truncate text-[13px] font-medium text-foreground/90 group-hover:text-foreground">
								{label}
							</span>
							{description && (
								<span className="mt-0.5 block truncate text-xs text-muted-foreground">
									{description}
								</span>
							)}
						</span>
						<span className="flex shrink-0 items-center gap-3 text-[11px] tabular-nums text-muted-foreground">
							{/* Count chips stay non-focusable and tooltip-free: they sit
							    inside the row button, so a nested trigger would open a
							    second tooltip on top of the row's own, and an extra tab
							    stop per row would wreck keyboard travel down the list.
							    `role="img"` + `aria-label` carries the full count text. */}
							{fileCount !== null && (
								<span
									className="flex items-center gap-1"
									role="img"
									aria-label={filesTitle ?? undefined}
								>
									<FileIcon
										aria-hidden="true"
										className="size-3 opacity-70"
									/>
									{fileCount}
								</span>
							)}
							<span
								className="flex items-center gap-1"
								role="img"
								aria-label={connectionsTitle}
							>
								<NetworkIcon
									aria-hidden="true"
									className="size-3 opacity-70"
								/>
								{connections}
							</span>
						</span>
						<ChevronRightIcon
							aria-hidden="true"
							className="size-4 shrink-0 text-muted-foreground/50"
						/>
					</button>
				</TooltipTrigger>
				<TooltipContent>{tTooltip("openInGraph")}</TooltipContent>
			</Tooltip>
		</li>
	);
}
