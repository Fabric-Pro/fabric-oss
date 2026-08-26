"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export type SettingsMenuSection = {
	title: string;
	avatar: ReactNode;
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

	const isActiveMenuItem = (href: string) =>
		pathname === href || pathname.startsWith(`${href}/`);

	return (
		<TooltipProvider delayDuration={0}>
			<div
				data-onboarding-target="settings-nav"
				className="min-w-0 lg:h-full"
			>
				<div className="rounded-xl border border-border/60 bg-background/80 backdrop-blur-sm lg:flex lg:h-full lg:flex-col lg:rounded-none lg:border-0 lg:bg-transparent lg:backdrop-blur-none">
					<div className="border-b border-border/60 px-3 py-3 lg:px-1 lg:py-4">
						<div
							className={cn(
								"hidden items-center",
								collapsed
									? "lg:flex lg:justify-center"
									: "lg:flex lg:gap-3",
							)}
						>
							{menuItems[0] ? (
								<SidebarTooltip
									disabled={!collapsed}
									label={menuItems[0].title}
								>
									<div className="shrink-0 text-muted-foreground/80 [&_svg]:size-7">
										{menuItems[0].avatar}
									</div>
								</SidebarTooltip>
							) : null}
							{!collapsed && menuItems[0] ? (
								<div className="min-w-0">
									<p className="truncate text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 select-none">
										Settings
									</p>
									<p
										className="truncate pt-0.5 text-sm font-medium text-foreground"
										title={menuItems[0].title}
									>
										{menuItems[0].title}
									</p>
								</div>
							) : null}
						</div>

						<div className="lg:hidden">
							{menuItems.map((item) => (
								<div key={item.title} className="space-y-2">
									<div className="flex min-w-0 items-center gap-2">
										<div className="shrink-0 text-muted-foreground/70">
											{item.avatar}
										</div>
										<p className="truncate text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
											{item.title}
										</p>
									</div>
									<ul className="no-scrollbar -mx-1 flex list-none gap-1 overflow-x-auto px-1 pb-1">
										{item.items.map((subitem) => (
											<li
												key={subitem.href}
												className="shrink-0"
											>
												<Link
													href={subitem.href}
													className={cn(
														"flex min-h-[44px] items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors",
														isActiveMenuItem(
															subitem.href,
														)
															? "bg-primary/8 font-semibold text-foreground"
															: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
													)}
													style={
														isActiveMenuItem(
															subitem.href,
														)
															? {
																	backgroundColor:
																		"color-mix(in srgb, var(--org-accent, hsl(var(--primary))) 10%, transparent)",
																	color: "var(--org-accent, hsl(var(--primary)))",
																}
															: undefined
													}
													aria-current={
														isActiveMenuItem(
															subitem.href,
														)
															? "page"
															: undefined
													}
												>
													{subitem.icon ? (
														<span className="shrink-0 opacity-70">
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
						<div className="no-scrollbar flex max-h-[calc(100vh-10rem)] flex-col gap-4 overflow-y-auto px-1 py-4 lg:flex-1">
							{menuItems.map((item) => (
								<div key={item.title}>
									{collapsed ? (
										<div className="mx-1 mb-2 h-px bg-border/40" />
									) : (
										<p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 select-none">
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
															"flex min-h-[44px] items-center rounded-md px-2 py-1.5 text-sm transition-colors",
															collapsed
																? "justify-center"
																: "gap-2",
															isActiveMenuItem(
																subitem.href,
															)
																? "bg-primary/8 font-semibold text-foreground"
																: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
														)}
														style={
															isActiveMenuItem(
																subitem.href,
															)
																? {
																		backgroundColor:
																			"color-mix(in srgb, var(--org-accent, hsl(var(--primary))) 10%, transparent)",
																		color: "var(--org-accent, hsl(var(--primary)))",
																	}
																: undefined
														}
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
																	"shrink-0 transition-colors [&_svg]:size-[21px]",
																	isActiveMenuItem(
																		subitem.href,
																	)
																		? ""
																		: "opacity-50",
																)}
															>
																{subitem.icon}
															</span>
														) : null}
														{!collapsed ? (
															<span className="truncate">
																{subitem.title}
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

						{onToggleCollapsed && showBottomToggle ? (
							<div className="border-t border-border/60">
								<button
									type="button"
									onClick={onToggleCollapsed}
									className={cn(
										"flex w-full items-center py-2 text-xs text-muted-foreground/60 transition-colors hover:bg-muted/40 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
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
											<span className="text-[10px] uppercase tracking-widest">
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
	if (disabled) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>{children}</TooltipTrigger>
				<TooltipContent side="right">{label}</TooltipContent>
			</Tooltip>
		);
	}

	return children;
}
