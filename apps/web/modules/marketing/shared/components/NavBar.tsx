"use client";

import { LocaleLink, useLocalePathname } from "@i18n/routing";
import { config } from "@repo/config";
import { useSession } from "@saas/auth/hooks/use-session";
import { ColorModeToggle } from "@shared/components/ColorModeToggle";
import { LocaleSwitch } from "@shared/components/LocaleSwitch";
import { Logo } from "@shared/components/Logo";
import { Button } from "@ui/components/button";
import {
	Sheet,
	SheetContent,
	SheetTitle,
	SheetTrigger,
} from "@ui/components/sheet";
import { cn } from "@ui/lib";
import { MenuIcon } from "lucide-react";
import NextLink from "next/link";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useState } from "react";
import { useDebounceCallback } from "usehooks-ts";

export function NavBar() {
	const t = useTranslations();
	const { user } = useSession();
	const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
	const localePathname = useLocalePathname();
	const [isTop, setIsTop] = useState(true);

	const debouncedScrollHandler = useDebounceCallback(
		() => {
			setIsTop(window.scrollY <= 10);
		},
		150,
		{
			maxWait: 150,
		},
	);

	useEffect(() => {
		window.addEventListener("scroll", debouncedScrollHandler);
		debouncedScrollHandler();
		return () => {
			window.removeEventListener("scroll", debouncedScrollHandler);
		};
	}, [debouncedScrollHandler]);

	useEffect(() => {
		setMobileMenuOpen(false);
	}, [localePathname]);

	const isDocsPage = localePathname.startsWith("/docs");
	const isMarketingPage = !isDocsPage;

	const menuItems: {
		label: string;
		href: string;
	}[] = [
		{
			label: t("common.menu.agents"),
			href: "/#agents",
		},
		{
			label: t("common.menu.compare"),
			href: "/#compare",
		},
		{
			label: t("common.menu.blog"),
			href: "/blog",
		},
		{
			label: t("common.menu.docs"),
			href: "/docs",
		},
	];

	const isMenuItemActive = (href: string) => localePathname.startsWith(href);

	const handleHashLinkClick = (
		e: React.MouseEvent<HTMLAnchorElement>,
		href: string,
	) => {
		// Let modified clicks (Cmd/Ctrl/middle) open in new tab
		if (
			e.metaKey ||
			e.ctrlKey ||
			e.shiftKey ||
			e.altKey ||
			e.button !== 0
		) {
			return;
		}

		const hashIndex = href.indexOf("#");
		if (hashIndex === -1) {
			return;
		}

		const hash = href.slice(hashIndex + 1);
		const pathPart = href.slice(0, hashIndex) || "/";

		// Close mobile menu for hash links
		setMobileMenuOpen(false);

		// Only manually scroll if we're already on the target page
		if (localePathname !== pathPart) {
			return;
		}

		const element = document.getElementById(hash);
		if (element) {
			e.preventDefault();
			element.scrollIntoView({ behavior: "smooth" });
			window.history.pushState(null, "", `#${hash}`);
		}
	};

	return (
		<nav
			className={cn(
				"fixed top-0 left-0 z-50 w-full transition-shadow duration-200",
				isMarketingPage
					? !isTop
						? "shadow-sm backdrop-blur-lg bg-[var(--mkt-bg-hero)]/95"
						: "shadow-none"
					: !isTop
						? "bg-card/80 shadow-sm backdrop-blur-lg"
						: "shadow-none",
			)}
			data-test="navigation"
		>
			<div className="container">
				<div
					className={cn(
						"flex items-center justify-stretch gap-6 transition-[padding] duration-200",
						!isTop || isDocsPage ? "py-4" : "py-6",
					)}
				>
					<div className="flex flex-1 justify-start">
						<LocaleLink
							href="/"
							className="block hover:no-underline active:no-underline"
						>
							<Logo />
						</LocaleLink>
					</div>

					<div className="hidden flex-1 items-center justify-center lg:flex">
						{menuItems.map((menuItem) => (
							<LocaleLink
								key={menuItem.href}
								href={menuItem.href}
								onClick={(
									e: React.MouseEvent<HTMLAnchorElement>,
								) => handleHashLinkClick(e, menuItem.href)}
								className={cn(
									"block px-3 py-2 font-sans text-sm transition-colors duration-200",
									isMarketingPage
										? isMenuItemActive(menuItem.href)
											? "font-medium text-[var(--mkt-tx-1)]"
											: "text-[var(--mkt-tx-3)] hover:text-[var(--mkt-tx-1)]"
										: isMenuItemActive(menuItem.href)
											? "font-bold text-foreground"
											: "font-medium text-foreground/80",
								)}
								prefetch
							>
								{menuItem.label}
							</LocaleLink>
						))}
						<NextLink
							href="https://techfabric.com/contact"
							data-fabric-placement="navigation"
							className={cn(
								"block px-3 py-2 font-sans text-sm transition-colors duration-200",
								isMarketingPage
									? "text-[var(--mkt-tx-3)] hover:text-[var(--mkt-tx-1)]"
									: "font-medium text-foreground/80 hover:text-foreground",
							)}
						>
							{t("common.menu.contact")}
						</NextLink>
					</div>

					<div className="flex flex-1 items-center justify-end gap-3">
						<ColorModeToggle />
						{config.i18n.enabled && (
							<Suspense>
								<LocaleSwitch />
							</Suspense>
						)}

						<Sheet
							open={mobileMenuOpen}
							onOpenChange={(open) => setMobileMenuOpen(open)}
						>
							<SheetTrigger asChild>
								<Button
									className={cn(
										"lg:hidden",
										isMarketingPage &&
											"border-[var(--mkt-border)] text-[var(--mkt-tx-3)] hover:text-[var(--mkt-tx-1)]",
									)}
									size="icon"
									variant="light"
									aria-label="Menu"
								>
									<MenuIcon className="size-4" />
								</Button>
							</SheetTrigger>
							<SheetContent
								className={cn(
									"w-[280px]",
									isMarketingPage &&
										"bg-[var(--mkt-bg-hero)] border-[var(--mkt-border)]",
								)}
								side="right"
							>
								<SheetTitle />
								<div className="flex flex-col items-start justify-center">
									{menuItems.map((menuItem) => (
										<LocaleLink
											key={menuItem.href}
											href={menuItem.href}
											onClick={(
												e: React.MouseEvent<HTMLAnchorElement>,
											) =>
												handleHashLinkClick(
													e,
													menuItem.href,
												)
											}
											className={cn(
												"block px-3 py-2 font-medium text-base",
												isMarketingPage
													? isMenuItemActive(
															menuItem.href,
														)
														? "font-semibold text-[var(--mkt-tx-1)]"
														: "text-[var(--mkt-tx-3)]"
													: isMenuItemActive(
																menuItem.href,
															)
														? "font-bold text-foreground"
														: "text-foreground/80",
											)}
											prefetch
										>
											{menuItem.label}
										</LocaleLink>
									))}

									<NextLink
										href="https://techfabric.com/contact"
										data-fabric-placement="mobile-navigation"
										className={cn(
											"block px-3 py-2 font-medium text-base",
											isMarketingPage
												? "text-[var(--mkt-tx-3)]"
												: "text-foreground/80",
										)}
									>
										{t("common.menu.contact")}
									</NextLink>

									<NextLink
										key={user ? "start" : "login"}
										href={user ? "/app" : "/auth/login"}
										className={cn(
											"block px-3 py-2 text-base",
											isMarketingPage &&
												"text-[var(--mkt-tx-3)]",
										)}
										prefetch={!user}
									>
										{user
											? t("common.menu.dashboard")
											: t("common.menu.login")}
									</NextLink>
								</div>
							</SheetContent>
						</Sheet>

						{config.ui.saas.enabled &&
							(user ? (
								isMarketingPage ? (
									<NextLink
										key="dashboard-editorial"
										href="/app"
										className="hidden border border-[var(--mkt-border)] px-6 py-2 font-sans text-[11px] uppercase tracking-[0.2em] text-[var(--mkt-tx-2)] transition-colors duration-200 hover:border-[var(--mkt-tx-3)] hover:text-[var(--mkt-tx-1)] lg:inline-block"
									>
										{t("common.menu.dashboard")}
									</NextLink>
								) : (
									<Button
										key="dashboard"
										className="hidden lg:flex"
										asChild
										variant="secondary"
									>
										<NextLink href="/app">
											{t("common.menu.dashboard")}
										</NextLink>
									</Button>
								)
							) : (
								<>
									{!isMarketingPage && (
										<Button
											key="login"
											className="hidden lg:flex"
											asChild
											variant="secondary"
										>
											<NextLink
												href="/auth/login"
												prefetch
											>
												{t("common.menu.login")}
											</NextLink>
										</Button>
									)}
									{isMarketingPage ? (
										<NextLink
											key="signup-editorial"
											href="/auth/login"
											className="hidden border border-[var(--mkt-red)] px-6 py-2 font-sans text-[11px] uppercase tracking-[0.2em] text-[var(--mkt-red)] transition-colors duration-200 hover:bg-[var(--mkt-red)] hover:text-white lg:inline-block"
											prefetch
										>
											Get Started
										</NextLink>
									) : (
										<Button
											key="signup"
											className="hidden lg:flex"
											asChild
											variant="primary"
										>
											<NextLink
												href="/auth/login"
												prefetch
											>
												Get Started
											</NextLink>
										</Button>
									)}
								</>
							))}
					</div>
				</div>
			</div>
		</nav>
	);
}
