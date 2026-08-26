"use client";

import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { getBillingCategoryLabel } from "@shared/lib/billing-categories";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Progress } from "@ui/components/progress";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ui/components/table";
import { cn } from "@ui/lib";
import {
	BarChart3Icon,
	ChevronDownIcon,
	CreditCardIcon,
	GiftIcon,
	ShieldCheckIcon,
	SparklesIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";

type Variant = "banner" | "settings";

function formatUsd(amount: number) {
	return `$${amount.toFixed(2)}`;
}

function formatNumber(value: number) {
	return new Intl.NumberFormat("en-US").format(value);
}

function formatDateTime(value: string | Date) {
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(value));
}

function getBannerCopy(status: {
	hasPaymentMethod: boolean;
	isLimitReached: boolean;
	remainingCreditUsd: number;
	canManageBilling: boolean;
}) {
	if (status.hasPaymentMethod) {
		return {
			title: "Billing is active",
			description:
				"Your workspace has a saved payment method, so AI usage can continue beyond the included credits.",
		};
	}

	if (status.isLimitReached) {
		return {
			title: "Included AI credits used",
			description: status.canManageBilling
				? "This workspace has used the included $5 in AI credits. Add a card to keep AI features available."
				: "This workspace has used the included $5 in AI credits. Ask an organization owner or admin to add a card.",
		};
	}

	return {
		title: "Included AI credits are active",
		description: status.canManageBilling
			? `${formatUsd(status.remainingCreditUsd)} is still available before a card is required.`
			: `${formatUsd(status.remainingCreditUsd)} is still available. Ask an organization owner or admin to add a card before it runs out.`,
	};
}

function AiCreditsStatusPanel({
	organizationId,
	variant,
}: {
	/**
	 * `string` = org scope, `null`/`undefined` = personal scope.
	 * Explicit `null` lets callers that KNOW the viewer must be
	 * personal-scoped (e.g. a project guest inside a host org) state it
	 * per the multi-tenant XOR rule.
	 */
	organizationId?: string | null;
	variant: Variant;
}) {
	const [dialogOpen, setDialogOpen] = useState(false);
	const [collapsed, setCollapsed] = useState(() => {
		if (typeof window === "undefined") {
			return true;
		}
		return localStorage.getItem("ai-credits-banner-collapsed") !== "0";
	});
	const bannerRef = useRef<HTMLDivElement>(null);

	function dismiss() {
		localStorage.setItem("ai-credits-banner-collapsed", "1");
		setCollapsed(true);
	}

	function expand() {
		localStorage.setItem("ai-credits-banner-collapsed", "0");
		setCollapsed(false);
	}

	// Track banner height via CSS variable so the NavBar collapse handle can
	// stay vertically aligned with the conversations sidebar handle.
	// Runs after every render; ResizeObserver keeps it current if size changes.
	useLayoutEffect(() => {
		const el = bannerRef.current;
		if (el) {
			const update = () =>
				document.documentElement.style.setProperty(
					"--ai-banner-height",
					`${el.offsetHeight}px`,
				);
			update();
			const ro = new ResizeObserver(update);
			ro.observe(el);
			return () => {
				ro.disconnect();
				document.documentElement.style.setProperty(
					"--ai-banner-height",
					"0px",
				);
			};
		}
		document.documentElement.style.setProperty("--ai-banner-height", "0px");
	});

	const { data, isLoading } = useQuery({
		queryKey: ["aiCreditStatus", organizationId ?? null],
		queryFn: async () =>
			orpcClient.payments.getAiCreditStatus({
				organizationId: organizationId ?? null,
			}),
	});

	const usageBreakdownQuery = useQuery({
		queryKey: ["aiUsageBreakdown", organizationId ?? null],
		queryFn: async () =>
			orpcClient.payments.getAiUsageBreakdown({
				organizationId: organizationId ?? null,
				periodDays: 30,
			}),
		enabled:
			variant === "settings" &&
			(data?.canManageBilling ?? !organizationId),
	});

	const setupMutation = useMutation({
		mutationFn: async () =>
			orpcClient.payments.createPaymentMethodSetupLink({
				organizationId: organizationId ?? null,
				redirectUrl: window.location.href,
			}),
		onSuccess: ({ checkoutLink }) => {
			window.location.href = checkoutLink;
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to start card setup",
			);
		},
	});

	const portalMutation = useMutation({
		mutationFn: async () =>
			orpcClient.payments.createCustomerPortalLink({
				organizationId: organizationId ?? null,
				redirectUrl: window.location.href,
			}),
		onSuccess: ({ customerPortalLink }) => {
			window.location.href = customerPortalLink;
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to open billing portal",
			);
		},
	});

	useEffect(() => {
		if (!data || data.hasPaymentMethod || data.hasConfiguredProvider) {
			return;
		}

		if (data.isLimitReached || data.remainingCreditUsd <= 1) {
			localStorage.setItem("ai-credits-banner-collapsed", "0");
			setCollapsed(false);
		}
	}, [data]);

	if (isLoading || !data) {
		return null;
	}

	const copy = getBannerCopy(data);
	const usedPercent =
		(data.usedCreditUsd / Math.max(data.creditLimitUsd, 0.000001)) * 100;
	const showBanner = !data.hasPaymentMethod && !data.hasConfiguredProvider;
	const isCriticalBanner =
		data.isLimitReached || data.remainingCreditUsd <= 1;
	const billingBreakdown = new Map(
		usageBreakdownQuery.data?.byBillingCategory.map((item) => [
			item.label,
			item,
		]) ?? [],
	);
	const includedUsage =
		billingBreakdown.get("INCLUDED_CREDIT")?.totalCostUsd ?? 0;
	const meteredUsage =
		billingBreakdown.get("STRIPE_METERED")?.totalCostUsd ?? 0;
	const byokUsage = billingBreakdown.get("EXTERNAL_BYOK")?.totalCostUsd ?? 0;
	const platformUnbilledUsage =
		billingBreakdown.get("PLATFORM_UNBILLED")?.totalCostUsd ?? 0;

	if (variant === "banner") {
		if (!showBanner) {
			return null;
		}

		return (
			<>
				{collapsed && !isCriticalBanner ? (
					<div ref={bannerRef} className="h-0">
						<button
							type="button"
							onClick={expand}
							className="fixed z-40 flex max-w-[calc(100vw-1rem)] items-center gap-2 rounded-full border border-emerald-300/40 bg-background/90 px-3 py-2 text-left shadow-lg backdrop-blur-sm transition-colors hover:bg-background"
							style={{
								top: "calc(env(safe-area-inset-top, 0px) + 0.75rem)",
								right: "calc(env(safe-area-inset-right, 0px) + 0.75rem)",
							}}
						>
							<GiftIcon className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
							<span className="text-xs font-medium text-foreground/80">
								{formatUsd(data.remainingCreditUsd)}
							</span>
							<ChevronDownIcon className="size-3.5 text-muted-foreground" />
						</button>
					</div>
				) : (
					<div ref={bannerRef} className="px-6 pt-4">
						<div
							className={cn(
								"flex flex-col gap-3 rounded-2xl border px-4 py-3 shadow-sm md:flex-row md:items-center md:justify-between",
								isCriticalBanner
									? "border-amber-300/70 bg-[linear-gradient(90deg,rgba(251,191,36,0.18),rgba(255,255,255,0.96))] dark:bg-[linear-gradient(90deg,rgba(251,191,36,0.18),rgba(20,23,28,0.96))]"
									: "border-emerald-300/70 bg-[linear-gradient(90deg,rgba(187,247,208,0.9),rgba(255,255,255,0.96))] dark:bg-[linear-gradient(90deg,rgba(20,83,45,0.55),rgba(20,23,28,0.96))]",
							)}
						>
							<div className="flex min-w-0 items-start gap-3">
								<div className="mt-0.5 rounded-full bg-background/70 p-2 text-emerald-700 shadow-sm dark:text-emerald-300">
									<GiftIcon className="size-4" />
								</div>
								<div className="min-w-0">
									<p className="truncate font-medium text-sm text-foreground">
										{copy.title}
									</p>
									<p className="text-sm text-foreground/80">
										{copy.description}
									</p>
								</div>
							</div>
							<div className="flex items-center gap-2">
								<Badge
									variant="outline"
									className="bg-background/70"
								>
									{formatUsd(data.remainingCreditUsd)} left
								</Badge>
								{data.canManageBilling && (
									<Button
										size="sm"
										variant="light"
										onClick={() => setDialogOpen(true)}
									>
										<CreditCardIcon className="size-4" />
										Add card
									</Button>
								)}
								<Button
									size="sm"
									variant="ghost"
									className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
									aria-label="Collapse credits banner"
									onClick={() => {
										if (!isCriticalBanner) {
											dismiss();
										}
									}}
									disabled={isCriticalBanner}
								>
									<XIcon className="size-3.5" />
								</Button>
							</div>
						</div>
					</div>
				)}
				<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>
								Keep AI available for this workspace
							</DialogTitle>
							<DialogDescription>
								Add a card now so AI workflows can continue
								after the included credits are gone. Nothing
								changes about tenant isolation or model routing.
							</DialogDescription>
						</DialogHeader>
						<div className="space-y-4">
							<div className="rounded-xl border bg-muted/40 p-4">
								<div className="flex items-center justify-between gap-3">
									<div>
										<p className="font-medium text-sm">
											Included credit usage
										</p>
										<p className="text-muted-foreground text-sm">
											{formatUsd(data.usedCreditUsd)} used
											of {formatUsd(data.creditLimitUsd)}
										</p>
									</div>
									<SparklesIcon className="size-4 text-primary" />
								</div>
								<Progress
									className="mt-3 h-2"
									value={Math.min(
										100,
										Math.max(0, usedPercent),
									)}
								/>
							</div>
							<div className="rounded-xl border bg-background p-4">
								<div className="flex items-start gap-3">
									<ShieldCheckIcon className="mt-0.5 size-4 text-primary" />
									<p className="text-sm text-muted-foreground">
										Fabric uses the platform Vercel AI
										Gateway by default for this included
										usage. Adding a card only unlocks
										continued access after the free balance
										is used.
									</p>
								</div>
							</div>
						</div>
						<DialogFooter>
							<Button
								variant="outline"
								onClick={() => setDialogOpen(false)}
							>
								Not now
							</Button>
							<Button
								onClick={() => setupMutation.mutate()}
								loading={setupMutation.isPending}
							>
								<CreditCardIcon className="size-4" />
								Add card
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</>
		);
	}

	return (
		<>
			<SettingsItem
				title="AI credits"
				description="Track the included Fabric AI balance for this workspace and manage the billing method used after it runs out."
			>
				<div className="space-y-4">
					<div className="grid gap-3 md:grid-cols-3">
						<div className="rounded-xl border bg-muted/40 p-4">
							<p className="text-muted-foreground text-xs uppercase tracking-[0.14em]">
								Included balance
							</p>
							<p className="mt-2 font-semibold text-2xl">
								{formatUsd(data.remainingCreditUsd)}
							</p>
						</div>
						<div className="rounded-xl border bg-muted/40 p-4">
							<p className="text-muted-foreground text-xs uppercase tracking-[0.14em]">
								Used so far
							</p>
							<p className="mt-2 font-semibold text-2xl">
								{formatUsd(data.usedCreditUsd)}
							</p>
						</div>
						<div className="rounded-xl border bg-muted/40 p-4">
							<p className="text-muted-foreground text-xs uppercase tracking-[0.14em]">
								Billing status
							</p>
							<div className="mt-2">
								<Badge
									variant={
										data.hasPaymentMethod ||
										data.hasConfiguredProvider
											? "default"
											: "outline"
									}
								>
									{data.hasPaymentMethod
										? "Card on file"
										: data.hasConfiguredProvider
											? "Own provider configured"
											: "Card required after included credits"}
								</Badge>
							</div>
						</div>
					</div>
					<Progress
						className="h-2"
						value={Math.min(100, Math.max(0, usedPercent))}
					/>
					<div className="flex flex-wrap gap-2">
						{data.canManageBilling &&
							!data.hasPaymentMethod &&
							!data.hasConfiguredProvider && (
								<Button
									onClick={() => setDialogOpen(true)}
									loading={setupMutation.isPending}
								>
									<CreditCardIcon className="size-4" />
									Add card
								</Button>
							)}
						{data.canManageBilling && data.customerId && (
							<Button
								variant="outline"
								onClick={() => portalMutation.mutate()}
								loading={portalMutation.isPending}
							>
								Manage billing
							</Button>
						)}
					</div>
					{organizationId && !data.canManageBilling && (
						<div className="rounded-xl border bg-muted/30 p-4">
							<p className="font-medium text-sm">
								Organization usage breakdown is limited
							</p>
							<p className="mt-1 text-muted-foreground text-sm">
								Only organization owners and admins can view
								member-level AI usage and cost analytics.
							</p>
						</div>
					)}
					{usageBreakdownQuery.data && (
						<div className="space-y-4 rounded-2xl border bg-background p-4">
							<div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
								<div>
									<p className="font-medium text-sm">
										Usage breakdown
									</p>
									<p className="text-muted-foreground text-sm">
										Last{" "}
										{usageBreakdownQuery.data.periodDays}{" "}
										days for this{" "}
										{organizationId
											? "organization"
											: "personal"}{" "}
										workspace.
									</p>
								</div>
								<Badge variant="outline" className="w-fit">
									<BarChart3Icon className="mr-1 size-3" />
									Tracked by workspace
								</Badge>
							</div>
							<div className="grid gap-3 md:grid-cols-4">
								<div className="rounded-xl border bg-muted/30 p-4">
									<p className="text-muted-foreground text-xs uppercase tracking-[0.14em]">
										30-day cost
									</p>
									<p className="mt-2 font-semibold text-2xl">
										{formatUsd(
											usageBreakdownQuery.data.summary
												.currentPeriod.totalCostUsd,
										)}
									</p>
								</div>
								<div className="rounded-xl border bg-muted/30 p-4">
									<p className="text-muted-foreground text-xs uppercase tracking-[0.14em]">
										Requests
									</p>
									<p className="mt-2 font-semibold text-2xl">
										{formatNumber(
											usageBreakdownQuery.data.summary
												.currentPeriod.totalRequests,
										)}
									</p>
								</div>
								<div className="rounded-xl border bg-muted/30 p-4">
									<p className="text-muted-foreground text-xs uppercase tracking-[0.14em]">
										Input tokens
									</p>
									<p className="mt-2 font-semibold text-2xl">
										{formatNumber(
											usageBreakdownQuery.data.summary
												.currentPeriod.totalInputTokens,
										)}
									</p>
								</div>
								<div className="rounded-xl border bg-muted/30 p-4">
									<p className="text-muted-foreground text-xs uppercase tracking-[0.14em]">
										All-time tracked
									</p>
									<p className="mt-2 font-semibold text-2xl">
										{formatUsd(
											usageBreakdownQuery.data.summary
												.allTime.totalCostUsd,
										)}
									</p>
								</div>
							</div>
							<div className="grid gap-3 md:grid-cols-3">
								<div className="rounded-xl border bg-emerald-50 p-4 dark:bg-emerald-950/20">
									<p className="text-[11px] uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-300">
										Included credit usage
									</p>
									<p className="mt-2 font-semibold text-2xl">
										{formatUsd(includedUsage)}
									</p>
									<p className="mt-1 text-muted-foreground text-xs">
										Workspace usage covered by the initial
										$5 balance.
									</p>
								</div>
								<div className="rounded-xl border bg-sky-50 p-4 dark:bg-sky-950/20">
									<p className="text-[11px] uppercase tracking-[0.14em] text-sky-700 dark:text-sky-300">
										Stripe metered usage
									</p>
									<p className="mt-2 font-semibold text-2xl">
										{formatUsd(meteredUsage)}
									</p>
									<p className="mt-1 text-muted-foreground text-xs">
										Platform usage billed through Vercel AI
										Gateway and Stripe.
									</p>
								</div>
								<div className="rounded-xl border bg-amber-50 p-4 dark:bg-amber-950/20">
									<p className="text-[11px] uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
										External BYOK usage
									</p>
									<p className="mt-2 font-semibold text-2xl">
										{formatUsd(byokUsage)}
									</p>
									<p className="mt-1 text-muted-foreground text-xs">
										Usage routed through a tenant-provided
										provider or API key.
									</p>
								</div>
							</div>
							{platformUnbilledUsage > 0 && (
								<div className="rounded-xl border border-amber-300/70 bg-amber-50 p-4 dark:bg-amber-950/20">
									<p className="font-medium text-sm text-amber-900 dark:text-amber-100">
										Some platform usage is not being metered
									</p>
									<p className="mt-1 text-amber-900/80 text-sm dark:text-amber-100/80">
										{formatUsd(platformUnbilledUsage)} of
										platform usage in this period was
										allowed but not sent to Stripe metering.
										Check
										`STRIPE_AI_GATEWAY_RESTRICTED_KEY`.
									</p>
								</div>
							)}
							<div className="grid gap-4 xl:grid-cols-2">
								<div className="rounded-xl border">
									<div className="border-b px-4 py-3">
										<p className="font-medium text-sm">
											Top models
										</p>
									</div>
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>Model</TableHead>
												<TableHead>Requests</TableHead>
												<TableHead>Cost</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{usageBreakdownQuery.data.byModel
												.length > 0 ? (
												usageBreakdownQuery.data.byModel.map(
													(item) => (
														<TableRow
															key={`${item.label}-${item.value ?? "none"}`}
														>
															<TableCell>
																<div>
																	<p className="font-medium text-sm">
																		{
																			item.label
																		}
																	</p>
																	{item.value && (
																		<p className="text-muted-foreground text-xs">
																			{
																				item.value
																			}
																		</p>
																	)}
																</div>
															</TableCell>
															<TableCell>
																{formatNumber(
																	item.requests,
																)}
															</TableCell>
															<TableCell>
																{formatUsd(
																	item.totalCostUsd,
																)}
															</TableCell>
														</TableRow>
													),
												)
											) : (
												<TableRow>
													<TableCell
														colSpan={3}
														className="text-muted-foreground"
													>
														No AI usage recorded
														yet.
													</TableCell>
												</TableRow>
											)}
										</TableBody>
									</Table>
								</div>
								<div className="rounded-xl border">
									<div className="border-b px-4 py-3">
										<p className="font-medium text-sm">
											Top providers
										</p>
									</div>
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>Provider</TableHead>
												<TableHead>Requests</TableHead>
												<TableHead>Cost</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{usageBreakdownQuery.data.byProvider
												.length > 0 ? (
												usageBreakdownQuery.data.byProvider.map(
													(item) => (
														<TableRow
															key={item.label}
														>
															<TableCell className="font-medium">
																{item.label}
															</TableCell>
															<TableCell>
																{formatNumber(
																	item.requests,
																)}
															</TableCell>
															<TableCell>
																{formatUsd(
																	item.totalCostUsd,
																)}
															</TableCell>
														</TableRow>
													),
												)
											) : (
												<TableRow>
													<TableCell
														colSpan={3}
														className="text-muted-foreground"
													>
														No provider usage
														recorded yet.
													</TableCell>
												</TableRow>
											)}
										</TableBody>
									</Table>
								</div>
							</div>
							{usageBreakdownQuery.data.byTaskType.length > 0 && (
								<div className="rounded-xl border bg-muted/20 p-4">
									<p className="font-medium text-sm">
										Usage by task type
									</p>
									<div className="mt-3 flex flex-wrap gap-2">
										{usageBreakdownQuery.data.byTaskType.map(
											(item) => (
												<Badge
													key={item.label}
													variant="outline"
													className="bg-background"
												>
													{item.label}:{" "}
													{formatUsd(
														item.totalCostUsd,
													)}
												</Badge>
											),
										)}
									</div>
								</div>
							)}
							{usageBreakdownQuery.data.byBillingCategory.length >
								0 && (
								<div className="rounded-xl border bg-muted/20 p-4">
									<p className="font-medium text-sm">
										Billing categories
									</p>
									<div className="mt-3 flex flex-wrap gap-2">
										{usageBreakdownQuery.data.byBillingCategory.map(
											(item) => (
												<Badge
													key={item.label}
													variant="outline"
													className="bg-background"
												>
													{getBillingCategoryLabel(
														item.label,
													)}
													:{" "}
													{formatUsd(
														item.totalCostUsd,
													)}
												</Badge>
											),
										)}
									</div>
								</div>
							)}
							{usageBreakdownQuery.data.byUser.length > 0 && (
								<div className="rounded-xl border">
									<div className="border-b px-4 py-3">
										<p className="font-medium text-sm">
											Organization member usage
										</p>
										<p className="text-muted-foreground text-xs">
											Usage remains isolated to this
											organization. Personal activity is
											not included here.
										</p>
									</div>
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>Member</TableHead>
												<TableHead>Requests</TableHead>
												<TableHead>Tokens</TableHead>
												<TableHead>Cost</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{usageBreakdownQuery.data.byUser.map(
												(item) => (
													<TableRow key={item.userId}>
														<TableCell>
															<div>
																<p className="font-medium text-sm">
																	{item.name ??
																		item.email ??
																		item.userId}
																</p>
																{item.email && (
																	<p className="text-muted-foreground text-xs">
																		{
																			item.email
																		}
																	</p>
																)}
															</div>
														</TableCell>
														<TableCell>
															{formatNumber(
																item.requests,
															)}
														</TableCell>
														<TableCell>
															{formatNumber(
																item.totalTokens,
															)}
														</TableCell>
														<TableCell>
															{formatUsd(
																item.totalCostUsd,
															)}
														</TableCell>
													</TableRow>
												),
											)}
										</TableBody>
									</Table>
								</div>
							)}
							<div className="rounded-xl border">
								<div className="border-b px-4 py-3">
									<p className="font-medium text-sm">
										Recent usage
									</p>
								</div>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Time</TableHead>
											{organizationId && (
												<TableHead>Member</TableHead>
											)}
											<TableHead>Model</TableHead>
											<TableHead>Billing</TableHead>
											<TableHead>Task</TableHead>
											<TableHead>Cost</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{usageBreakdownQuery.data.recentUsage
											.length > 0 ? (
											usageBreakdownQuery.data.recentUsage.map(
												(item) => (
													<TableRow key={item.id}>
														<TableCell>
															{formatDateTime(
																item.createdAt,
															)}
														</TableCell>
														{organizationId && (
															<TableCell>
																<div>
																	<p className="font-medium text-sm">
																		{item.userName ??
																			item.userEmail ??
																			"Unknown member"}
																	</p>
																	{item.userEmail && (
																		<p className="text-muted-foreground text-xs">
																			{
																				item.userEmail
																			}
																		</p>
																	)}
																</div>
															</TableCell>
														)}
														<TableCell>
															<div>
																<p className="font-medium text-sm">
																	{item.modelCanonicalName ??
																		item.providerModelId}
																</p>
																<p className="text-muted-foreground text-xs">
																	{
																		item.provider
																	}
																</p>
															</div>
														</TableCell>
														<TableCell>
															{getBillingCategoryLabel(
																item.billingCategory ??
																	"UNCLASSIFIED",
															)}
														</TableCell>
														<TableCell>
															{item.taskType ??
																"Unspecified"}
														</TableCell>
														<TableCell>
															{formatUsd(
																item.costUsd,
															)}
														</TableCell>
													</TableRow>
												),
											)
										) : (
											<TableRow>
												<TableCell
													colSpan={
														organizationId ? 6 : 5
													}
													className="text-muted-foreground"
												>
													No recent AI activity has
													been tracked for this
													workspace.
												</TableCell>
											</TableRow>
										)}
									</TableBody>
								</Table>
							</div>
						</div>
					)}
				</div>
			</SettingsItem>
			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Add a billing card</DialogTitle>
						<DialogDescription>
							Add a card before the included AI balance is
							exhausted so chat, generation, and workflow features
							stay available.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setDialogOpen(false)}
						>
							Cancel
						</Button>
						<Button
							onClick={() => setupMutation.mutate()}
							loading={setupMutation.isPending}
						>
							Continue to Stripe
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

export function AiCreditsBanner({
	organizationId,
}: {
	organizationId?: string | null;
}) {
	return (
		<AiCreditsStatusPanel
			organizationId={organizationId}
			variant="banner"
		/>
	);
}

export function AiCreditsSettingsCard({
	organizationId,
}: {
	organizationId?: string | null;
}) {
	return (
		<AiCreditsStatusPanel
			organizationId={organizationId}
			variant="settings"
		/>
	);
}
