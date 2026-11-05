"use client";

import { config } from "@repo/config";
import { useSession } from "@saas/auth/hooks/use-session";
import { ColorModeToggle } from "@shared/components/ColorModeToggle";
import { LocaleSwitch } from "@shared/components/LocaleSwitch";
import { Logo } from "@shared/components/Logo";
import { Button } from "@ui/components/button";
import { useSidebar } from "fumadocs-ui/components/sidebar/base";
import { useDocsLayout } from "fumadocs-ui/layouts/docs";
import { SidebarIcon } from "lucide-react";
import NextLink from "next/link";
import { useTranslations } from "next-intl";
import { type ComponentProps, Suspense } from "react";

/**
 * Full-width docs bar: mark, search, and a way back into the app.
 * Rendered as the Fumadocs header slot so search and the sidebar trigger
 * stay inside the docs layout.
 */
export function DocsManualHeader(props: ComponentProps<"header">) {
	const t = useTranslations();
	const { user } = useSession();
	const { collapsed, setCollapsed } = useSidebar();
	const { slots } = useDocsLayout();
	const Search = slots.searchTrigger ? slots.searchTrigger.full : null;
	const SearchIconButton = slots.searchTrigger
		? slots.searchTrigger.sm
		: null;
	const SidebarToggle = slots.sidebar.trigger;

	return (
		<header
			{...props}
			className="fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-3 border-b bg-background px-3 md:px-5"
		>
			<SidebarToggle className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground md:hidden">
				<SidebarIcon className="size-4" />
			</SidebarToggle>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="hidden text-muted-foreground md:inline-flex"
				aria-label={
					collapsed
						? t("documentation.expandSidebar")
						: t("documentation.collapseSidebar")
				}
				aria-expanded={!collapsed}
				onClick={() => setCollapsed((value) => !value)}
			>
				<SidebarIcon className="size-4" />
			</Button>
			<NextLink
				href="/docs"
				className="shrink-0 hover:no-underline"
				aria-label={t("documentation.title")}
			>
				<Logo />
			</NextLink>
			<div className="mx-auto hidden min-w-0 w-full max-w-md flex-1 md:block">
				{Search ? (
					<Search
						hideIfDisabled
						className="h-9 w-full rounded-lg border-border bg-muted/50 ps-3 text-muted-foreground hover:bg-muted"
					/>
				) : null}
			</div>
			<div className="ms-auto flex items-center gap-1.5 md:ms-0">
				{SearchIconButton ? (
					<SearchIconButton hideIfDisabled className="md:hidden" />
				) : null}
				<ColorModeToggle />
				{config.i18n.enabled ? (
					<Suspense>
						<LocaleSwitch />
					</Suspense>
				) : null}
				{config.ui.saas.enabled ? (
					<Button
						variant={user ? "secondary" : "primary"}
						size="sm"
						asChild
					>
						<NextLink href={user ? "/app" : "/auth/login"}>
							{user
								? t("common.menu.dashboard")
								: t("common.menu.login")}
						</NextLink>
					</Button>
				) : null}
			</div>
		</header>
	);
}
