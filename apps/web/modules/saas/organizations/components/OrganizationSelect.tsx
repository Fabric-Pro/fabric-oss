"use client";
import { config } from "@repo/config";
import { useSession } from "@saas/auth/hooks/use-session";
import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { useIsGuestInOrg } from "@saas/organizations/hooks/use-is-guest-in-org";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useOrganizationListQuery } from "@saas/organizations/lib/api";
import { ActivePlanBadge } from "@saas/payments/components/ActivePlanBadge";
import { Spinner } from "@shared/components/Spinner";
import { UserAvatar } from "@shared/components/UserAvatar";
import { useRouter } from "@shared/hooks/router";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { ChevronsUpDownIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { OrganizationLogo } from "./OrganizationLogo";

export function OrganzationSelect({
	className,
	collapsed = false,
}: {
	className?: string;
	collapsed?: boolean;
}) {
	const t = useTranslations();
	const { user } = useSession();
	const _router = useRouter();
	const { organizationId, organizationSlug, organization } =
		useOrganizationContext();
	const { setActiveOrganization, isSwitching, switchingToSlug } =
		useActiveOrganization();
	const { data: allOrganizations } = useOrganizationListQuery();
	// Project-only guests must not see the host org's identity in the
	// switcher — present their personal account instead. The dropdown
	// below stays unchanged: it only lists real memberships.
	const isGuest = useIsGuestInOrg();
	const [mounted, setMounted] = useState(false);

	// While a switch is in flight, optimistically present the *target*
	// workspace so feedback is immediate — the active context itself only
	// updates once navigation lands.
	const pendingOrg =
		isSwitching && switchingToSlug
			? allOrganizations?.find((org) => org.slug === switchingToSlug)
			: undefined;
	const switchingToPersonal = isSwitching && switchingToSlug === null;
	// During an org switch, optimistically show the target; fall back to the
	// current org so the trigger never misleadingly flashes the personal
	// account if the target isn't in the cached membership list yet.
	const displayOrg = isSwitching
		? switchingToPersonal
			? null
			: (pendingOrg ?? organization)
		: organization;
	const showOrgPresentation = isSwitching
		? !switchingToPersonal && !!displayOrg
		: !!organization && !isGuest;

	useEffect(() => {
		setMounted(true);
	}, []);

	if (!user || !mounted) {
		if (collapsed) {
			return (
				<div className="size-9 shrink-0 animate-pulse rounded-full bg-muted" />
			);
		}
		return (
			<div className={className}>
				<div className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5">
					<div className="size-6 shrink-0 animate-pulse rounded-full bg-muted" />
					<div className="h-3.5 flex-1 animate-pulse rounded bg-muted" />
					<ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-20" />
				</div>
			</div>
		);
	}

	// Shared dropdown body — identical for the expanded and collapsed triggers.
	const menuContent = (
		<>
			{!config.organizations.requireOrganization && (
				<>
					<DropdownMenuLabel className="text-foreground/60 text-xs font-medium pb-1">
						{t("organizations.organizationSelect.personalAccount")}
					</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						value={organizationId ?? user.id}
						onValueChange={(value: string) => {
							if (value === user.id) {
								void setActiveOrganization(null);
							}
						}}
					>
						<DropdownMenuRadioItem
							value={user.id}
							disabled={isSwitching}
							className="cursor-pointer pl-2"
						>
							<div className="flex w-full items-center gap-2.5">
								<UserAvatar
									className="size-6 shrink-0"
									name={user.name ?? ""}
									avatarUrl={user.image}
								/>
								<span className="truncate text-sm">
									{user.name}
								</span>
								{switchingToPersonal && (
									<Spinner className="ml-auto size-3.5" />
								)}
							</div>
						</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
					<DropdownMenuSeparator />
				</>
			)}

			<DropdownMenuLabel className="text-foreground/60 text-xs font-medium pb-1">
				{t("organizations.organizationSelect.organizations")}
			</DropdownMenuLabel>
			<DropdownMenuRadioGroup
				value={organizationSlug ?? undefined}
				onValueChange={(newSlug: string) => {
					setActiveOrganization(newSlug);
				}}
			>
				{allOrganizations?.map((org) => (
					<DropdownMenuRadioItem
						key={org.slug}
						value={org.slug}
						disabled={isSwitching}
						className="cursor-pointer pl-2"
					>
						<div className="flex w-full items-center gap-2.5">
							<OrganizationLogo
								className="size-6 shrink-0"
								name={org.name}
								logoUrl={org.logo}
							/>
							<span className="truncate text-sm">{org.name}</span>
							{isSwitching && switchingToSlug === org.slug && (
								<Spinner className="ml-auto size-3.5" />
							)}
						</div>
					</DropdownMenuRadioItem>
				))}
			</DropdownMenuRadioGroup>

			{config.organizations.enableUsersToCreateOrganizations && (
				<>
					<DropdownMenuSeparator />
					<DropdownMenuGroup>
						<DropdownMenuItem
							asChild
							className="text-primary! cursor-pointer text-sm"
						>
							<Link href="/new-organization">
								<PlusIcon className="mr-2 size-5 rounded-md bg-primary/20 p-1" />
								{t(
									"organizations.organizationSelect.createNewOrganization",
								)}
							</Link>
						</DropdownMenuItem>
					</DropdownMenuGroup>
				</>
			)}
		</>
	);

	// Polite live region, kept outside the trigger button so screen readers
	// announce it reliably. Empty when idle.
	const switchingStatus = (
		<output className="sr-only">
			{isSwitching ? t("organizations.organizationSelect.switching") : ""}
		</output>
	);

	const triggerLabel =
		showOrgPresentation && displayOrg
			? displayOrg.name
			: t("organizations.organizationSelect.personalAccount");

	// Collapsed rail: a compact circular avatar that still opens the full
	// switcher and reveals the workspace name on hover, so a collapsed sidebar
	// never hides which workspace you're in.
	if (collapsed) {
		return (
			// delayDuration matches the nav rail's TooltipProvider (500ms) so
			// every collapsed-rail icon reveals its label on the same cadence.
			<TooltipProvider delayDuration={500}>
				<DropdownMenu modal={false}>
					<Tooltip>
						<TooltipTrigger asChild>
							<DropdownMenuTrigger
								aria-busy={isSwitching}
								aria-label={t(
									"organizations.organizationSelect.workspaceLabel",
									{ name: triggerLabel },
								)}
								className="relative flex size-9 shrink-0 items-center justify-center rounded-lg outline-none hover:bg-muted/40 transition-colors data-[state=open]:bg-muted/40 focus-visible:ring-1 focus-visible:ring-primary/35"
							>
								{showOrgPresentation && displayOrg ? (
									<OrganizationLogo
										name={displayOrg.name}
										logoUrl={displayOrg.logo}
										className="size-7 shrink-0"
									/>
								) : (
									<UserAvatar
										className="size-7 shrink-0"
										name={user.name ?? ""}
										avatarUrl={user.image}
									/>
								)}
								{isSwitching && (
									<span className="absolute inset-0 flex items-center justify-center rounded-lg bg-background/60">
										<Spinner className="size-3.5" />
									</span>
								)}
							</DropdownMenuTrigger>
						</TooltipTrigger>
						<TooltipContent side="right">
							{triggerLabel}
						</TooltipContent>
					</Tooltip>

					<DropdownMenuContent
						side="right"
						align="start"
						sideOffset={8}
						className="w-56"
					>
						{menuContent}
					</DropdownMenuContent>
				</DropdownMenu>
				{switchingStatus}
			</TooltipProvider>
		);
	}

	return (
		<div className={className}>
			<DropdownMenu modal={false}>
				<DropdownMenuTrigger
					aria-busy={isSwitching}
					className="flex w-full items-center gap-2 rounded-lg border border-border/30 px-2.5 py-2 text-left outline-none hover:bg-muted/40 transition-colors data-[state=open]:bg-muted/40 data-[state=open]:border-border/50"
				>
					{showOrgPresentation && displayOrg ? (
						<>
							<OrganizationLogo
								name={displayOrg.name}
								logoUrl={displayOrg.logo}
								className="size-6 shrink-0"
							/>
							<span className="flex-1 truncate text-sm font-medium">
								{displayOrg.name}
							</span>
							{config.organizations.enableBilling &&
								organizationId &&
								!isSwitching && (
									<ActivePlanBadge
										organizationId={organizationId}
									/>
								)}
						</>
					) : (
						<>
							<UserAvatar
								className="size-6 shrink-0"
								name={user.name ?? ""}
								avatarUrl={user.image}
							/>
							<span className="flex-1 truncate text-sm font-medium">
								{t(
									"organizations.organizationSelect.personalAccount",
								)}
							</span>
							{config.users.enableBilling && !isSwitching && (
								<ActivePlanBadge />
							)}
						</>
					)}
					{isSwitching ? (
						// Decorative spinner only; the polite status announcement
						// lives in a sibling region outside this button (below) —
						// live regions nested inside a button announce
						// unreliably across screen readers.
						<Spinner className="size-3.5 shrink-0" />
					) : (
						<ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
					)}
				</DropdownMenuTrigger>

				<DropdownMenuContent
					side="bottom"
					align="start"
					sideOffset={4}
					className="w-56"
				>
					{menuContent}
				</DropdownMenuContent>
			</DropdownMenu>
			{switchingStatus}
		</div>
	);
}
