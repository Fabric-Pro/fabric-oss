"use client";

import { authClient } from "@repo/auth/client";
import { config } from "@repo/config";
import { useSession } from "@saas/auth/hooks/use-session";
import { GetStartedPointer } from "@saas/get-started/components/GetStartedPointer";
import {
	GET_STARTED_OPEN_EVENT,
	ONBOARDING_ANCHORS,
} from "@saas/get-started/lib/tour-steps";
import { JobHubButton } from "@saas/jobs/components/JobHubButton";
import { purgeUser } from "@saas/meeting-digest/lib/personal-insights-cache";
import { NotificationBell } from "@saas/notifications/components/NotificationBell";
import { useContextPath } from "@saas/organizations/hooks";
import { useIsGuestInOrg } from "@saas/organizations/hooks/use-is-guest-in-org";
import {
	useAccountBasePath,
	useAccountPath,
	useOrganizationContext,
} from "@saas/organizations/hooks/use-organization-context";
import { useProjectShortcuts } from "@saas/projects/hooks/use-project-shortcuts";
import { ColorModeToggle } from "@saas/shared/components/ColorModeToggle";
import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { IncidentRailIndicator } from "@saas/shared/components/IncidentRailIndicator";
import { CloudArrowLeftRightIcon } from "@saas/shared/components/icons/CloudArrowLeftRightIcon";
import { FolderOpenIcon as SparkFolderOpenIcon } from "@saas/shared/components/icons/FolderOpenIcon";
import { McpServerIcon } from "@saas/shared/components/icons/McpServerIcon";
import { PuzzleIcon } from "@saas/shared/components/icons/PuzzleIcon";
import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import { SparklesIcon } from "@saas/shared/components/icons/SparklesIcon";
import { Square3Stack3DIcon } from "@saas/shared/components/icons/Square3Stack3DIcon";
import { WorkflowsIcon } from "@saas/shared/components/icons/WorkflowsIcon";
import { SidebarEdgeHandle } from "@saas/shared/components/SidebarEdgeHandle";
import { ThemeToggle } from "@saas/shared/components/ThemeToggle";
import { UserMenu } from "@saas/shared/components/UserMenu";
import { useSidebarCollapse } from "@saas/shared/contexts/SidebarCollapseContext";
import { isMonitoringFeatureEnabled } from "@saas/shared/lib/feature-flags";
import { Logo } from "@shared/components/Logo";
import { TruncatedText } from "@shared/components/TruncatedText";

import { Sheet, SheetContent, SheetTitle } from "@ui/components/sheet";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	Building2Icon,
	ChevronRightIcon,
	ClipboardListIcon,
	CompassIcon,
	FileTextIcon,
	FolderIcon,
	HeartPulseIcon,
	HomeIcon,
	LayoutTemplateIcon,
	LockIcon,
	LogOutIcon,
	MenuIcon,
	SettingsIcon,
	ShieldCheckIcon,
	StarIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ComponentType, type ReactNode, useState } from "react";
import { OrganzationSelect } from "../../organizations/components/OrganizationSelect";

// Onboarding "Get started" tour: default-ON kill switch. Gates the persistent
// launcher entry in the sidebar footer (the overlay itself is gated too).
const GET_STARTED_ENABLED = isMonitoringFeatureEnabled("feature-get-started");

type BaseNavItem = {
	label: string;
	href: string;
	icon: ComponentType<{ className?: string }>;
	isActive: boolean;
	disabled?: boolean;
	/** Onboarding-tour anchor id (`data-onboarding-target`), if any. */
	onboardingId?: string;
	/**
	 * Text appended to the accessible name but not shown. Icons here are
	 * `aria-hidden`, so an icon-only distinction (a starred vs. recency-filled
	 * project shortcut) carries no information for a screen reader without it.
	 */
	srSuffix?: string;
	/**
	 * Reveal the full label in a tooltip when it does not fit. Nav labels are
	 * authored to fit their width; project names are user-supplied and often are
	 * not, and two clipped names can read identically.
	 */
	truncateLabel?: boolean;
};

type SubNavItem = BaseNavItem;

type NavItem = BaseNavItem & {
	children?: SubNavItem[];
};

type NavSection = {
	label?: string;
	items: NavItem[];
};

type UtilityItem = {
	label: string;
	icon: ComponentType<{ className?: string }>;
	href?: string;
	onClick?: () => void;
	destructive?: boolean;
	onboardingId?: string;
};

/**
 * One row in the account-utilities group. The "Get started" launcher is wrapped
 * in its discoverability pointer so the marker and callout follow
 * the launcher into every chrome state; every other row renders plain.
 */
function AccountUtilityRow({
	item,
	collapsed,
	onClick,
	calloutEnabled,
}: {
	item: UtilityItem;
	collapsed: boolean;
	onClick?: () => void;
	/** False inside the mobile sheet — see GetStartedPointer's `calloutEnabled`. */
	calloutEnabled?: boolean;
}) {
	const row = (adornment?: ReactNode, adornmentLabel?: string) => (
		<SidebarUtilityItem
			{...item}
			collapsed={collapsed}
			onClick={onClick ?? item.onClick}
			adornment={adornment}
			adornmentLabel={adornmentLabel}
		/>
	);

	if (item.onboardingId !== ONBOARDING_ANCHORS.launcher) {
		return row();
	}

	return (
		<GetStartedPointer calloutEnabled={calloutEnabled}>
			{(marker, markerLabel) => row(marker, markerLabel)}
		</GetStartedPointer>
	);
}

export function NavBar({
	forceCollapsed = false,
}: {
	forceCollapsed?: boolean;
}) {
	const t = useTranslations();
	const pathname = usePathname();
	const { user } = useSession();
	const { basePath, isOrgContext } = useOrganizationContext();
	// Rollback lever for the agent-surface consolidation (#2040). Read here so
	// the nav destination moves with the route redirect rather than stranding
	// users on a surface the flag is meant to have turned off.
	const unifiedAgentInterface = useFeatureFlag("UNIFIED_AGENT_INTERFACE");
	const settingsPath = useContextPath("settings/general");
	const accountSettingsPath = useAccountPath("settings/account/profile");
	const isGuest = useIsGuestInOrg();
	const { isCollapsed, toggleCollapsed } = useSidebarCollapse();
	const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
	// Fullscreen pages render the sidebar force-collapsed with no persistent
	// expand control. This local override lets the edge handle temporarily
	// reveal the full sidebar (as an overlay) so every nav item stays reachable
	// without leaving the fullscreen view.
	const [fullscreenExpanded, setFullscreenExpanded] = useState(false);

	const { useSidebarLayout } = config.ui.saas;

	const showLabels = forceCollapsed ? fullscreenExpanded : !isCollapsed;

	const onLogout = () => {
		authClient.signOut({
			fetchOptions: {
				onSuccess: async () => {
					// #2104: this is the sidebar Logout — the primary sign-out
					// path. It duplicates UserMenu's handler, and QA caught that
					// patching only UserMenu left cached personal summaries on
					// disk after signing out from here. Both must purge.
					if (user?.id) {
						purgeUser(user.id);
					}
					window.location.href = new URL(
						config.auth.redirectAfterLogout,
						window.location.origin,
					).toString();
				},
			},
		});
	};

	// Project-only guests are rendered under the HOST organization's slug, but
	// their chrome is not the host's — the host is never named or linked in it,
	// and that guarantee is why this branch exists at all.
	//
	// It used to root them at /app, in a personal workspace. Personal context is
	// gone, and it turned out not to be needed: every account has an
	// organization now, so a guest has one of their own to be rooted in. The
	// host stays unnamed, nothing is disclosed, and the nav points somewhere
	// the person can actually go — which /app-rooted links no longer do.
	//
	// The project shortcuts below are the deliberate exception, and always
	// were: they are built from the project's OWN organization slug so a
	// guest's shortcut reaches the host project their chrome does not name.
	const ownBasePath = useAccountBasePath();
	// True for a guest, and for anything rendered outside an organization —
	// both are cases where the URL does not name a workspace the caller can be
	// rooted in, so the chrome is rooted in the one they have.
	const rootInOwnOrg = isGuest || !isOrgContext;
	const effectiveBasePath = rootInOwnOrg ? ownBasePath : basePath;

	// Quick-access project shortcuts (#1694). Called once here rather than
	// inside a per-item child: the nav item array is already assembled once in
	// this body, and the shortcut list is a derived structure rather than a
	// per-item value, so there is no per-item seam to put it in.
	const projectShortcuts = useProjectShortcuts();
	const projectShortcutItems: SubNavItem[] = projectShortcuts.map(
		(shortcut) => {
			// Built from the project's OWN org slug, not effectiveBasePath — a
			// guest browses under /app while their project lives in a host org,
			// and a /app-rooted link would render "Project not found".
			const href = shortcut.organizationSlug
				? `/app/${shortcut.organizationSlug}/projects/${shortcut.id}`
				: `/app/projects/${shortcut.id}`;

			return {
				href,
				label: shortcut.name,
				truncateLabel: true,
				icon: shortcut.isFavorite ? StarIcon : FolderIcon,
				// The icon is aria-hidden, so the favorited distinction needs text.
				srSuffix: shortcut.isFavorite ? "Favorite" : undefined,
				isActive: pathname.startsWith(href),
			};
		},
	);

	const accountHref = rootInOwnOrg ? accountSettingsPath : settingsPath;
	const accountLabel = rootInOwnOrg
		? t("app.userMenu.accountSettings")
		: t("app.menu.organizationSettings");
	const accountUtilities = user
		? [
				...(GET_STARTED_ENABLED
					? [
							{
								// Persistent entry point to (re)launch the
								// onboarding tour.
								label: t("onboarding.tour.launcher"),
								icon: CompassIcon,
								onClick: () =>
									window.dispatchEvent(
										new CustomEvent(GET_STARTED_OPEN_EVENT),
									),
								// Literal, not ONBOARDING_ANCHORS.launcher: the
								// CI drift guard verifies anchors are placed on
								// live components by scanning this file's SOURCE
								// for the quoted id. A constant reference reads
								// as a missing anchor and fails the guard.
								onboardingId: "onboarding-launcher",
							},
						]
					: []),
				{
					label: accountLabel,
					href: accountHref,
					icon: rootInOwnOrg ? SettingsIcon : Building2Icon,
				},
				// In an organization the entry above points at the
				// ORGANIZATION's settings, which left the account's own
				// settings with no route from anywhere in the chrome
				// (Fizzy #1875, R7/R8). The account link goes ALONGSIDE the
				// organization one rather than swapping with it.
				//
				// All four account-global pages have organization-side homes
				// now (`settings/account/*`), so this resolves inside an
				// organization rather than leaving context — the earlier note
				// here said the profile page had none, and that stopped being
				// true when the personal settings tree was replaced.
				//
				// Guests are excluded via `rootInOwnOrg`: `accountHref` IS
				// this link for them, so a second copy would be a duplicate.
				...(rootInOwnOrg
					? []
					: [
							{
								label: t("app.userMenu.accountSettings"),
								href: accountSettingsPath,
								icon: SettingsIcon,
							},
						]),
				...(user.role === "admin"
					? [
							{
								label: t("app.menu.admin"),
								// Keep the current workspace base so a system
								// admin stays in their org (`/app/{slug}/admin`).
								// A guest gets their OWN organization's admin
								// route, which is where `effectiveBasePath`
								// points for them.
								href: `${effectiveBasePath}/admin`,
								icon: ShieldCheckIcon,
							},
						]
					: []),
				{
					label: t("app.userMenu.logout"),
					icon: LogOutIcon,
					onClick: onLogout,
					destructive: true,
				},
			]
		: [];

	// Guests (users with project-only access to this org) get a nav rooted in
	// their OWN organization via effectiveBasePath, matching the switcher
	// above — never in the host organization they are looking at.
	// The pathname-based isActive checks keep items (e.g. Projects) lit
	// while a guest views a shared project under /app/{slug}/projects/{id}.
	const navSections: NavSection[] = [
		{
			label: "Main Navigation",
			items: [
				{
					label: t("app.menu.start"),
					href: effectiveBasePath,
					icon: HomeIcon,
					onboardingId: "nav-home",
					isActive: pathname === effectiveBasePath,
				},
				{
					// The unified agent chat (#2040). This slot used to point
					// at Nexus; Nexus is retired into this surface, and its
					// route redirects here. Keeping the prominent top-level
					// position rather than burying the chat under AI Agents —
					// the ticket's whole complaint was that the full-page chat
					// was undiscoverable.
					//
					// Gated on the same flag as the route redirect. Without
					// that, turning the flag off restores the Nexus page but
					// leaves every sidebar pointing at the new surface, so only
					// a hand-typed URL could reach the rollback target — the
					// lever would look present and not work. Caught by actually
					// flipping the flag on staging.
					label: unifiedAgentInterface
						? t("app.menu.aiChatbot")
						: t("app.menu.aiChatbotLegacy"),
					href: unifiedAgentInterface
						? `${effectiveBasePath}/agents/fabric-ai`
						: `${effectiveBasePath}/nexus`,
					icon: SparklesIcon,
					isActive:
						pathname.includes("/agents/fabric-ai") ||
						pathname.includes("/nexus") ||
						pathname.includes("/chatbot"),
					onboardingId: "nav-nexus",
				},
				...(config.prompts.enabled
					? [
							{
								label: t("app.menu.prompts"),
								href: `${effectiveBasePath}/prompts`,
								icon: FileTextIcon,
								onboardingId: "nav-prompts",
								isActive: pathname.includes("/prompts"),
							},
						]
					: []),
				{
					label: "Projects",
					href: `${effectiveBasePath}/projects`,
					icon: SparkFolderOpenIcon,
					// Quick-access shortcuts (#1694) sit beneath this item and
					// each points at a project detail route. Exclude any route a
					// rendered shortcut owns, so the deepest match carries the
					// active treatment and `aria-current` alone — otherwise
					// parent and child both light up and a screen reader
					// announces two current pages. Mirrors how AI Agents below
					// excludes its own children's routes.
					isActive:
						pathname.includes("/projects") &&
						!projectShortcutItems.some((child) =>
							pathname.startsWith(child.href),
						),
					onboardingId: "nav-projects",
					children: projectShortcutItems,
				},
				{
					label: "AI Agents",
					href: `${effectiveBasePath}/agents`,
					icon: RobotIcon,
					onboardingId: "nav-agents",
					isActive:
						pathname.includes("/agents") &&
						!pathname.includes("/settings/agents") &&
						!pathname.includes("/agent-templates") &&
						!pathname.includes("/agents/fabric-ai") &&
						!pathname.includes("/skills"),
					children: [
						{
							label: "Skills",
							href: `${effectiveBasePath}/skills`,
							icon: PuzzleIcon,
							isActive: pathname.includes("/skills"),
						},
						{
							label: "Templates",
							href: `${effectiveBasePath}/agent-templates`,
							icon: LayoutTemplateIcon,
							isActive: pathname.includes("/agent-templates"),
						},
					],
				},
				{
					label: "Workflows",
					href: `${effectiveBasePath}/workflows`,
					icon: WorkflowsIcon,
					onboardingId: "nav-workflows",
					isActive:
						pathname.includes("/workflows") &&
						!pathname.includes("/workflows/integrations") &&
						!pathname.includes("/settings/integrations"),
				},
				{
					label: "Integrations",
					href: `${effectiveBasePath}/settings/integrations`,
					icon: CloudArrowLeftRightIcon,
					onboardingId: "nav-integrations",
					isActive:
						pathname.includes("/workflows/integrations") ||
						pathname.includes("/settings/integrations"),
				},
				{
					label: "Workspaces",
					href: `${effectiveBasePath}/workspaces`,
					icon: Square3Stack3DIcon,
					onboardingId: "nav-workspaces",
					isActive: pathname.includes("/workspaces"),
				},
				{
					label: "MCP Servers",
					href: `${effectiveBasePath}/mcp-servers`,
					icon: McpServerIcon,
					onboardingId: "nav-mcp-servers",
					isActive: pathname.includes("/mcp-servers"),
				},
				{
					label: "Reports",
					href: `${effectiveBasePath}/report-templates`,
					icon: ClipboardListIcon,
					onboardingId: "nav-reports",
					isActive: pathname.includes("/report-templates"),
				},
				{
					label: "System Health",
					href: `${effectiveBasePath}/system-health`,
					icon: HeartPulseIcon,
					onboardingId: "nav-system-health",
					isActive: pathname.includes("/system-health"),
				},
			],
		},
	];

	// Flatten all items for horizontal/mobile nav
	const allItems = navSections.flatMap((s) =>
		s.items.flatMap((item) =>
			item.children ? [item, ...item.children] : [item],
		),
	);

	return (
		<>
			{/* ── MOBILE DRAWER ─────────────────────────────────── */}
			{useSidebarLayout && (
				<Sheet
					open={isMobileMenuOpen}
					onOpenChange={setIsMobileMenuOpen}
				>
					<SheetContent
						side="left"
						className="flex w-[85vw] max-w-[280px] flex-col p-0"
					>
						<SheetTitle className="sr-only">Navigation</SheetTitle>
						{/* Drawer header: logo + org selector */}
						<div className="flex flex-col gap-2 border-b border-border/60 px-4 py-4">
							<Link
								href="/app"
								onClick={() => setIsMobileMenuOpen(false)}
							>
								<Logo />
							</Link>
							{config.organizations.enable &&
								!config.organizations.hideOrganization && (
									<OrganzationSelect />
								)}
						</div>

						{/* Drawer nav sections */}
						<div className="no-scrollbar flex flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
							{navSections.map((section) => (
								<div key={section.label ?? "main"}>
									{section.label && (
										<p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/70 select-none">
											{section.label}
										</p>
									)}
									<ul className="flex list-none flex-col gap-0.5">
										{section.items.map((item) => (
											<li key={item.label}>
												<SidebarNavItem
													item={item}
													collapsed={false}
													onNavigate={() =>
														setIsMobileMenuOpen(
															false,
														)
													}
												/>
												{item.children &&
													item.children.length >
														0 && (
														<ul className="mt-0.5 ml-4 flex flex-col gap-0.5 border-l border-dashed border-border/40 pl-3">
															{item.children.map(
																(child) => (
																	<li
																		key={
																			child.href
																		}
																	>
																		<SidebarNavItem
																			item={
																				child
																			}
																			isChild
																			collapsed={
																				false
																			}
																			onNavigate={() =>
																				setIsMobileMenuOpen(
																					false,
																				)
																			}
																		/>
																	</li>
																),
															)}
														</ul>
													)}
											</li>
										))}
									</ul>
								</div>
							))}
							{accountUtilities.length > 0 && (
								<ul className="flex list-none flex-col gap-0.5 border-t border-border/35 pt-3">
									{accountUtilities.map((item) => (
										<li key={item.label}>
											<AccountUtilityRow
												item={item}
												collapsed={false}
												calloutEnabled={false}
												onClick={() => {
													setIsMobileMenuOpen(false);
													item.onClick?.();
												}}
											/>
										</li>
									))}
								</ul>
							)}
						</div>

						{/* Drawer footer: compact controls */}
						<SidebarControlsFooter collapsed={false} />
					</SheetContent>
				</Sheet>
			)}

			<nav
				aria-label="Main navigation"
				className={cn("w-full", {
					"w-full md:fixed md:top-0 md:left-0 md:h-full md:overflow-visible md:bg-card/95 md:border-r md:border-border/55 md:transition-[width] md:duration-200 md:ease-in-out md:z-30":
						useSidebarLayout,
					"md:w-[232px]": useSidebarLayout && showLabels,
					"md:w-[72px]": useSidebarLayout && !showLabels,
				})}
			>
				<div
					className={cn("container max-w-6xl py-4", {
						"container max-w-6xl py-4 md:flex md:h-full md:flex-col md:px-3 md:pt-4 md:pb-0 md:overflow-hidden":
							useSidebarLayout,
					})}
				>
					{/* Logo + Org selector */}
					<div className="flex flex-wrap items-center justify-between gap-4">
						<div
							className={cn("flex items-center gap-4 md:gap-2", {
								"md:flex md:w-full md:flex-col md:items-stretch md:align-stretch md:gap-3 md:pb-3 md:border-b md:border-border/30":
									useSidebarLayout,
							})}
						>
							{useSidebarLayout && !showLabels ? (
								// Collapsed rail: the brand mark is the "Home" link;
								// give it the same right-side hover tooltip as every
								// other rail icon for consistency.
								<TooltipProvider delayDuration={500}>
									<Tooltip>
										<TooltipTrigger asChild>
											<Link
												href="/app"
												aria-label="Home"
												className="block shrink-0 md:flex md:items-center md:justify-center"
											>
												<FabricLogo size={32} />
											</Link>
										</TooltipTrigger>
										<TooltipContent side="right">
											Home
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
							) : (
								<Link
									href="/app"
									className={cn("block shrink-0", {
										"md:flex md:items-center":
											useSidebarLayout,
									})}
								>
									<Logo />
								</Link>
							)}

							{config.organizations.enable &&
								!config.organizations.hideOrganization && (
									<>
										<span
											className={cn(
												"hidden opacity-30 md:block",
												{
													"md:hidden":
														useSidebarLayout,
												},
											)}
										>
											<ChevronRightIcon className="size-4" />
										</span>

										{/* Collapsed desktop rail: a compact circular
										 * workspace avatar so the user can still see
										 * (and switch) the workspace they're in. */}
										{useSidebarLayout && (
											<div
												className={cn(
													"hidden",
													showLabels
														? "md:hidden"
														: "md:flex md:justify-center",
												)}
											>
												<OrganzationSelect collapsed />
											</div>
										)}

										{/* Expanded sidebar + mobile: the full
										 * labelled workspace switcher. */}
										<div
											className={cn(
												useSidebarLayout && !showLabels
													? "md:hidden"
													: "",
												{
													"md:overflow-hidden md:transition-all md:duration-200":
														useSidebarLayout,
													"md:max-w-full md:opacity-100":
														useSidebarLayout &&
														showLabels,
												},
											)}
										>
											<OrganzationSelect
												className={cn({
													"md:mt-2": useSidebarLayout,
												})}
											/>
										</div>
									</>
								)}
						</div>

						{/* Mobile: hamburger + user menu */}
						<div
							className={cn(
								"mr-0 ml-auto flex items-center justify-end gap-2",
								{
									"md:hidden": useSidebarLayout,
								},
							)}
						>
							{useSidebarLayout && (
								<>
									<NotificationBell variant="mobile" />
									<JobHubButton variant="mobile" />
									<IncidentRailIndicator />
									<ThemeToggle variant="inline" />
									<button
										type="button"
										onClick={() =>
											setIsMobileMenuOpen(true)
										}
										className="flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
										aria-label="Open navigation menu"
										data-onboarding-target="mobile-nav-trigger"
									>
										<MenuIcon className="size-5" />
									</button>
								</>
							)}
							<UserMenu />
						</div>
					</div>

					{/* ── HORIZONTAL NAV (mobile) ── */}
					{!useSidebarLayout && (
						<ul className="no-scrollbar -mx-4 -mb-4 mt-6 flex list-none items-center justify-start gap-4 overflow-x-auto px-4 text-sm">
							{allItems.map((item) => (
								<li key={item.label}>
									{item.disabled ? (
										<span className="flex items-center gap-2 whitespace-nowrap border-b-2 border-transparent px-1 pb-3 opacity-40 cursor-not-allowed text-sm">
											<item.icon className="size-4 shrink-0" />
											<span>{item.label}</span>
										</span>
									) : (
										<Link
											href={item.href}
											className={cn(
												"flex items-center gap-2 whitespace-nowrap border-b-2 px-1 pb-3 transition-colors text-sm",
												item.isActive
													? "font-bold"
													: "border-transparent hover:border-[var(--org-accent)]/30",
											)}
											style={
												item.isActive
													? {
															borderColor:
																"var(--org-accent, var(--primary))",
														}
													: undefined
											}
										>
											<item.icon
												className={`size-4 shrink-0 transition-colors ${item.isActive ? "" : "opacity-50"}`}
											/>
											<span>{item.label}</span>
										</Link>
									)}
								</li>
							))}
						</ul>
					)}

					{/* ── SIDEBAR NAV (desktop) ── */}
					{useSidebarLayout && (
						<TooltipProvider delayDuration={500}>
							<div className="no-scrollbar mt-4 hidden flex-1 flex-col gap-5 overflow-y-auto pb-4 md:flex">
								{navSections.map((section) => (
									<div key={section.label ?? "main"}>
										{/* Section header — only when expanded */}
										{section.label && showLabels && (
											<p className="mb-2 px-2.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-muted-foreground/60 select-none whitespace-nowrap overflow-hidden transition-opacity duration-200">
												{section.label}
											</p>
										)}
										{section.label && !showLabels && (
											<div className="mb-2 h-px mx-2 bg-border/40" />
										)}

										{/* Section items */}
										<ul className="flex list-none flex-col gap-0.5">
											{section.items.map((item) => (
												<li key={item.label}>
													{/* Parent nav item */}
													<SidebarNavItem
														item={item}
														collapsed={!showLabels}
													/>

													{/* Sub-items — only show when expanded */}
													{showLabels &&
														item.children &&
														item.children.length >
															0 && (
															<ul className="mt-0.5 ml-4 flex flex-col gap-0.5 border-l border-dashed border-border/40 pl-3">
																{item.children.map(
																	(child) => (
																		<li
																			key={
																				child.href
																			}
																		>
																			<SidebarNavItem
																				item={
																					child
																				}
																				isChild
																				collapsed={
																					false
																				}
																			/>
																		</li>
																	),
																)}
															</ul>
														)}
												</li>
											))}
										</ul>
									</div>
								))}
								{accountUtilities.length > 0 && (
									<ul className="flex list-none flex-col gap-0.5 border-t border-border/35 pt-3">
										{accountUtilities.map((item) => (
											<li key={item.label}>
												<AccountUtilityRow
													item={item}
													collapsed={!showLabels}
												/>
											</li>
										))}
									</ul>
								)}
							</div>
						</TooltipProvider>
					)}

					{/* Bottom: compact controls (sidebar only) */}
					<div
						className={cn("-mx-3 mt-auto mb-0 hidden", {
							"md:block": useSidebarLayout,
						})}
					>
						<SidebarControlsFooter collapsed={!showLabels} />
					</div>
				</div>
				{useSidebarLayout ? (
					<SidebarEdgeHandle
						isExpanded={showLabels}
						onClick={
							forceCollapsed
								? () => setFullscreenExpanded((v) => !v)
								: toggleCollapsed
						}
						expandLabel="Expand sidebar"
						collapseLabel="Collapse sidebar"
						style={{
							top: "calc(50% + var(--ai-banner-height, 0px) / 2)",
						}}
					/>
				) : null}
			</nav>
		</>
	);
}

// ── Sub-components ────────────────────────────────────────────────────────────

// Right-side hover tooltip for a collapsed-rail control. Wraps the control in a
// span trigger (rather than `asChild` on the control itself) so it works
// uniformly for controls that are popovers/buttons and don't forward refs.
function RailTooltip({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="inline-flex">{children}</span>
			</TooltipTrigger>
			<TooltipContent side="right">{label}</TooltipContent>
		</Tooltip>
	);
}

function SidebarControlsFooter({ collapsed }: { collapsed: boolean }) {
	const inner = (
		<div
			className={cn(
				"flex items-center",
				collapsed ? "flex-col gap-2" : "justify-between gap-2",
			)}
		>
			{/* Bell + incident indicator travel together as one cluster so
			 * the triangle stays adjacent to the bell in both the wide
			 * sidebar (left of the justify-between row) and the 72px
			 * collapsed rail (stacked under the bell). */}
			<div
				className={cn(
					"flex items-center",
					collapsed ? "flex-col gap-2" : "gap-0.5",
				)}
			>
				{collapsed ? (
					<RailTooltip label="Notifications">
						<NotificationBell variant="desktop" />
					</RailTooltip>
				) : (
					<NotificationBell variant="desktop" />
				)}
				{collapsed ? (
					<RailTooltip label="Background jobs">
						<JobHubButton variant="desktop" />
					</RailTooltip>
				) : (
					<JobHubButton variant="desktop" />
				)}
				<IncidentRailIndicator />
			</div>
			<div
				className={cn(
					"flex items-center",
					collapsed ? "flex-col gap-2" : "gap-0.5",
				)}
			>
				{collapsed ? (
					<RailTooltip label="Toggle theme">
						<ThemeToggle variant="inline" className="size-9" />
					</RailTooltip>
				) : (
					<ColorModeToggle />
				)}
			</div>
		</div>
	);

	return (
		<div className="border-t border-border/40 bg-background/45 px-3 py-3 backdrop-blur-sm">
			{/* Collapsed rail: a TooltipProvider so the bell + theme controls get
			 * the same right-side hover tooltips as the nav items above. */}
			{collapsed ? (
				<TooltipProvider delayDuration={500}>{inner}</TooltipProvider>
			) : (
				inner
			)}
		</div>
	);
}

function SidebarUtilityItem({
	href,
	icon: Icon,
	label,
	onClick,
	collapsed = false,
	destructive = false,
	onboardingId,
	adornment,
	adornmentLabel,
}: {
	href?: string;
	icon: ComponentType<{ className?: string }>;
	label: string;
	onClick?: () => void;
	collapsed?: boolean;
	destructive?: boolean;
	onboardingId?: string;
	/** Badge/marker layered over the icon (see `GetStartedPointer`). */
	adornment?: ReactNode;
	/**
	 * What the adornment means, for assistive tech. Folded into `aria-label`
	 * rather than rendered as an `sr-only` child because in the collapsed rail
	 * `aria-label` replaces the name computed from contents — a nested string
	 * would be silently dropped there.
	 */
	adornmentLabel?: string;
}) {
	const router = useRouter();
	const className = cn(
		"flex min-h-[36px] items-center rounded-lg text-sm transition-colors outline-none focus-visible:ring-1 focus-visible:ring-primary/35",
		// Collapsed: full-width + centered icon so utility items sit in the same
		// straight column as the nav items. `w-full` is required for the logout
		// <button> (an <a> stretches on its own, a <button> doesn't), otherwise
		// it renders fit-content and lands a few px left of the column center.
		collapsed
			? "w-full justify-center px-2.5 py-1.5"
			: "gap-2.5 px-2.5 py-1.5",
		destructive
			? "text-destructive hover:bg-destructive/10"
			: "text-muted-foreground/85 hover:bg-muted/55 hover:text-foreground",
	);

	const content = (
		<>
			{/* `relative` so an adornment anchors to the ICON, which keeps it
			 * correct in the expanded sidebar, the collapsed rail, and the
			 * mobile sheet alike. */}
			<span className="relative flex shrink-0">
				<Icon className="size-[19px] shrink-0" aria-hidden="true" />
				{/* Collapsed rail: a word does not fit. The button is 72px
				 * wide around a centred 19px icon and the nav container is
				 * `overflow-hidden`, so a text chip would be cut off at the
				 * rail's edge. Fall back to a dot with the same footprint as
				 * the notification counters at the foot of this rail. The
				 * meaning still reaches assistive tech via `aria-label`, which
				 * replaces the name computed from contents when collapsed. */}
				{collapsed && adornment && (
					<span
						aria-hidden="true"
						className="-right-1 -top-1 pointer-events-none absolute size-2 rounded-full bg-primary ring-2 ring-card"
					/>
				)}
			</span>
			{!collapsed && <span className="truncate">{label}</span>}
			{/* Expanded: a trailing chip. Overlaying here would land on top of
			 * the label. */}
			{!collapsed && adornment && (
				<span className="shrink-0">{adornment}</span>
			)}
			{/* Expanded / mobile: the name comes from contents, so the
			 * adornment's meaning rides along as sr-only text. Collapsed, an
			 * `aria-label` replaces contents entirely, so it is folded in
			 * there instead — see the `adornmentLabel` docblock. */}
			{!collapsed && adornmentLabel && (
				<span className="sr-only">{adornmentLabel}</span>
			)}
		</>
	);

	const element = href ? (
		<Link
			href={href}
			prefetch={false}
			onMouseEnter={() => router.prefetch(href)}
			onFocus={() => router.prefetch(href)}
			className={className}
			onClick={onClick}
			aria-label={
				collapsed
					? [label, adornmentLabel].filter(Boolean).join(". ")
					: undefined
			}
			data-onboarding-target={onboardingId}
		>
			{content}
		</Link>
	) : (
		<button
			type="button"
			onClick={onClick}
			className={className}
			aria-label={
				collapsed
					? [label, adornmentLabel].filter(Boolean).join(". ")
					: undefined
			}
			data-onboarding-target={onboardingId}
		>
			{content}
		</button>
	);

	// Collapsed rail: reveal the label on hover, matching the nav items so
	// every icon in the rail has a consistent right-side tooltip.
	if (collapsed) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>{element}</TooltipTrigger>
				<TooltipContent side="right">{label}</TooltipContent>
			</Tooltip>
		);
	}

	return element;
}

function SidebarNavItem({
	item,
	isChild = false,
	collapsed = false,
	onNavigate,
}: {
	item: NavItem | SubNavItem;
	isChild?: boolean;
	collapsed?: boolean;
	onNavigate?: () => void;
}) {
	const router = useRouter();
	const { srSuffix, truncateLabel } = item;

	if (item.disabled) {
		const content = (
			<div
				className={cn(
					"flex min-h-[36px] items-center rounded-md px-2.5 py-1.5 text-sm cursor-not-allowed select-none",
					"text-muted-foreground/35",
					collapsed ? "justify-center" : "justify-between gap-2",
					isChild && "min-h-[32px] py-1 text-xs",
				)}
				aria-disabled="true"
			>
				{collapsed ? (
					<>
						<item.icon
							className="size-[19px] shrink-0 opacity-40"
							aria-hidden="true"
						/>
						{/* Collapsed: the label is otherwise only in the pointer-only
							tooltip below, so a screen reader gets no name for this disabled
							row. An `sr-only` label supplies it. No WCAG 2.5.3 risk here —
							there is no visible text in the collapsed state for it to shadow.
							The expanded branch keeps its visible label untouched. */}
						<span className="sr-only">{item.label}</span>
					</>
				) : (
					<>
						<span className="flex items-center gap-2.5">
							<item.icon className="size-[19px] shrink-0 opacity-40" />
							<span className="truncate">{item.label}</span>
						</span>
						<span className="flex items-center gap-1 rounded-full bg-muted/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/40 shrink-0">
							<LockIcon className="size-2.5" />
							Soon
						</span>
					</>
				)}
			</div>
		);

		if (collapsed) {
			return (
				<Tooltip>
					<TooltipTrigger asChild>{content}</TooltipTrigger>
					<TooltipContent side="right">{item.label}</TooltipContent>
				</Tooltip>
			);
		}
		return content;
	}

	// Prefetch on intent (hover/focus) rather than eagerly for every link in
	// the always-visible sidebar. Eager viewport prefetch made each page load
	// (and every workspace switch) fan out a full RSC render per nav item,
	// saturating the server and starving the real data calls.
	const prefetchOnIntent = () => router.prefetch(item.href);

	const link = (
		<Link
			href={item.href}
			prefetch={false}
			onMouseEnter={prefetchOnIntent}
			onFocus={prefetchOnIntent}
			onClick={onNavigate}
			className={cn(
				"relative flex min-h-[36px] items-center rounded-lg px-2.5 py-1.5 text-sm transition-colors outline-none focus-visible:ring-1 focus-visible:ring-primary/35 focus-visible:ring-offset-0",
				collapsed ? "justify-center" : "gap-2.5",
				item.isActive
					? "font-semibold text-foreground"
					: "text-muted-foreground/85 hover:bg-muted/55 hover:text-foreground",
				isChild && "min-h-[32px] py-1 text-xs",
			)}
			style={
				item.isActive
					? {
							backgroundColor:
								"color-mix(in srgb, var(--org-accent, var(--primary)) 10%, transparent)",
							color: "var(--org-accent, var(--primary))",
						}
					: undefined
			}
			aria-label={collapsed ? item.label : undefined}
			aria-current={item.isActive ? "page" : undefined}
			data-onboarding-target={item.onboardingId}
		>
			{/* Active indicator bar */}
			{item.isActive && !collapsed && (
				<span
					className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full"
					style={{
						backgroundColor: "var(--org-accent, var(--primary))",
					}}
				/>
			)}
			<item.icon
				className={cn(
					"shrink-0 transition-colors",
					isChild ? "size-[17px]" : "size-[19px]",
					item.isActive ? "" : "opacity-60",
				)}
				aria-hidden="true"
			/>
			{!collapsed &&
				(truncateLabel ? (
					// Measures real overflow, so short names get no tooltip.
					<TruncatedText text={item.label} side="right" />
				) : (
					<span className="truncate">{item.label}</span>
				))}
			{srSuffix && <span className="sr-only">{srSuffix}</span>}
		</Link>
	);

	if (collapsed) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>{link}</TooltipTrigger>
				<TooltipContent side="right">{item.label}</TooltipContent>
			</Tooltip>
		);
	}

	return link;
}
