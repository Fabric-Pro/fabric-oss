"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import {
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Skeleton } from "@ui/components/skeleton";
import { ArrowUpRight, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { parseAsString, useQueryState } from "nuqs";
import { useEffect, useState } from "react";
import { ProjectPrivateDeliverySources } from "./ProjectPrivateDeliverySources";

const providers = ["SLACK", "TEAMS", "JIRA", "AZURE_DEVOPS", "FIZZY"] as const;
type Provider = (typeof providers)[number];
function cause(error: unknown) {
	if (
		!error ||
		typeof error !== "object" ||
		!("data" in error) ||
		!error.data ||
		typeof error.data !== "object"
	) {
		return undefined;
	}
	const data = error.data;
	if ("code" in data && typeof data.code === "string") {
		return data.code;
	}
	if ("errorCode" in data && typeof data.errorCode === "string") {
		return data.errorCode;
	}
	return undefined;
}
function DeliverySignalError({
	error,
	retry,
	retained = false,
}: {
	error: unknown;
	retry: () => void;
	retained?: boolean;
}) {
	const t = useTranslations("deliverySignals");
	return (
		<div
			role="alert"
			className="space-y-3 rounded-lg border border-border p-5"
		>
			<p className="text-sm">
				{t(
					retained
						? "retainedError"
						: cause(error) === "ORGANIZATION_DELETED"
							? "organizationDeleted"
							: cause(error) === "ORGANIZATION_ROUTE_UNAVAILABLE"
								? "workspaceAddressUnavailable"
								: "error",
				)}
			</p>
			{cause(error) === "ORGANIZATION_DELETED" ? (
				<Button asChild variant="outline" size="sm">
					<Link href="/app">{t("organizations")}</Link>
				</Button>
			) : (
				<Button variant="outline" size="sm" onClick={retry}>
					{t("retry")}
				</Button>
			)}
		</div>
	);
}

/** Retain only same-scope loaded rows on transient failures, never access refusals. */
function refusesHistory(error: unknown): boolean {
	if (!error || typeof error !== "object") {
		return false;
	}
	const codes = [cause(error), "code" in error ? error.code : undefined];
	return (
		codes.some((code) =>
			[
				"UNAUTHORIZED",
				"FORBIDDEN",
				"NOT_FOUND",
				"INSUFFICIENT_SCOPE",
				"INSUFFICIENT_PERMISSION",
				"ORGANIZATION_DELETED",
				"ORGANIZATION_ROUTE_UNAVAILABLE",
			].includes(code as string),
		) ||
		("status" in error && [401, 403, 404].includes(error.status as number))
	);
}

/** Only the selected, reauthorized entry lives in this drawer; closing unmounts its cache. */
function DeliverySignalDetail({
	projectId,
	id,
	identity,
	onClose,
}: {
	projectId: string;
	id: string;
	identity: readonly unknown[];
	onClose: () => void;
}) {
	const t = useTranslations("deliverySignals");
	const query = useQuery({
		queryKey: [...identity, "detail", id],
		queryFn: ({ signal }) =>
			orpcClient.projects.deliverySignals.get(
				{ projectId, id },
				{ signal },
			),
		gcTime: 0,
		staleTime: 0,
		retry: false,
	});
	return (
		<Sheet
			open
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
		>
			<SheetContent className="flex w-full flex-col gap-6 overflow-y-auto sm:max-w-lg">
				<SheetHeader className="pr-6 text-left">
					<SheetTitle>{t("detail")}</SheetTitle>
					<SheetDescription>{t("detailScope")}</SheetDescription>
				</SheetHeader>
				{query.isPending ? (
					<Skeleton
						className="h-36 w-full"
						aria-label={t("loading")}
					/>
				) : query.isError || !query.data ? (
					<DeliverySignalError
						error={query.error}
						retry={() => void query.refetch()}
					/>
				) : (
					<>
						<div className="space-y-3">
							<p className="text-sm text-muted-foreground">
								{query.data.identifier}
							</p>
							<h3 className="break-words font-semibold text-xl">
								{query.data.title}
							</h3>
						</div>
						<dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
							<dt className="text-muted-foreground">
								{t("source")}
							</dt>
							<dd>{t(`sources.${query.data.source}`)}</dd>
							<dt className="text-muted-foreground">
								{t("stage")}
							</dt>
							<dd>{t(`stages.${query.data.draftingStage}`)}</dd>
							<dt className="text-muted-foreground">
								{t("added")}
							</dt>
							<dd>
								{new Date(
									query.data.createdAt,
								).toLocaleDateString()}
							</dd>
						</dl>
						<p className="text-sm text-muted-foreground">
							{t("originNote")}
						</p>
						<Button asChild className="mt-auto">
							<Link href={query.data.href}>
								{t("openWork")}
								<ArrowUpRight
									className="ml-2 size-4"
									aria-hidden
								/>
							</Link>
						</Button>
					</>
				)}
			</SheetContent>
		</Sheet>
	);
}

export function ProjectDeliverySignals({ projectId }: { projectId: string }) {
	const t = useTranslations("deliverySignals");
	const queryClient = useQueryClient();
	const { user } = useSession();
	const { organizationId, basePath } = useOrganizationContext();
	const [sourceValue, setSource] = useQueryState(
		"deliverySource",
		parseAsString.withDefault("ALL"),
	);
	const [search, setSearch] = useQueryState(
		"deliverySearch",
		parseAsString.withDefault(""),
	);
	const [draftSearch, setDraftSearch] = useState(search);
	const [selected, setSelected] = useState<string>();
	const source = providers.includes(sourceValue as Provider)
		? (sourceValue as Provider)
		: undefined;
	const identity = [
		"delivery-signals",
		user?.id,
		organizationId,
		projectId,
		source ?? null,
		search,
	] as const;
	const query = useInfiniteQuery({
		queryKey: [...identity, "list"],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam, signal }) =>
			orpcClient.projects.deliverySignals.list(
				{ projectId, source, search, limit: 20, cursor: pageParam },
				{ signal },
			),
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		enabled: !!user?.id,
		gcTime: 0,
		staleTime: 0,
		retry: false,
	});
	const items = query.data?.pages.flatMap((page) => page.items) ?? [];
	const readableHistory =
		query.isSuccess ||
		(query.isError && items.length > 0 && !refusesHistory(query.error));
	const configuration = useQuery({
		queryKey: [
			"delivery-signals",
			user?.id,
			organizationId,
			projectId,
			"sources",
		],
		queryFn: ({ signal }) =>
			orpcClient.projects.deliverySignals.sourceConfiguration(
				{ projectId },
				{ signal },
			),
		enabled: !!user?.id && readableHistory,
		gcTime: 0,
		staleTime: 0,
		retry: false,
	});
	useEffect(() => {
		setSelected(undefined);
	}, [user?.id, organizationId, projectId, source, search]);
	useEffect(() => {
		setDraftSearch(search);
	}, [search]);
	const resetHistory = () => {
		setSelected(undefined);
		void queryClient.resetQueries({
			queryKey: [...identity, "list"],
			exact: true,
		});
	};
	return (
		<section className="space-y-5" aria-labelledby="delivery-signals-title">
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div className="max-w-prose">
					<h2
						id="delivery-signals-title"
						className="font-semibold text-xl"
					>
						{t("title")}
					</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						{t("scope")}
					</p>
				</div>
				<div className="flex items-center gap-2">
					<PageTourButton pageId="delivery" />
					<Button
						variant="ghost"
						size="icon"
						aria-label={t("refresh")}
						onClick={() => {
							setSelected(undefined);
							resetHistory();
						}}
					>
						<RefreshCw className="size-4" aria-hidden />
					</Button>
				</div>
			</header>
			<form
				data-onboarding-target="delivery-signal-filters"
				className="flex flex-col gap-3 sm:flex-row sm:items-end"
				onSubmit={(event) => {
					event.preventDefault();
					setSelected(undefined);
					void setSearch(draftSearch.trim());
				}}
			>
				<div className="flex-1 space-y-2">
					<Label htmlFor="delivery-signal-search">
						{t("search")}
					</Label>
					<Input
						id="delivery-signal-search"
						value={draftSearch}
						maxLength={120}
						onChange={(event) => setDraftSearch(event.target.value)}
						placeholder={t("searchPlaceholder")}
					/>
				</div>
				<div className="space-y-2 sm:w-52">
					<Label htmlFor="delivery-signal-provider">
						{t("source")}
					</Label>
					<Select
						value={source ?? "ALL"}
						onValueChange={(value) => {
							setSelected(undefined);
							void setSource(value);
						}}
					>
						<SelectTrigger id="delivery-signal-provider">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="ALL">
								{t("allSources")}
							</SelectItem>
							{providers.map((provider) => (
								<SelectItem key={provider} value={provider}>
									{t(`sources.${provider}`)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<Button type="submit" variant="outline">
					<Search className="mr-2 size-4" aria-hidden />
					{t("apply")}
				</Button>
				{(search || source) && (
					<Button
						type="button"
						variant="ghost"
						onClick={() => {
							setSelected(undefined);
							setDraftSearch("");
							void setSearch("");
							void setSource("ALL");
						}}
					>
						{t("clear")}
					</Button>
				)}
			</form>
			<div data-onboarding-target="delivery-signal-history">
				{query.isPending ? (
					<Skeleton
						className="h-40 w-full"
						aria-label={t("loading")}
					/>
				) : query.isError && !readableHistory ? (
					<DeliverySignalError
						error={query.error}
						retry={resetHistory}
					/>
				) : !items.length ? (
					<div className="space-y-3 rounded-lg border border-border p-6">
						<h3 className="font-medium">{t("empty")}</h3>
						<p className="max-w-prose text-sm text-muted-foreground">
							{t("emptyHint")}
						</p>
						<Button asChild variant="outline" size="sm">
							<Link
								href={`${basePath}/projects/${encodeURIComponent(projectId)}?tab=stories`}
							>
								{t("roadmap")}
							</Link>
						</Button>
					</div>
				) : (
					<ul className="divide-y divide-border rounded-lg border border-border">
						{items.map((item) => (
							<li key={item.id}>
								<button
									type="button"
									onClick={() => setSelected(item.id)}
									className="flex w-full flex-col gap-2 p-4 text-left transition-colors hover:bg-muted/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-center sm:justify-between"
								>
									<span className="min-w-0 flex-1">
										<span className="mr-2 text-xs text-muted-foreground">
											{item.identifier}
										</span>
										<span className="break-words font-medium text-sm">
											{item.title}
										</span>
									</span>
									<span className="flex shrink-0 flex-wrap items-center gap-3 text-xs text-muted-foreground">
										<Badge variant="secondary">
											{t(`sources.${item.source}`)}
										</Badge>
										<span>
											{t(`stages.${item.draftingStage}`)}
										</span>
										<time dateTime={item.createdAt}>
											{new Date(
												item.createdAt,
											).toLocaleDateString()}
										</time>
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
				{query.isError && readableHistory && (
					<div className="mt-4">
						<DeliverySignalError
							error={query.error}
							retained
							retry={() => {
								if (
									"code" in query.error &&
									query.error.code === "BAD_REQUEST"
								) {
									resetHistory();
								} else if (query.isFetchNextPageError) {
									void query.fetchNextPage();
								} else {
									void query.refetch();
								}
							}}
						/>
					</div>
				)}
				{readableHistory && !query.isError && query.hasNextPage && (
					<div className="mt-4 flex justify-center">
						<Button
							variant="outline"
							disabled={query.isFetchingNextPage}
							onClick={() => void query.fetchNextPage()}
						>
							{t(query.isFetchingNextPage ? "loading" : "more")}
						</Button>
					</div>
				)}
			</div>
			{readableHistory && configuration.isSuccess && (
				<details className="rounded-lg border border-border p-4">
					<summary className="cursor-pointer font-medium text-sm">
						{t("yourSources")}
					</summary>
					<p className="mt-3 max-w-prose text-sm text-muted-foreground">
						{t("setupScope")}
					</p>
					<ul className="mt-4 divide-y divide-border">
						{configuration.data.items.map((item) => (
							<li
								key={item.source}
								className="flex flex-wrap justify-between gap-3 py-2 text-sm"
							>
								<span>{t(`sources.${item.source}`)}</span>
								<span className="text-muted-foreground">
									{t(`setup.${item.state}`)}
								</span>
							</li>
						))}
					</ul>
					<Button asChild variant="link" className="mt-2 px-0">
						<Link href={`${basePath}/connections`}>
							{t("connections")}
						</Link>
					</Button>
				</details>
			)}
			{readableHistory && configuration.isSuccess && (
				<ProjectPrivateDeliverySources projectId={projectId} />
			)}
			{selected && readableHistory && (
				<DeliverySignalDetail
					key={JSON.stringify([...identity, selected])}
					projectId={projectId}
					id={selected}
					identity={identity}
					onClose={() => setSelected(undefined)}
				/>
			)}
		</section>
	);
}
