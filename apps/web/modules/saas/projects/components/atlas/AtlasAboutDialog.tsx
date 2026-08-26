"use client";

/**
 * "About Atlas" info card — a general explainer for the Atlas FEATURE itself
 * (not the analysed repository).
 *
 * Rendered as a self-contained `(i)` trigger + Dialog so the orchestrator only
 * has to drop `<AtlasAboutDialog />` into the header controls row. The
 * card is editorial (uppercase ABOUT ATLAS label, serif title). The body is a
 * balanced two-column split: the per-repository flow — Analyse · Map · Explore ·
 * Ask, down a thin connector rail — on the LEFT, and the multi-repo System map as
 * a DISTINCT capability card on the RIGHT. A full-width amber "re-analyse
 * recommended" callout closes the card.
 *
 * Copy is i18n-driven (`projects.atlas.about.*`, German formal "Sie").
 * The footer emphasis uses a `**bold**` marker split rather than `t.rich` so the
 * key-echo test mock (which has no `.rich`) keeps working.
 */
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ui/components/dialog";
import { cn } from "@ui/lib";
import {
	AlertTriangleIcon,
	InfoIcon,
	LayoutGridIcon,
	type LucideIcon,
	NetworkIcon,
	RefreshCwIcon,
	Share2Icon,
	SparklesIcon,
	WaypointsIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment } from "react";

/** The four Atlas stages, in order — the per-repository flow. */
const STEPS: {
	key: "analyse" | "map" | "explore" | "ask";
	Icon: LucideIcon;
}[] = [
	{ key: "analyse", Icon: RefreshCwIcon },
	{ key: "map", Icon: NetworkIcon },
	{ key: "explore", Icon: LayoutGridIcon },
	{ key: "ask", Icon: SparklesIcon },
];

/**
 * Render a string, turning every `**…**` span into a bold emphasis. Test-safe:
 * the global next-intl mock echoes the key (no `**`), which renders unchanged.
 */
function renderEmphasis(text: string) {
	return text.split("**").map((segment, index) =>
		index % 2 === 1 ? (
			<strong key={index} className="font-semibold text-foreground">
				{segment}
			</strong>
		) : (
			<Fragment key={index}>{segment}</Fragment>
		),
	);
}

/** A small category-style icon chip, reused by the rail steps + the System card. */
function IconChip({ Icon }: { Icon: LucideIcon }) {
	return (
		<span
			aria-hidden="true"
			className="grid size-8 shrink-0 place-items-center rounded-lg"
			style={{
				color: "var(--primary)",
				backgroundColor:
					"color-mix(in srgb, var(--primary) 12%, transparent)",
				border: "1px solid color-mix(in srgb, var(--primary) 24%, transparent)",
			}}
		>
			<Icon className="size-4" />
		</span>
	);
}

export function AtlasAboutDialog() {
	const t = useTranslations("projects.atlas.about");

	return (
		<Dialog>
			<DialogTrigger asChild>
				<button
					type="button"
					aria-label={t("triggerLabel")}
					className="rounded-full p-1 text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<InfoIcon aria-hidden="true" className="size-4" />
				</button>
			</DialogTrigger>
			{/* Capped at 85vh with internal scroll so the card is NEVER cropped on
			    short / mobile viewports (where the 2 columns stack into one) — it
			    fits without scrolling on normal desktops, and stays fully reachable
			    everywhere else. */}
			<DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
				<DialogHeader className="space-y-2.5 text-left">
					<div className="flex items-center gap-2">
						<span
							aria-hidden="true"
							className="h-4 w-0.5 rounded-full bg-primary"
						/>
						<span className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
							{t("label")}
						</span>
					</div>
					<DialogTitle
						className="font-normal text-2xl leading-tight"
						style={{ fontFamily: "var(--font-serif)" }}
					>
						{t("title")}
					</DialogTitle>
					<DialogDescription className="text-sm leading-relaxed">
						{t("intro")}
					</DialogDescription>
				</DialogHeader>

				{/* Body: the per-repo flow (left) + the multi-repo System map (right). */}
				<div className="grid gap-5 sm:grid-cols-2 sm:items-stretch">
					{/* LEFT — the four per-repo stages down a thin connector rail. */}
					<ol>
						{STEPS.map(({ key, Icon }, index) => {
							const isLast = index === STEPS.length - 1;
							return (
								<li key={key} className="flex gap-3.5">
									{/* Left rail: numbered chip + connector to the next. */}
									<div className="flex flex-col items-center">
										<IconChip Icon={Icon} />
										{!isLast && (
											<span
												aria-hidden="true"
												className="my-1 w-px flex-1 bg-border"
											/>
										)}
									</div>
									{/* Content. Generous bottom spacing so the rail's steps
									    breathe and the left column reads at least as tall
									    as the right. */}
									<div
										className={cn(
											"min-w-0",
											isLast ? "pb-0" : "pb-6",
										)}
									>
										<div className="flex items-baseline gap-2">
											<span className="font-mono text-[10px] font-medium tabular-nums text-muted-foreground/60">
												{String(index + 1).padStart(
													2,
													"0",
												)}
											</span>
											<h3 className="text-sm font-semibold text-foreground">
												{t(`${key}Title`)}
											</h3>
										</div>
										<p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
											{t(`${key}Body`)}
										</p>
									</div>
								</li>
							);
						})}
					</ol>

					{/* RIGHT — two capability cards (you shape the map; the multi-repo
					    System map) above the re-analyse callout. Both cards grow
					    (flex-1) so this column's height matches the rail. */}
					<div className="flex h-full flex-col gap-3">
						{/* You build the map — connections feed the AI's atlas.
						    Icon + title on top; body full-width below. */}
						<div className="flex flex-1 flex-col justify-center gap-2 rounded-xl border border-border/70 bg-muted/30 p-4">
							<div className="flex items-center gap-2.5">
								<IconChip Icon={WaypointsIcon} />
								<div className="flex min-w-0 flex-wrap items-center gap-2">
									<h3 className="text-sm font-semibold text-foreground">
										{t("editTitle")}
									</h3>
									<span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
										{t("editTag")}
									</span>
								</div>
							</div>
							<p className="text-xs leading-relaxed text-muted-foreground">
								{t("editBody")}
							</p>
						</div>
						{/* The multi-repo System map — a DISTINCT capability. */}
						<div className="flex flex-1 flex-col justify-center gap-2 rounded-xl border border-primary/25 bg-primary/[0.05] p-4">
							<div className="flex items-center gap-2.5">
								<IconChip Icon={Share2Icon} />
								<div className="flex min-w-0 flex-wrap items-center gap-2">
									<h3 className="text-sm font-semibold text-foreground">
										{t("systemTitle")}
									</h3>
									<span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.12em] text-primary">
										{t("systemTag")}
									</span>
								</div>
							</div>
							<p className="text-xs leading-relaxed text-muted-foreground">
								{t("systemBody")}
							</p>
						</div>
						{/* Drift callout — amber/highlight, beneath the cards. */}
						<div className="flex gap-2.5 rounded-lg border border-highlight/30 bg-highlight/10 p-3">
							<AlertTriangleIcon
								aria-hidden="true"
								className="mt-px size-4 shrink-0 text-highlight"
							/>
							<p className="text-xs leading-relaxed text-muted-foreground">
								{renderEmphasis(t("footerNote"))}
							</p>
						</div>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
