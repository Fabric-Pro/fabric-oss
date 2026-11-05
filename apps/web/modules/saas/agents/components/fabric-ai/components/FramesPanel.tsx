"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import {
	useEffectiveOrganizationId,
	useOrganizationSlug,
} from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	ExternalLink,
	LayoutGrid,
	Loader2,
	Presentation,
	RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";

interface FramesPanelProps {
	organizationId?: string;
	conversationId?: string | null;
}

const PAGE_SIZE = 20;

export function FramesPanel({
	organizationId,
	conversationId,
}: FramesPanelProps) {
	const { user } = useSession();
	const resolvedOrganizationId = useEffectiveOrganizationId(organizationId);
	const orgSlug = useOrganizationSlug();
	const t = useTranslations("genieFrames");
	if (!user?.id || !resolvedOrganizationId || !orgSlug) {
		return (
			<p className="p-4 text-sm text-muted-foreground">
				{t("organizationRequired")}
			</p>
		);
	}
	// Reset scope and pagination together when the current tenant or conversation changes.
	return (
		<ScopedFramesPanel
			key={JSON.stringify([
				user.id,
				resolvedOrganizationId,
				orgSlug,
				conversationId,
			])}
			userId={user.id}
			organizationId={resolvedOrganizationId}
			orgSlug={orgSlug}
			conversationId={conversationId}
		/>
	);
}

function ScopedFramesPanel({
	userId,
	organizationId,
	orgSlug,
	conversationId,
}: FramesPanelProps & {
	userId: string;
	organizationId: string;
	orgSlug: string;
}) {
	const t = useTranslations("genieFrames");
	const [scope, setScope] = useState<"conversation" | "all">(
		conversationId ? "conversation" : "all",
	);
	const [page, setPage] = useState(0);
	const {
		data: frames,
		isPending,
		isError,
		isFetching,
		refetch,
	} = useQuery({
		queryKey: [
			"frames",
			organizationId,
			userId,
			scope === "conversation" ? conversationId : null,
			page,
		],
		queryFn: () =>
			orpcClient.frames.list({
				organizationId,
				conversationId:
					scope === "conversation"
						? (conversationId ?? undefined)
						: undefined,
				limit: PAGE_SIZE + 1,
				offset: page * PAGE_SIZE,
			}),
	});
	const changeScope = (next: "conversation" | "all") => {
		setScope(next);
		setPage(0);
	};
	return (
		<section
			className="flex h-full min-h-0 flex-col"
			aria-label={t("title")}
		>
			<div className="flex items-center justify-between border-b border-border px-3 py-2">
				<h2 className="text-sm font-medium">{t("title")}</h2>
				<Button
					variant="ghost"
					size="icon-sm"
					onClick={() => refetch()}
					aria-label={t("refresh")}
					disabled={isFetching}
				>
					<RefreshCw className="h-3.5 w-3.5" aria-hidden />
				</Button>
			</div>
			<fieldset
				className="flex min-w-0 gap-1 border-b border-border p-2"
				aria-label={t("scope")}
			>
				<Button
					size="sm"
					variant={scope === "conversation" ? "secondary" : "ghost"}
					aria-pressed={scope === "conversation"}
					disabled={!conversationId}
					onClick={() => changeScope("conversation")}
				>
					{t("conversation")}
				</Button>
				<Button
					size="sm"
					variant={scope === "all" ? "secondary" : "ghost"}
					aria-pressed={scope === "all"}
					onClick={() => changeScope("all")}
				>
					{t("all")}
				</Button>
			</fieldset>
			<div
				className="min-h-0 flex-1 overflow-y-auto"
				aria-busy={isFetching}
			>
				{isPending && (
					<output className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" aria-hidden />
						{t("loading")}
					</output>
				)}
				{isError ? (
					<div className="p-4" role="alert">
						<p className="text-sm">{t("error")}</p>
						<Button
							variant="outline"
							size="sm"
							className="mt-2"
							onClick={() => refetch()}
						>
							{t("retry")}
						</Button>
					</div>
				) : !isPending && !frames?.length ? (
					<div className="px-4 py-8 text-center text-muted-foreground">
						<LayoutGrid
							className="mx-auto mb-2 h-8 w-8"
							aria-hidden
						/>
						<p className="text-sm">
							{scope === "conversation"
								? t("emptyConversation")
								: t("emptyAll")}
						</p>
						<p className="mt-1 text-xs">{t("hint")}</p>
					</div>
				) : (
					frames?.slice(0, PAGE_SIZE).map((frame) => (
						<Link
							key={frame.id}
							href={`/app/${orgSlug}/frames/${frame.id}`}
							className="flex items-center gap-3 border-b border-border px-3 py-3 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
						>
							<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
								{frame.kind === "slideshow" ? (
									<Presentation
										className="h-4 w-4 text-primary"
										aria-hidden
									/>
								) : (
									<LayoutGrid
										className="h-4 w-4 text-primary"
										aria-hidden
									/>
								)}
							</div>
							<div className="min-w-0 flex-1">
								<p className="break-words text-sm font-medium">
									{frame.title}
								</p>
								<p className="text-xs text-muted-foreground">
									{new Date(
										frame.createdAt,
									).toLocaleDateString()}
									{Boolean(conversationId) &&
										frame.conversationId ===
											conversationId && (
											<span className="ml-1">
												· {t("conversation")}
											</span>
										)}
								</p>
							</div>
							<div className="flex shrink-0 items-center gap-1">
								{frame.kind === "slideshow" && (
									<Badge variant="outline">
										{t("slides")}
									</Badge>
								)}
								{frame.isPublic && (
									<Badge variant="secondary">
										{t("shared")}
									</Badge>
								)}
								<ExternalLink
									className="h-3 w-3 text-muted-foreground"
									aria-hidden
								/>
							</div>
						</Link>
					))
				)}
			</div>
			<nav
				className="flex items-center justify-between border-t border-border p-2"
				aria-label={t("pagination")}
			>
				<Button
					variant="ghost"
					size="sm"
					disabled={page === 0 || isFetching}
					onClick={() => setPage((value) => value - 1)}
				>
					{t("previous")}
				</Button>
				<span className="text-xs text-muted-foreground">
					{t("page", { number: page + 1 })}
				</span>
				<Button
					variant="ghost"
					size="sm"
					disabled={
						isError ||
						isFetching ||
						!frames ||
						frames.length <= PAGE_SIZE
					}
					onClick={() => setPage((value) => value + 1)}
				>
					{t("next")}
				</Button>
			</nav>
		</section>
	);
}
