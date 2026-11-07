"use client";

import type {
	DeliveryFlowStage,
	DeliveryInsightsRange,
	DeliveryInsightsResult,
	MyWorkDeliveryStage,
	MyWorkResult,
} from "@repo/database";
import { config } from "@repo/config";
import { useSession } from "@saas/auth/hooks/use-session";
import { ProjectInviteWelcomeWidget } from "@saas/dashboard/components/ProjectInviteWelcomeWidget";
import {
	ONBOARDING_STATE_QUERY_KEY,
	useOnboardingState,
} from "@saas/get-started/lib/use-onboarding-state";
import { useNotifications } from "@saas/notifications/hooks/use-notifications";
import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { PendingInvitationsBanner } from "@saas/shared/components/PendingInvitationsBanner";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { ContinuePanel } from "./ContinuePanel";
import { CuratedForYou } from "./CuratedForYou";
import { DashboardHero } from "./DashboardHero";
import { DeliveryPulse } from "./DeliveryPulse";
import { HomeEmptyState } from "./HomeEmptyState";
import { MyFeaturesPanel } from "./MyFeaturesPanel";
import { NeedsYouPanel } from "./NeedsYouPanel";
import { ProjectActivityPanel } from "./ProjectActivityPanel";
import { WorkspaceHealthPanel } from "./WorkspaceHealthPanel";
import {
	buildNeedsYou,
	buildProjectActivity,
	healthNotifications,
} from "../lib/home-model";
import {
	buildCuratedCards,
	type CuratedFeedbackAction,
} from "../lib/curated-model";

interface OrganizationDashboardProps {
	organizationId: string;
	organizationName: string;
	organizationSlug: string;
	brandColor?: string;
}

export function OrganizationDashboard({
	organizationId,
	organizationName,
	organizationSlug,
}: OrganizationDashboardProps) {
	const { user } = useSession();
	const { isOrganizationAdmin } = useActiveOrganization();
	const todoListEnabled = useFeatureFlag("TODO_LIST");
	const basePath = `/app/${organizationSlug}`;
	const [featureStage, setFeatureStage] = useState<
		"all" | MyWorkDeliveryStage
	>("all");
	const [deliveryRange, setDeliveryRange] =
		useState<DeliveryInsightsRange>(30);
	const queryClient = useQueryClient();
	const { data: onboardingData } = useOnboardingState();
	const dismissOnboardingMutation = useMutation({
		mutationFn: () =>
			orpcClient.users.onboarding.update({ action: { type: "dismiss" } }),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ONBOARDING_STATE_QUERY_KEY,
			});
			document.getElementById("organization-dashboard-title")?.focus();
		},
		onError: () => {
			toast.error("Could not save your setup preference");
		},
	});
	const workQuery = useQuery<MyWorkResult>({
		queryKey: ["dashboard", "myWork", organizationId, featureStage],
		queryFn: async () =>
			(await orpcClient.dashboard.myWork({
				organizationId,
				organizationSlug,
				limit: 8,
				featureStage,
			})) as MyWorkResult,
		refetchInterval: 5 * 60_000,
	});
	const deliveryInsightsQuery = useQuery<DeliveryInsightsResult>({
		queryKey: [
			"dashboard",
			"deliveryInsights",
			organizationId,
			deliveryRange,
		],
		queryFn: async () =>
			(await orpcClient.dashboard.deliveryInsights({
				organizationId,
				days: deliveryRange,
			})) as DeliveryInsightsResult,
		refetchInterval: 5 * 60_000,
	});
	const notificationsQuery = useNotifications({
		limit: 30,
		status: "unread",
	});
	const activityNotificationsQuery = useNotifications({
		limit: 30,
		status: "all",
	});
	const shortcutsQuery = useQuery(
		orpc.projects.shortcuts.queryOptions({
			input: { organizationId },
		}),
	);
	const conversationsQuery = useQuery(
		orpc.agents.conversations.list.queryOptions({
			input: { organizationId, scope: "mine", limit: 3 },
		}),
	);
	const todosQuery = useQuery({
		...orpc.todos.list.queryOptions({
			input: {
				organizationId,
				assigneeUserId: user?.id,
				view: "default",
				limit: 10,
			},
		}),
		enabled: todoListEnabled && Boolean(user?.id),
	});
	const curatedFeedbackQuery = useQuery({
		queryKey: ["dashboard", "curatedFeedback", organizationId],
		queryFn: async () =>
			orpcClient.dashboard.curatedFeedback.list({ organizationId }),
		refetchInterval: 5 * 60_000,
	});
	const curatedFeedbackMutation = useMutation({
		mutationFn: async ({
			cardKey,
			action,
		}: {
			cardKey: string;
			action: CuratedFeedbackAction;
		}) =>
			orpcClient.dashboard.curatedFeedback.record({
				organizationId,
				cardKey,
				action,
			}),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ["dashboard", "curatedFeedback", organizationId],
			});
		},
		onError: () => {
			toast.error("Could not save your recommendation preference");
		},
	});

	const notifications = useMemo(
		() =>
			notificationsQuery.data?.pages.flatMap((page) => page.items) ?? [],
		[notificationsQuery.data],
	);
	const activityNotifications = useMemo(
		() =>
			activityNotificationsQuery.data?.pages.flatMap(
				(page) => page.items,
			) ?? [],
		[activityNotificationsQuery.data],
	);
	const work = workQuery.data;
	const needsYou = useMemo(
		() =>
			buildNeedsYou({
				work,
				notifications,
				todos: todosQuery.data?.items ?? [],
				basePath,
				includeTodos: todoListEnabled,
			}),
		[work, notifications, todosQuery.data, basePath, todoListEnabled],
	);
	const hiddenWorkItems =
		Math.max(
			0,
			(work?.blocked.total ?? 0) - (work?.blocked.items.length ?? 0),
		) +
		Math.max(
			0,
			(work?.needsReview.total ?? 0) -
				(work?.needsReview.items.length ?? 0),
		);
	const activity = useMemo(
		() =>
			!work
				? []
				: buildProjectActivity({
						notifications: activityNotifications,
						visits: work.projectVisits,
						basePath,
					}),
		[activityNotifications, work, basePath],
	);
	const health = useMemo(
		() => healthNotifications(notifications, user?.role === "admin"),
		[notifications, user?.role],
	);
	const curatedCards = useMemo(
		() =>
			buildCuratedCards({
				needsYou: needsYou.items,
				projects: shortcutsQuery.data?.shortcuts ?? [],
				basePath,
				isOrganizationAdmin,
				feedback: curatedFeedbackQuery.data?.preferences ?? [],
			}),
		[
			needsYou.items,
			shortcutsQuery.data,
			basePath,
			isOrganizationAdmin,
			curatedFeedbackQuery.data,
		],
	);
	const hasMore =
		needsYou.hasMore ||
		hiddenWorkItems > 0 ||
		Boolean(notificationsQuery.data?.pages.at(-1)?.nextCursor) ||
		Boolean(todosQuery.data?.hasMore);
	const loading =
		workQuery.isLoading ||
		notificationsQuery.isLoading ||
		activityNotificationsQuery.isLoading ||
		shortcutsQuery.isLoading ||
		conversationsQuery.isLoading ||
		(todoListEnabled && todosQuery.isLoading);
	const hasError =
		workQuery.isError ||
		notificationsQuery.isError ||
		activityNotificationsQuery.isError ||
		shortcutsQuery.isError ||
		conversationsQuery.isError ||
		(todoListEnabled && todosQuery.isError);
	const showUpNext = !loading && needsYou.total + hiddenWorkItems < 3;
	const upNextCards = showUpNext ? curatedCards.slice(0, 2) : [];
	const remainingCuratedCards = showUpNext
		? curatedCards.slice(upNextCards.length)
		: curatedCards;

	const handleRefresh = useCallback(async () => {
		await Promise.all([
			workQuery.refetch(),
			deliveryInsightsQuery.refetch(),
			notificationsQuery.refetch(),
			activityNotificationsQuery.refetch(),
			shortcutsQuery.refetch(),
			conversationsQuery.refetch(),
			curatedFeedbackQuery.refetch(),
			...(todoListEnabled ? [todosQuery.refetch()] : []),
		]);
	}, [
		workQuery.refetch,
		deliveryInsightsQuery.refetch,
		notificationsQuery.refetch,
		activityNotificationsQuery.refetch,
		shortcutsQuery.refetch,
		conversationsQuery.refetch,
		curatedFeedbackQuery.refetch,
		todosQuery.refetch,
		todoListEnabled,
	]);
	const refreshing =
		workQuery.isRefetching ||
		deliveryInsightsQuery.isRefetching ||
		notificationsQuery.isRefetching ||
		activityNotificationsQuery.isRefetching ||
		shortcutsQuery.isRefetching ||
		conversationsQuery.isRefetching ||
		todosQuery.isRefetching;
	const handleDeliveryStage = useCallback((stage: DeliveryFlowStage) => {
		setFeatureStage(stage);
		document
			.getElementById("my-features")
			?.scrollIntoView({ block: "start" });
		document.getElementById("my-features-title")?.focus({
			preventScroll: true,
		});
	}, []);
	const handleCuratedFeedback = useCallback(
		(cardKey: string, action: CuratedFeedbackAction) => {
			curatedFeedbackMutation.mutate({ cardKey, action });
		},
		[curatedFeedbackMutation.mutate],
	);
	const hasNoDeliveryWork =
		needsYou.total + hiddenWorkItems === 0 &&
		(work?.assignedFeatures.total ?? 0) === 0 &&
		activity.length === 0;
	const needsOnboardingGuidance = onboardingData
		? onboardingData.state.status !== "completed" &&
			onboardingData.state.status !== "dismissed"
		: false;
	const showNewUserState =
		!loading &&
		hasNoDeliveryWork &&
		(work?.projectCount === 0 || needsOnboardingGuidance);
	const continuePanel = (
		<ContinuePanel
			shortcuts={shortcutsQuery.data?.shortcuts ?? []}
			conversations={conversationsQuery.data?.conversations ?? []}
			loading={loading}
			basePath={basePath}
		/>
	);

	return (
		<div className="space-y-6">
			{config.dashboard.inviteWelcomeWidget.enabled ? (
				<ProjectInviteWelcomeWidget
					organizationId={organizationId}
					organizationSlug={organizationSlug}
				/>
			) : (
				<PendingInvitationsBanner />
			)}
			<DashboardHero
				organizationName={organizationName}
				organizationSlug={organizationSlug}
				isOrganizationAdmin={isOrganizationAdmin}
				onRefresh={() => void handleRefresh()}
				refreshing={refreshing}
			/>
			{hasError ? (
				<div
					role="alert"
					className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3"
				>
					<div>
						<p className="text-sm font-medium">
							Some dashboard data could not load
						</p>
						<p className="text-xs text-muted-foreground">
							Available sections remain visible. Retry to refresh
							every source.
						</p>
					</div>
					<Button
						variant="outline"
						size="sm"
						onClick={() => void handleRefresh()}
					>
						Retry
					</Button>
				</div>
			) : null}
			<WorkspaceHealthPanel
				items={health}
				basePath={basePath}
				isOrganizationAdmin={isOrganizationAdmin}
			/>
			{showNewUserState ? (
				<div className="space-y-4">
					{work?.projectCount ? continuePanel : null}
					<HomeEmptyState
						basePath={basePath}
						organizationId={organizationId}
						projects={shortcutsQuery.data?.shortcuts ?? []}
						projectCount={work?.projectCount ?? 0}
						project={shortcutsQuery.data?.shortcuts[0]}
						onDismiss={() => dismissOnboardingMutation.mutate()}
						dismissing={dismissOnboardingMutation.isPending}
					/>
				</div>
			) : (
				<>
					<div className="grid gap-4 lg:grid-cols-5 lg:items-start">
						<div className="min-w-0 lg:col-span-3">
							<NeedsYouPanel
								items={needsYou.items}
								total={needsYou.total + hiddenWorkItems}
								hasMore={hasMore}
								loading={loading}
								basePath={basePath}
								suggestions={upNextCards}
								onFeedback={handleCuratedFeedback}
							/>
						</div>
						<div className="min-w-0 lg:col-span-2">
							{continuePanel}
						</div>
					</div>
					<DeliveryPulse
						data={deliveryInsightsQuery.data}
						loading={deliveryInsightsQuery.isLoading}
						error={deliveryInsightsQuery.isError}
						range={deliveryRange}
						onRangeChange={setDeliveryRange}
						onStageChange={handleDeliveryStage}
						onRetry={() => void deliveryInsightsQuery.refetch()}
					/>
					<CuratedForYou
						cards={remainingCuratedCards}
						onFeedback={handleCuratedFeedback}
					/>
					<div id="my-features" className="min-w-0 scroll-mt-4">
						<MyFeaturesPanel
							features={work?.assignedFeatures}
							loading={workQuery.isLoading}
							basePath={basePath}
							stage={featureStage}
							onStageChange={setFeatureStage}
						/>
					</div>
					<ProjectActivityPanel
						activity={activity}
						loading={
							activityNotificationsQuery.isLoading ||
							workQuery.isLoading
						}
					/>
				</>
			)}
		</div>
	);
}
