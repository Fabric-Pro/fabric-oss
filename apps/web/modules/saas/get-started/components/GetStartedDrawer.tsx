"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { cn } from "@ui/lib";
import {
	ArrowRightIcon,
	ArrowUpRightIcon,
	ChevronDownIcon,
	CompassIcon,
	EyeIcon,
	SparklesIcon,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import {
	GET_STARTED_GROUPS,
	type GsContext,
	type GsItem,
	type GsRuntimeGates,
	isGsEntryEnabled,
} from "../lib/get-started-registry";

/** Where you can read the full product documentation. */
const DOCS_HREF = "/docs";

type Props = {
	onClose: () => void;
	onStartTour: () => void;
	onShowComponent: (item: GsItem) => void;
	/** Present when the current page has a detailed, in-page component tour. */
	onTourPage?: () => void;
	/**
	 * Whether a project tab is visible to this viewer (card #1837). Items
	 * pointing at a hidden tab would "Show me" an absent anchor.
	 */
	isTabVisible?: (tab: string) => boolean;
	/**
	 * Flag values the registry cannot resolve for itself, because they are
	 * scoped to the viewer's organization rather than to the build. Required:
	 * an absent object throws — `isGsEntryEnabled` reads
	 * `gates[entry.runtimeGate]` on the first runtime-gated item, so a caller
	 * that forgot to pass it fails loudly instead of silently hiding an entry
	 * from an organization that has the feature.
	 */
	gates: GsRuntimeGates;
};

function activeContextFor(pathname: string | null): GsContext {
	const projectMatch = pathname?.match(/\/projects\/([^/?#]+)/);
	if (projectMatch && projectMatch[1] !== "new") {
		return "project";
	}
	if (pathname && /\/settings(\/|$)/.test(pathname)) {
		return "settings";
	}
	return "workspace";
}

export function GetStartedDrawer({
	onClose,
	onStartTour,
	onShowComponent,
	onTourPage,
	isTabVisible,
	gates,
}: Props) {
	const t = useTranslations("onboarding.getStarted");
	const pathname = usePathname();
	const router = useRouter();
	const { basePath, isOrgContext } = useOrganizationContext();
	const { user } = useSession();
	const isAdmin = user?.role === "admin";

	const activeContext = useMemo(() => activeContextFor(pathname), [pathname]);
	const [expanded, setExpanded] = useState<Set<string>>(
		() => new Set([activeContext]),
	);

	// Filter out components hidden by a feature flag, role, or workspace scope.
	// Active context first, then the rest.
	const orderedGroups = useMemo(() => {
		const isVisible = (item: GsItem) => {
			// Covers BOTH the build-time `enabled` and the per-request
			// `runtimeGate` — one call, so neither can be forgotten later.
			if (!isGsEntryEnabled(item, gates)) {
				return false;
			}
			if (item.requiresRole === "admin" && !isAdmin) {
				return false;
			}
			if (item.scope === "personal" && isOrgContext) {
				return false;
			}
			if (item.scope === "org" && !isOrgContext) {
				return false;
			}
			if (
				item.projectTab &&
				isTabVisible &&
				!isTabVisible(item.projectTab)
			) {
				return false;
			}
			return true;
		};
		const groups = GET_STARTED_GROUPS.map((g) => ({
			group: g,
			items: g.items.filter(isVisible),
		})).filter((g) => g.items.length > 0);
		return groups.sort((a, b) => {
			const aw = a.group.context === activeContext ? 0 : 1;
			const bw = b.group.context === activeContext ? 0 : 1;
			return aw - bw;
		});
	}, [activeContext, isOrgContext, isAdmin, isTabVisible, gates]);

	const openHref = (item: GsItem) => {
		if (item.href) {
			router.push(item.href({ basePath }));
			onClose();
		}
	};

	const toggle = (id: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			next.has(id) ? next.delete(id) : next.add(id);
			return next;
		});

	return (
		<Sheet
			open
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
		>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
			>
				<SheetHeader className="border-border/70 border-b px-5 pt-5 pb-4 text-left">
					<SheetTitle className="flex items-center gap-2">
						<CompassIcon className="size-5 text-primary" />
						{t("title")}
					</SheetTitle>
					<SheetDescription>{t("subtitle")}</SheetDescription>
				</SheetHeader>

				<div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
					{orderedGroups.map(({ group, items }) => {
						const isOpen = expanded.has(group.id);
						return (
							<section
								key={group.id}
								className="overflow-hidden rounded-xl border border-border/70 bg-card"
							>
								<button
									type="button"
									onClick={() => toggle(group.id)}
									aria-expanded={isOpen}
									className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
								>
									<span className="min-w-0">
										<span className="block font-semibold text-[13.5px] text-foreground">
											{group.label}
										</span>
										<span className="block truncate text-[12px] text-muted-foreground">
											{group.intro}
										</span>
									</span>
									<ChevronDownIcon
										className={cn(
											"size-4 shrink-0 text-muted-foreground transition-transform",
											isOpen && "rotate-180",
										)}
									/>
								</button>

								{isOpen && (
									<ul className="border-border/60 border-t">
										{groupWithClusters(items).map((row) =>
											row.kind === "cluster" ? (
												<li
													key={`cluster-${row.label}`}
													role="presentation"
													className="bg-muted/30 px-4 pt-3 pb-1 font-medium text-[10.5px] text-muted-foreground uppercase tracking-[0.12em]"
												>
													{row.label}
												</li>
											) : (
												<GetStartedRow
													key={row.item.id}
													item={row.item}
													context={group.context}
													onShow={() =>
														onShowComponent(
															row.item,
														)
													}
													onOpen={() =>
														openHref(row.item)
													}
												/>
											),
										)}
									</ul>
								)}
							</section>
						);
					})}
				</div>

				<div className="flex flex-col gap-2 border-border/70 border-t p-4">
					{onTourPage && (
						<button
							type="button"
							onClick={onTourPage}
							className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 font-semibold text-[13.5px] text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
						>
							<SparklesIcon className="size-4 text-primary" />
							{t("tourThisPage")}
						</button>
					)}
					<button
						type="button"
						onClick={onStartTour}
						className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 font-semibold text-[13.5px] text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
					>
						<CompassIcon className="size-4" />
						{t("takeTour")}
					</button>
					<a
						href={DOCS_HREF}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-4 py-2 font-medium text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
					>
						{t("readDocs")}
						<ArrowUpRightIcon className="size-3.5" />
					</a>
					<p className="flex items-center justify-center gap-1.5 pt-1 text-center text-[11.5px] text-muted-foreground">
						<CompassIcon className="size-3.5 shrink-0 text-primary/70" />
						{t("compassHint")}
					</p>
				</div>
			</SheetContent>
		</Sheet>
	);
}

type ClusterRow =
	| { kind: "cluster"; label: string }
	| { kind: "item"; item: GsItem };

/** Insert cluster headers between items that carry a `cluster` label. */
function groupWithClusters(items: GsItem[]): ClusterRow[] {
	const rows: ClusterRow[] = [];
	let current: string | undefined;
	for (const item of items) {
		if (item.cluster && item.cluster !== current) {
			current = item.cluster;
			rows.push({ kind: "cluster", label: item.cluster });
		}
		rows.push({ kind: "item", item });
	}
	return rows;
}

function GetStartedRow({
	item,
	context,
	onShow,
	onOpen,
}: {
	item: GsItem;
	context: GsContext;
	onShow: () => void;
	onOpen: () => void;
}) {
	const t = useTranslations("onboarding.getStarted");
	const Icon = item.icon;
	const canSpotlight = Boolean(item.anchor || item.projectTab);
	// Project items resolve their project + tab via "Show me"; workspace and
	// settings items expose a direct open/configure link.
	const showOpen = context !== "project" && Boolean(item.href);
	const openLabel = context === "settings" ? t("configure") : t("open");

	return (
		<li className="flex gap-3 border-border/40 border-t px-4 py-3 first:border-t-0">
			<span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
				<Icon className="size-4" />
			</span>
			<div className="min-w-0 flex-1">
				<p className="font-medium text-[13.5px] text-foreground">
					{item.label}
				</p>
				<p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
					{item.description}
				</p>
				<div className="mt-1.5 flex flex-wrap items-center gap-3">
					{canSpotlight && (
						<button
							type="button"
							onClick={onShow}
							className="inline-flex items-center gap-1 font-medium text-[12px] text-primary transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm"
						>
							<EyeIcon className="size-3.5" />
							{t("showMe")}
						</button>
					)}
					{showOpen && (
						<button
							type="button"
							onClick={onOpen}
							className="inline-flex items-center gap-1 font-medium text-[12px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm"
						>
							<ArrowRightIcon className="size-3.5" />
							{openLabel}
						</button>
					)}
				</div>
			</div>
		</li>
	);
}
