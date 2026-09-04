"use client";

import { config } from "@repo/config";
import { FabricAgentLauncherProvider } from "@saas/agents/components/FabricAgentLauncher";
import { FunctionTagsRequiredGate } from "@saas/get-started/components/FunctionTagsRequiredGate";
import { GetStartedController } from "@saas/get-started/components/GetStartedController";
import { AiUsageLimitBanner } from "@saas/payments/components/AiUsageLimitBanner";
import { TiptapEditorRegistryProvider } from "@saas/projects/components/excalidraw-auto-insert/TiptapEditorRegistry";
import { AiGatewayWarningBanner } from "@saas/shared/components/AiGatewayWarningBanner";
import { NavBar } from "@saas/shared/components/NavBar";
import { FocusModeProvider } from "@saas/shared/contexts/FocusModeContext";
import {
	SidebarCollapseProvider,
	useSidebarCollapse,
} from "@saas/shared/contexts/SidebarCollapseContext";
import { BuildVersionWatcher } from "@shared/components/BuildVersionWatcher";
import { cn } from "@ui/lib";
import { usePathname } from "next/navigation";
import type { PropsWithChildren } from "react";
import {
	FullscreenProvider,
	useFullscreen,
} from "../contexts/FullscreenContext";

function AppWrapperContent({ children }: PropsWithChildren) {
	const { isFullscreen } = useFullscreen();
	const { isCollapsed } = useSidebarCollapse();
	const pathname = usePathname();
	// Only apply canvas behavior to workflow editor routes (e.g., /app/workflows/[id])
	// Exclude integrations, new, and list pages which need normal scrolling
	const isWorkflowCanvasRoute =
		pathname?.match(/^\/app\/workflows\/[^/]+$/) &&
		!pathname?.endsWith("/integrations") &&
		!pathname?.endsWith("/new");
	// Chatbot routes should also use full-height layout with internal scrolling only
	const isChatbotRoute =
		pathname?.endsWith("/chatbot") || pathname?.endsWith("/nexus");
	// Kanban embed routes need full-height layout with no padding
	const isKanbanRoute = !!pathname?.match(/\/kanban(\/|\?|$)/);
	// Combined check for full-height routes that need overflow hidden
	const isFullHeightRoute =
		isWorkflowCanvasRoute || isChatbotRoute || isKanbanRoute;

	// All routes use full-width layout — no card wrapper or outer padding
	const mainPaddingClasses = "p-0";
	const mainSurfaceClasses = cn(
		"flex flex-col w-full flex-1",
		isFullHeightRoute ? "h-full overflow-hidden" : "",
	);
	const innerSpacingClasses = "flex-1";
	const showCompactRail = config.ui.saas.useSidebarLayout && isFullscreen;
	const baseHeightClasses = (() => {
		if (config.ui.saas.useSidebarLayout && !isFullscreen) {
			// Dynamic sidebar offset: 232px expanded, 72px collapsed (matches NavBar md:w-[72px])
			const sidebarOffset = isCollapsed
				? "md:ml-[72px]"
				: "md:ml-[232px]";
			return isFullHeightRoute
				? cn("flex-1 h-[calc(100vh-4rem)]", sidebarOffset)
				: cn("flex-1 min-h-[calc(100vh-4rem)]", sidebarOffset);
		}
		if (showCompactRail) {
			return isFullHeightRoute
				? "flex-1 h-[calc(100vh-4rem)] md:ml-[72px]"
				: "flex-1 min-h-[calc(100vh-4rem)] md:ml-[72px]";
		}
		return isFullHeightRoute
			? "flex-1 h-[calc(100vh-4rem)]"
			: "flex-1 min-h-[calc(100vh-4rem)]";
	})();

	return (
		<div
			className={cn(
				"flex flex-col min-w-0 bg-[radial-gradient(farthest-corner_at_0%_0%,color-mix(in_oklch,var(--color-primary),transparent_95%)_0%,var(--color-background)_50%)] dark:bg-[radial-gradient(farthest-corner_at_0%_0%,color-mix(in_oklch,var(--color-primary),transparent_90%)_0%,var(--color-background)_50%)]",
				isFullHeightRoute
					? "h-screen overflow-hidden"
					: "min-h-screen overflow-x-clip",
				[config.ui.saas.useSidebarLayout ? "" : ""],
			)}
		>
			{/* Skip to main content — visible on focus for keyboard users */}
			<a
				href="#main-content"
				className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:shadow-lg"
			>
				Skip to main content
			</a>
			{config.ui.saas.useSidebarLayout &&
				(isFullscreen ? <NavBar forceCollapsed /> : <NavBar />)}
			<div
				className={cn(
					"flex flex-col transition-[margin] duration-200 ease-in-out",
					innerSpacingClasses,
					baseHeightClasses,
				)}
			>
				<main
					id="main-content"
					className={cn(mainSurfaceClasses, mainPaddingClasses, [
						config.ui.saas.useSidebarLayout ? "" : "",
					])}
				>
					<div
						className={cn(
							"min-w-0 max-w-full flex flex-col flex-1 w-full",
							isFullHeightRoute
								? "h-full overflow-hidden"
								: "px-6",
						)}
					>
						{/* Three advisory banners share this column, and their
						 * order is fixed here by the urgency of the block each
						 * describes — never by whichever component happens to
						 * sit higher in the markup. With no provider
						 * configured no user-facing AI runs at all, so that
						 * notice leads; a usage limit bites only some calls; a
						 * stale build bites nothing yet. All three can render
						 * at once (an organization can lose its provider and
						 * carry a usage breach in the same hour).
						 *
						 * Mounted here rather than in the organization layout,
						 * for the reason recorded when the usage-limit banner
						 * arrived: this point sits inside the sidebar-offset
						 * content area, and the outer (saas) layout would
						 * render them full-width and overlap the fixed NavBar.
						 * It is also the ONE mount that serves both the
						 * organization layout and the account layout, which is
						 * what the AI notice needs — it was mounted per
						 * dashboard before, and said nothing anywhere else.
						 * Each renders nothing when it has nothing to say. */}
						<AiGatewayWarningBanner />
						<AiUsageLimitBanner />
						{/* Detects a stale build; its backstop countdown
						 * banner renders here in flow, never as a fixed
						 * overlay, so it cannot cover the page. */}
						<BuildVersionWatcher />
						{children}
					</div>
				</main>
			</div>
			{/* Global "Get started" experience — the contextual drawer, the
			 * guided spotlight tour, and one-off "Show me" highlights. Renders
			 * nothing until launched (or auto-launched on first login). Mounted
			 * here so it overlays every /app page and survives navigation. */}
			<GetStartedController />
			{/* Blocking role/function-tag gate (Fizzy #2264). Renders nothing
			 * unless enforcement is on AND the user has no default tags.
			 * Mounted here, beside the Get-started controller, so it overlays
			 * every /app page and survives navigation. */}
			<FunctionTagsRequiredGate />
		</div>
	);
}

export function AppWrapper({ children }: PropsWithChildren) {
	return (
		<FullscreenProvider>
			<SidebarCollapseProvider>
				<FocusModeProvider>
					{/* TiptapEditorRegistry wraps the same subtree as the
					 * Fabric Agent Launcher so the Excalidraw chat -> editor
					 * auto-insert resolver (`useActiveTipTapEditor`) can read
					 * the launcher's context AND the registered TipTap
					 * editors from a single React tree. See spec
					 * `fabric/specs/2026-05-23-excalidraw-auto-insert/spec.md`
					 * § 8 (table row: TiptapEditorRegistry) + § 9 (resolver
					 * algorithm). No XOR-sensitive data lives in this
					 * registry -- it holds Editor refs + projectId strings
					 * only; the resolver filters by projectId so cross-tenant
					 * lookups are impossible. */}
					<TiptapEditorRegistryProvider>
						<FabricAgentLauncherProvider>
							<AppWrapperContent>{children}</AppWrapperContent>
						</FabricAgentLauncherProvider>
					</TiptapEditorRegistryProvider>
				</FocusModeProvider>
			</SidebarCollapseProvider>
		</FullscreenProvider>
	);
}
