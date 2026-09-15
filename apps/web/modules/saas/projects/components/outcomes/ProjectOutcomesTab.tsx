"use client";

import { PageTourButton } from "@saas/get-started/components/PageTourButton";
/**
 * "Outcomes" project tab (plan Slice 8). Shown only for engagement profiles
 * with `customerOutcomesSurface` (EXPLORE / DELEGATED). Publish / revoke /
 * copy-link are governance-only; the preview is exactly what the customer
 * sees via /share/outcomes/[token].
 */
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import {
	CopyIcon,
	ExternalLinkIcon,
	Globe2Icon,
	Loader2Icon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CustomerOutcomesView } from "./CustomerOutcomesView";
import { ProjectMetricsPanel } from "./ProjectMetricsPanel";

export interface ProjectOutcomesTabProps {
	projectId: string;
	organizationId?: string | null;
	canManageGovernance: boolean;
	canEdit: boolean;
}

export function ProjectOutcomesTab({
	projectId,
	organizationId,
	canManageGovernance,
	canEdit,
}: ProjectOutcomesTabProps) {
	const t = useTranslations("projects.outcomes");
	const queryClient = useQueryClient();
	const scope = { projectId, organizationId: organizationId ?? null };

	const options = orpc.projects.outcomes.get.queryOptions({ input: scope });
	const { data, isLoading } = useQuery(options);
	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: options.queryKey });

	const publishMutation = useMutation({
		mutationFn: () => orpcClient.projects.outcomes.publish(scope),
		onSuccess: () => {
			toast.success(t("publishedToast"));
			void invalidate();
		},
		onError: () => toast.error(t("error")),
	});
	const revokeMutation = useMutation({
		mutationFn: () => orpcClient.projects.outcomes.revoke(scope),
		onSuccess: () => {
			toast.success(t("revokedToast"));
			void invalidate();
		},
		onError: () => toast.error(t("error")),
	});

	const copyLink = async () => {
		if (!data?.shareUrl) {
			return;
		}
		try {
			await navigator.clipboard.writeText(data.shareUrl);
			toast.success(t("linkCopied"));
		} catch {
			toast.error(t("error"));
		}
	};

	return (
		<div className="grid gap-6">
			<section className="rounded-2xl border border-border bg-card p-5 sm:p-6">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<span className="editorial-label">{t("label")}</span>
						<h2 className="mt-2 font-serif text-2xl font-normal">
							{t("title")}
						</h2>
						<p className="mt-1 max-w-prose text-sm text-muted-foreground">
							{t("subtitle")}
						</p>
					</div>
					<div
						className="flex flex-wrap items-center gap-2"
						data-onboarding-target="outcomes-publish"
					>
						{/* Get started with this page */}
						<PageTourButton pageId="outcomes" />
						<span
							className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 py-1 text-xs"
							data-testid="outcomes-publish-state"
						>
							<Globe2Icon className="size-3.5" aria-hidden />
							{data?.published
								? t("published")
								: t("unpublished")}
						</span>
						{data?.published && data.shareUrl ? (
							<>
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={copyLink}
								>
									<CopyIcon
										className="mr-1.5 size-4"
										aria-hidden
									/>
									{t("copyLink")}
								</Button>
								<Button asChild size="sm" variant="ghost">
									<a
										href={data.shareUrl}
										target="_blank"
										rel="noreferrer noopener"
									>
										<ExternalLinkIcon
											className="mr-1.5 size-4"
											aria-hidden
										/>
										{t("open")}
									</a>
								</Button>
							</>
						) : null}
						{canManageGovernance ? (
							data?.published ? (
								<Button
									type="button"
									size="sm"
									variant="ghost"
									className="text-destructive"
									disabled={revokeMutation.isPending}
									onClick={() => revokeMutation.mutate()}
								>
									{revokeMutation.isPending ? (
										<Loader2Icon
											className="mr-1.5 size-4 motion-safe:animate-spin"
											aria-hidden
										/>
									) : (
										<XIcon
											className="mr-1.5 size-4"
											aria-hidden
										/>
									)}
									{t("revoke")}
								</Button>
							) : (
								<Button
									type="button"
									size="sm"
									disabled={
										publishMutation.isPending || isLoading
									}
									onClick={() => publishMutation.mutate()}
								>
									{publishMutation.isPending ? (
										<Loader2Icon
											className="mr-1.5 size-4 motion-safe:animate-spin"
											aria-hidden
										/>
									) : null}
									{t("publish")}
								</Button>
							)
						) : null}
					</div>
				</div>
				{!canManageGovernance ? (
					<p className="mt-3 text-xs text-muted-foreground">
						{t("governanceOnly")}
					</p>
				) : null}
			</section>

			<ProjectMetricsPanel
				projectId={projectId}
				organizationId={organizationId}
				canEdit={canEdit}
				canRotate={canManageGovernance}
			/>

			<section
				aria-label={t("preview")}
				data-onboarding-target="outcomes-preview"
				className="rounded-2xl border border-dashed border-border bg-background"
			>
				<div className="border-b border-border px-5 py-3 sm:px-6">
					<span className="editorial-label">{t("preview")}</span>
					<p className="mt-1 text-xs text-muted-foreground">
						{t("previewHint")}
					</p>
				</div>
				{isLoading || !data ? (
					<div className="grid gap-3 p-6">
						<Skeleton className="h-8 w-1/2" />
						<Skeleton className="h-24 w-full" />
						<Skeleton className="h-24 w-full" />
					</div>
				) : (
					<CustomerOutcomesView outcomes={data.preview} embedded />
				)}
			</section>
		</div>
	);
}
