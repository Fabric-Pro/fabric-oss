"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ChevronDownIcon,
	PanelLeftCloseIcon,
	PanelLeftOpenIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useRef,
	useState,
} from "react";

export type SettingsMenuSection = {
	/** Omitted or empty: the menu draws a hairline instead of a label. */
	title?: string;
	avatar?: ReactNode;
	items: {
		title: string;
		href: string;
		icon?: ReactNode;
	}[];
};

export function SettingsMenu({
	menuItems,
	collapsed = false,
	onToggleCollapsed,
	showBottomToggle = true,
}: {
	menuItems: SettingsMenuSection[];
	collapsed?: boolean;
	onToggleCollapsed?: () => void;
	showBottomToggle?: boolean;
}) {
	const pathname = usePathname();
	const scrollRef = useRef<HTMLDivElement>(null);
	const hasMoreBelow = useHasMoreBelow(scrollRef, menuItems, collapsed);

	const isActiveMenuItem = (href: string) =>
		pathname === href || pathname.startsWith(`${href}/`);

	// Keep the active settings item in view when navigating to sections further
	// down the list (such as Account settings under `/settings/account/*`).
	useEffect(() => {
		const container = scrollRef.current;
		if (!container) {
			return;
		}
		const activeLink = container.querySelector<HTMLElement>(
			'[aria-current="page"]',
		);
		if (activeLink && typeof activeLink.scrollIntoView === "function") {
			activeLink.scrollIntoView({ block: "nearest" });
		}
	}, [pathname, collapsed]);

	return (
		<TooltipProvider delayDuration={0}>
			<div
				data-onboarding-target="settings-nav"
				className="min-w-0 lg:h-full"
			>
				<div className="rounded-lg border border-border bg-card lg:flex lg:h-full lg:flex-col lg:rounded-none lg:border-0 lg:bg-transparent">
					{/* Mobile horizontal strip — hidden on desktop so collapsing/expanding
					    the settings rail never shifts the vertical position of icons. */}
					<div className="border-b border-border/60 px-3 py-3 lg:hidden">
						<div className="lg:hidden">
							{menuItems.map((item, index) => (
								<div
									key={item.title || `group-${index}`}
									className="space-y-2"
								>
									<div className="flex min-w-0 items-center gap-2">
										<div className="shrink-0 text-muted-foreground/70">
											{item.avatar}
										</div>
										<p className="text-xs font-normal text-muted-foreground truncate">
											{item.title}
										</p>
									</div>
									<ul className="no-scrollbar -mx-1 flex list-none gap-1 overflow-x-auto px-1 py-1">
										{item.items.map((subitem) => (
											<li
												key={subitem.href}
												className="shrink-0"
											>
												<Link
													href={subitem.href}
													className={cn(
														"flex min-h-[32px] items-center gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
														isActiveMenuItem(
															subitem.href,
														)
															? "bg-primary/[0.12] dark:bg-primary/[0.20] font-semibold text-primary-hover dark:text-primary"
															: "text-foreground hover:bg-foreground/[0.06]",
													)}
													aria-current={
														isActiveMenuItem(
															subitem.href,
														)
															? "page"
															: undefined
													}
												>
													{subitem.icon ? (
														<span
															className={cn(
																"shrink-0 [&_svg]:size-4 [&_svg]:opacity-100",
																isActiveMenuItem(
																	subitem.href,
																)
																	? "text-primary [&_svg]:text-primary"
																	: "text-foreground [&_svg]:text-foreground",
															)}
														>
															{subitem.icon}
														</span>
													) : null}
													<span>{subitem.title}</span>
												</Link>
											</li>
										))}
									</ul>
								</div>
							))}
						</div>
					</div>

					<div className="hidden lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
						<div className="relative flex min-h-0 flex-1 flex-col">
							<div
								ref={scrollRef}
								data-testid="settings-nav-scroll"
								className="no-scrollbar flex max-h-[calc(100vh-5.5rem)] scroll-pb-14 flex-col gap-3.5 overflow-y-auto px-2 py-2.5 lg:h-full lg:flex-1"
							>
								{menuItems.map((item, index) => (
									<div key={item.title || `group-${index}`}>
										{collapsed || !item.title ? (
											// A hairline separates an untitled group from the one
											// above it; the first group has nothing to separate from.
											index > 0 ? (
												<div className="mx-1 mb-2 h-px bg-border" />
											) : null
										) : (
											<p className="mb-1 px-2.5 text-xs font-normal text-muted-foreground select-none">
												{item.title}
											</p>
										)}
										<ul className="flex list-none flex-col gap-0.5">
											{item.items.map((subitem) => (
												<li key={subitem.href}>
													<SidebarTooltip
														disabled={!collapsed}
														label={subitem.title}
													>
														<Link
															href={subitem.href}
															className={cn(
																"group flex min-h-[28px] items-center rounded-md px-2.5 py-1 text-sm transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
																collapsed
																	? "justify-center px-2"
																	: "gap-2.5",
																isActiveMenuItem(
																	subitem.href,
																)
																	? "bg-primary/[0.12] dark:bg-primary/[0.20] font-semibold text-primary-hover dark:text-primary"
																	: "text-foreground hover:bg-foreground/[0.06]",
															)}
															aria-current={
																isActiveMenuItem(
																	subitem.href,
																)
																	? "page"
																	: undefined
															}
															aria-label={
																collapsed
																	? subitem.title
																	: undefined
															}
														>
															{subitem.icon ? (
																<span
																	className={cn(
																		"flex shrink-0 items-center justify-center transition-colors [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:opacity-100",
																		isActiveMenuItem(
																			subitem.href,
																		)
																			? "text-primary [&_svg]:text-primary"
																			: "text-foreground [&_svg]:text-foreground",
																	)}
																>
																	{
																		subitem.icon
																	}
																</span>
															) : null}
															{!collapsed ? (
																<span className="truncate">
																	{
																		subitem.title
																	}
																</span>
															) : null}
														</Link>
													</SidebarTooltip>
												</li>
											))}
										</ul>
									</div>
								))}
							</div>
							{hasMoreBelow ? (
								<div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-14 items-end justify-center bg-gradient-to-t from-background via-background/80 to-transparent pb-1.5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200">
									<button
										type="button"
										onClick={() =>
											scrollDownBy(scrollRef.current)
										}
										aria-label="Scroll to more settings"
										className="pointer-events-auto flex size-7 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-xs transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
									>
										<ChevronDownIcon
											className="size-4"
											aria-hidden="true"
										/>
									</button>
								</div>
							) : null}
						</div>

						{onToggleCollapsed && showBottomToggle ? (
							<div className="border-t border-border">
								<button
									type="button"
									onClick={onToggleCollapsed}
									className={cn(
										"flex w-full items-center py-2 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/60 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
										collapsed
											? "justify-center px-2"
											: "justify-between px-3",
									)}
									aria-label={
										collapsed
											? "Expand settings sidebar"
											: "Collapse settings sidebar"
									}
								>
									{collapsed ? (
										<PanelLeftOpenIcon className="size-3.5" />
									) : (
										<>
											<span className="text-xs font-medium">
												Collapse
											</span>
											<PanelLeftCloseIcon className="size-3.5" />
										</>
									)}
								</button>
							</div>
						) : null}
					</div>
				</div>
			</div>
		</TooltipProvider>
	);
}

function SidebarTooltip({
	children,
	disabled,
	label,
}: {
	children: ReactNode;
	disabled: boolean;
	label: string;
}) {
	if (disabled || !label) {
		return children;
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			<TooltipContent side="right">{label}</TooltipContent>
		</Tooltip>
	);
}

function useHasMoreBelow(
	ref: RefObject<HTMLElement | null>,
	menuItems: SettingsMenuSection[],
	collapsed: boolean,
): boolean {
	const [hasMoreBelow, setHasMoreBelow] = useState(false);

	useEffect(() => {
		const el = ref.current;
		if (!el) {
			return;
		}

		const update = () => {
			setHasMoreBelow(
				el.scrollHeight - el.scrollTop - el.clientHeight > 1,
			);
		};
		update();

		el.addEventListener("scroll", update, { passive: true });

		if (typeof ResizeObserver === "undefined") {
			window.addEventListener("resize", update);
			return () => {
				el.removeEventListener("scroll", update);
				window.removeEventListener("resize", update);
			};
		}

		const observer = new ResizeObserver(update);
		observer.observe(el);
		for (const child of Array.from(el.children)) {
			observer.observe(child);
		}
		return () => {
			el.removeEventListener("scroll", update);
			observer.disconnect();
		};
	}, [ref, menuItems, collapsed]);

	return hasMoreBelow;
}

function scrollDownBy(el: HTMLElement | null) {
	if (!el) {
		return;
	}
	const prefersReducedMotion =
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	el.scrollBy({
		top: Math.max(el.clientHeight * 0.75, 120),
		behavior: prefersReducedMotion ? "auto" : "smooth",
	});
}
