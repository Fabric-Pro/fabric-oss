"use client";

import { isWorkflowLive } from "@repo/utils/workflow-status";
import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { WorkflowsIcon } from "@saas/shared/components/icons/WorkflowsIcon";
import { useSidebarCollapse } from "@saas/shared/contexts/SidebarCollapseContext";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { SearchInput } from "@ui/components/search-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { cn } from "@ui/lib";
import {
	ClockIcon,
	PanelLeftCloseIcon,
	PanelLeftOpenIcon,
	PlusIcon,
	SparklesIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { WorkflowCard } from "./WorkflowCard";
import { WorkflowEditor } from "./WorkflowEditor";
import { WorkflowStarters } from "./WorkflowStarters";

/** One navigator and one persisted editor for both workflow entry routes. */
export function WorkflowsList({ workflowId }: { workflowId?: string }) {
	const router = useRouter();
	const t = useTranslations("workflows.studio");
	const { organizationId, basePath } = useOrganizationContext();
	const { setTransientCollapsed } = useSidebarCollapse();
	const [search, setSearch] = useState("");
	const [status, setStatus] = useState("all");
	const [scheduled, setScheduled] = useState(false);
	const [navigatorOpen, setNavigatorOpen] = useState(true);
	const [dirty, setDirty] = useState(false);
	const [offset, setOffset] = useState(0);
	const startWithAi = useRef(false);
	useEffect(() => {
		setDirty(false);
	}, [workflowId, organizationId]);
	useEffect(() => {
		if (!window.matchMedia) return;
		const media = window.matchMedia("(max-width: 1279px)");
		const collapse = () => {
			if (media.matches) setNavigatorOpen(false);
		};
		collapse();
		media.addEventListener?.("change", collapse);
		return () => media.removeEventListener?.("change", collapse);
	}, [workflowId]);

	const path = `${basePath}/workflows`;
	useEffect(() => {
		// Keep navigation and the shell offset in the same state. Fullscreen
		// navigation expands as an overlay and would cover this navigator.
		setTransientCollapsed(true);
		return () => setTransientCollapsed(null);
	}, [setTransientCollapsed]);
	const { data, isLoading, error, refetch } = useQuery(
		orpc.workflows.list.queryOptions({
			enabled: Boolean(organizationId),
			input: {
				organizationId,
				limit: 50,
				offset,
				search: search || undefined,
				triggerType: scheduled ? "SCHEDULE" : undefined,
				statuses:
					status === "ACTIVE" ? ["ACTIVE", "PUBLISHED"] : undefined,
				status:
					status === "all" || status === "ACTIVE"
						? undefined
						: (status as "DRAFT" | "PAUSED" | "ARCHIVED"),
			},
		}),
	);
	const all = data?.workflows ?? [];
	const matchesStatus = (value: string, filter: string) =>
		filter === "all" ||
		(filter === "ACTIVE" ? isWorkflowLive(value) : value === filter);
	const workflows = all.filter(
		(w) =>
			matchesStatus(w.status, status) &&
			(!scheduled || w.triggerType === "SCHEDULE") &&
			w.name.toLowerCase().includes(search.toLowerCase()),
	);
	const canLeave = () =>
		!dirty || window.confirm("Discard unsaved workflow changes?");
	const create = useMutation(
		orpc.workflows.create.mutationOptions({
			onSuccess: (result) => {
				setDirty(false);
				void refetch();
				router.push(
					`${path}/${result.workflow.id}${startWithAi.current ? "?assistant=1" : ""}`,
				);
				startWithAi.current = false;
			},
			onError: () => toast.error("Failed to create workflow"),
		}),
	);
	const createWorkflow = (withAi = false) => {
		startWithAi.current = withAi;
		if (canLeave())
			create.mutate({
				name: "Untitled Workflow",
				triggerType: "MANUAL",
				organizationId,
			});
	};
	return (
		<section
			aria-label="Workflow studio"
			className="flex flex-1 min-h-0 h-full w-full overflow-hidden border-y bg-background"
		>
			<div
				className={cn(
					"flex shrink-0 flex-col border-r bg-muted/20",
					navigatorOpen ? "w-full md:w-64" : "w-11",
				)}
			>
				<div className="flex h-[52px] shrink-0 items-center justify-between gap-2 border-b px-2">
					{navigatorOpen && (
						<h1 className="flex items-center gap-2 px-1 text-sm font-semibold">
							<WorkflowsIcon className="size-4" />
							Workflows <PageTourButton pageId="workflows" />
						</h1>
					)}
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={
							navigatorOpen
								? "Hide workflow navigator"
								: "Show workflow navigator"
						}
						onClick={() => setNavigatorOpen(!navigatorOpen)}
					>
						{navigatorOpen ? (
							<PanelLeftCloseIcon className="size-4" />
						) : (
							<PanelLeftOpenIcon className="size-4" />
						)}
					</Button>
				</div>
				{navigatorOpen && (
					<>
						<div className="space-y-3 border-b p-3">
							<Button
								className="w-full"
								size="sm"
								data-onboarding-target="workflows-new"
								disabled={create.isPending || !organizationId}
								onClick={() => createWorkflow()}
							>
								<PlusIcon className="size-4" />
								{create.isPending
									? "Creating…"
									: "New workflow"}
							</Button>
							<div data-onboarding-target="workflows-search">
								<SearchInput
									aria-label="Search workflows"
									placeholder="Search workflows"
									value={search}
									onChange={(e) => {
										setSearch(e.target.value);
										setOffset(0);
									}}
								/>
							</div>
							<div
								className="flex items-center gap-2"
								data-onboarding-target="workflows-status-filter"
							>
								<Select
									value={status}
									onValueChange={(value) => {
										setStatus(value);
										setOffset(0);
									}}
								>
									<SelectTrigger
										aria-label={t("statusLabel")}
										className="h-8 min-w-0 flex-1 px-2 text-xs md:text-xs"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{[
											["all", t("allStatuses")],
											["ACTIVE", t("filterActive")],
											["DRAFT", t("filterDraft")],
											["PAUSED", t("filterPaused")],
											["ARCHIVED", t("filterArchived")],
										].map(([value, label]) => (
											<SelectItem
												key={value}
												value={value}
											>
												{label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Button
									type="button"
									variant={
										scheduled ? "secondary" : "outline"
									}
									size="sm"
									aria-pressed={scheduled}
									onClick={() => {
										setScheduled(!scheduled);
										setOffset(0);
									}}
									className="h-8 shrink-0 gap-1.5 px-2 text-xs"
								>
									<ClockIcon className="size-3.5" />
									{t("filterScheduled")}
								</Button>
							</div>
						</div>
						<nav
							aria-label="Saved workflows"
							className="min-h-0 flex-1 overflow-y-auto p-2"
						>
							{isLoading ? (
								<Spinner className="mx-auto my-6" />
							) : error ? (
								<div
									role="alert"
									className="space-y-2 p-2 text-sm"
								>
									<p>Could not load workflows.</p>
									<Button
										variant="outline"
										size="sm"
										onClick={() => refetch()}
									>
										Try again
									</Button>
								</div>
							) : workflows.length === 0 ? (
								<p className="p-2 text-xs text-muted-foreground">
									{search || status !== "all" || scheduled
										? "No workflows found matching your filters"
										: "Your saved workflows will appear here."}
								</p>
							) : (
								workflows.map((w) => (
									<WorkflowCard
										key={w.id}
										workflow={w}
										variant="navigator"
										selected={workflowId === w.id}
										onBeforeAction={canLeave}
										onRefresh={() => {
											void refetch();
										}}
									/>
								))
							)}
						</nav>
						{(data?.hasMore || offset > 0) && (
							<div
								aria-label="Workflow pages"
								className="flex items-center justify-between border-t p-2"
							>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									disabled={offset === 0 || isLoading}
									onClick={() =>
										setOffset(Math.max(0, offset - 50))
									}
								>
									Previous
								</Button>
								<span className="text-xs text-muted-foreground">
									Page {Math.floor(offset / 50) + 1}
								</span>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									disabled={!data?.hasMore || isLoading}
									onClick={() =>
										setOffset(
											data?.nextOffset ?? offset + 50,
										)
									}
								>
									Next
								</Button>
							</div>
						)}
						<Link
							href={`${basePath}/settings/integrations/actions`}
							onClick={(e) => {
								if (!canLeave()) e.preventDefault();
							}}
							className="border-t p-3 text-xs text-muted-foreground hover:text-foreground"
						>
							Manage connections ↗
						</Link>
					</>
				)}
			</div>
			<div
				className={cn(
					"min-w-0 flex-1 flex-col",
					navigatorOpen ? "hidden md:flex" : "flex",
				)}
			>
				{workflowId ? (
					<WorkflowEditor
						key={`${organizationId}:${workflowId}`}
						workflowId={workflowId}
						onDirtyChange={setDirty}
					/>
				) : (
					<div className="flex flex-1 items-start justify-center overflow-y-auto p-8">
						<div className="my-auto w-full max-w-xl space-y-6">
							<WorkflowsIcon className="size-9 text-muted-foreground" />
							<div className="space-y-2">
								<h2 className="text-2xl font-semibold tracking-tight">
									{t("welcomeTitle")}
								</h2>
								<p className="text-sm leading-6 text-muted-foreground">
									{t("welcomeBody")}
								</p>
							</div>
							<div className="flex flex-wrap gap-3">
								<Button
									disabled={
										create.isPending || !organizationId
									}
									onClick={() => createWorkflow(true)}
								>
									<SparklesIcon
										className="mr-2 size-4"
										aria-hidden="true"
									/>
									{t("buildWithAi")}
								</Button>
								<Button
									variant="outline"
									disabled={
										create.isPending || !organizationId
									}
									onClick={() => createWorkflow()}
								>
									<PlusIcon
										className="mr-2 size-4"
										aria-hidden="true"
									/>
									{t("startFromScratch")}
								</Button>
							</div>
							<p className="text-sm text-muted-foreground">
								{t("reviewDraft")}
							</p>
							{organizationId && (
								<WorkflowStarters
									organizationId={organizationId}
									onCreated={(id) => {
										void refetch();
										router.push(`${path}/${id}`);
									}}
								/>
							)}
							<div className="space-y-3 border-t pt-6">
								<h3 className="text-sm font-medium">
									{t("ideasTitle")}
								</h3>
								<ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
									<li>{t("ideaBrief")}</li>
									<li>{t("ideaEvent")}</li>
									<li>{t("ideaRouting")}</li>
								</ul>
							</div>
						</div>
					</div>
				)}
			</div>
		</section>
	);
}
