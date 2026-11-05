"use client";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ui/components/dialog";
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
	FileTextIcon,
	Link2Icon,
	Loader2Icon,
	RefreshCwIcon,
	UnlinkIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

type Row = Awaited<
	ReturnType<typeof orpcClient.projects.contexts.workspaceDocuments.list>
>["links"][number];
type Props = {
	projectId: string;
	organizationId: string | null;
	organizationSlug?: string | null;
};
const key = (projectId: string, organizationId: string) => [
	"project-workspace-documents",
	organizationId,
	projectId,
];
export function ProjectWorkspaceDocuments(props: Props) {
	return props.organizationId ? (
		<ProjectDocuments
			key={JSON.stringify([props.projectId, props.organizationId])}
			{...props}
			organizationId={props.organizationId}
		/>
	) : null;
}
function ProjectDocuments({
	projectId,
	organizationId,
	organizationSlug,
}: Props & { organizationId: string }) {
	const t = useTranslations("projects.contexts.workspaceLinks");
	const queryClient = useQueryClient();
	const [offset, setOffset] = useState(0);
	const [picker, setPicker] = useState(false);
	const [removing, setRemoving] = useState<string | null>(null);
	const [removeError, setRemoveError] = useState(false);
	const mounted = useRef(true);
	const removingRef = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const query = useQuery({
		queryKey: [...key(projectId, organizationId), offset],
		queryFn: () =>
			orpcClient.projects.contexts.workspaceDocuments.list({
				projectId,
				organizationId,
				limit: 20,
				offset,
			}),
		retry: false,
	});
	const refresh = () =>
		queryClient.invalidateQueries({
			queryKey: key(projectId, organizationId),
		});
	async function remove(row: Row) {
		if (removingRef.current) {
			return;
		}
		removingRef.current = true;
		setRemoving(row.id);
		setRemoveError(false);
		try {
			await orpcClient.projects.contexts.workspaceDocuments.remove({
				projectId,
				organizationId,
				linkId: row.id,
			});
			if (mounted.current) {
				toast.success(t("removed"));
				await refresh();
			}
		} catch {
			if (mounted.current) {
				setRemoveError(true);
			}
		} finally {
			removingRef.current = false;
			if (mounted.current) {
				setRemoving(null);
			}
		}
	}
	const links = query.isError ? [] : (query.data?.links ?? []);
	return (
		<section
			className="space-y-3 rounded-lg border border-border bg-card p-4"
			aria-label={t("title")}
			data-onboarding-target="context-workspace-documents"
		>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h3 className="text-sm font-semibold">{t("title")}</h3>
					<p className="mt-1 max-w-prose text-sm text-muted-foreground">
						{t("description")}
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Button
						size="sm"
						variant="ghost"
						aria-label={t("refresh")}
						disabled={query.isFetching}
						onClick={() => void refresh()}
					>
						<RefreshCwIcon className="size-4" aria-hidden="true" />
					</Button>
					<Dialog open={picker} onOpenChange={setPicker}>
						<DialogTrigger asChild>
							<Button
								size="sm"
								variant="outline"
								disabled={
									!query.data?.permissions?.canAdd ||
									query.isError
								}
							>
								<Link2Icon
									className="mr-2 size-4"
									aria-hidden="true"
								/>
								{t("add")}
							</Button>
						</DialogTrigger>
						{picker && (
							<WorkspaceDocumentPicker
								projectId={projectId}
								organizationId={organizationId}
								existingIds={links.flatMap((link) =>
									link.documentId ? [link.documentId] : [],
								)}
								onComplete={() => {
									setPicker(false);
									void refresh();
								}}
								onAdded={() => void refresh()}
							/>
						)}
					</Dialog>
				</div>
			</div>
			{!query.isPending &&
				!query.isError &&
				!query.data?.permissions?.canAdd && (
					<p className="text-xs text-muted-foreground">
						{t("editPermissionHint")}
					</p>
				)}
			{query.isPending ? (
				<output className="block text-sm text-muted-foreground">
					{t("loading")}
				</output>
			) : query.isError ? (
				<Alert variant="error">
					<AlertDescription>{t("loadError")}</AlertDescription>
				</Alert>
			) : links.length === 0 ? (
				<p className="py-2 text-sm text-muted-foreground">
					{t("empty")}
				</p>
			) : (
				<ul className="divide-y divide-border">
					{links.map((row) => (
						<li key={row.id} className="py-3">
							<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
								<div className="flex min-w-0 flex-1 items-start gap-3">
									<FileTextIcon
										className="mt-1 size-4 shrink-0 text-muted-foreground"
										aria-hidden="true"
									/>
									<div className="min-w-0">
										<p className="break-words text-sm font-medium">
											{row.filename ??
												t("unavailableTitle")}
										</p>
										{row.workspaceName && (
											<p className="mt-1 break-words text-xs text-muted-foreground">
												{row.workspaceName}
											</p>
										)}
										<Badge
											variant="outline"
											className="mt-2"
										>
											{t(`status.${row.availability}`)}
										</Badge>
									</div>
								</div>
								<div className="flex shrink-0 flex-wrap items-center gap-1 pl-7 sm:pl-0">
									{(row.availability === "CURRENT" ||
										row.availability === "UPDATED") && (
										<LinkedDocumentPreview
											key={`${row.id}:${row.sourceRevision}`}
											row={row}
											projectId={projectId}
											organizationId={organizationId}
											onRefused={() => void refresh()}
										/>
									)}{" "}
									{row.workspaceId && organizationSlug && (
										<Button
											variant="ghost"
											size="sm"
											asChild
										>
											<Link
												href={`/app/${encodeURIComponent(organizationSlug)}/workspaces/${encodeURIComponent(row.workspaceId)}`}
											>
												{t("openOriginal")}
											</Link>
										</Button>
									)}
									{query.data?.permissions?.canRemove && (
										<Button
											variant="ghost"
											size="sm"
											disabled={removing !== null}
											aria-label={t("removeNamed", {
												name:
													row.filename ??
													t("unavailableTitle"),
											})}
											onClick={() => void remove(row)}
										>
											{removing === row.id ? (
												<Loader2Icon
													className="size-4 motion-safe:animate-spin"
													aria-hidden="true"
												/>
											) : (
												<UnlinkIcon
													className="size-4"
													aria-hidden="true"
												/>
											)}
										</Button>
									)}
								</div>
							</div>
							{row.availability === "UNAVAILABLE" && (
								<p className="mt-2 text-sm text-muted-foreground">
									{t("unavailableHint")}
								</p>
							)}
						</li>
					))}
				</ul>
			)}
			{links.length > 0 && (
				<p className="text-xs text-muted-foreground">
					{t("agentHint")}
				</p>
			)}
			{removeError && (
				<Alert variant="error">
					<AlertDescription>{t("removeError")}</AlertDescription>
				</Alert>
			)}
			{(offset > 0 || query.data?.hasMore) && (
				<div className="flex gap-2">
					<Button
						variant="ghost"
						size="sm"
						disabled={offset === 0 || query.isFetching}
						onClick={() =>
							setOffset((value) => Math.max(0, value - 20))
						}
					>
						{t("previous")}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						disabled={!query.data?.hasMore || query.isFetching}
						onClick={() => setOffset((value) => value + 20)}
					>
						{t("next")}
					</Button>
				</div>
			)}
		</section>
	);
}
function LinkedDocumentPreview({
	row,
	projectId,
	organizationId,
	onRefused,
}: {
	row: Row;
	projectId: string;
	organizationId: string;
	onRefused: () => void;
}) {
	const t = useTranslations("projects.contexts.workspaceLinks");
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [truncated, setTruncated] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	const epoch = useRef(0);
	useEffect(
		() => () => {
			epoch.current++;
		},
		[],
	);
	async function change(next: boolean) {
		setOpen(next);
		const request = ++epoch.current;
		setText("");
		setError(false);
		if (!next) {
			setBusy(false);
			return;
		}
		setBusy(true);
		try {
			const page =
				await orpcClient.projects.contexts.workspaceDocuments.read({
					projectId,
					organizationId,
					linkId: row.id,
					expectedRevision: row.sourceRevision,
					limit: 4000,
					offset: 0,
				});
			if (request === epoch.current) {
				setText(page.text);
				setTruncated(page.truncated);
			}
		} catch {
			if (request === epoch.current) {
				setError(true);
				onRefused();
			}
		} finally {
			if (request === epoch.current) {
				setBusy(false);
			}
		}
	}
	return (
		<Dialog open={open} onOpenChange={(next) => void change(next)}>
			<DialogTrigger asChild>
				<Button size="sm" variant="ghost">
					{t("preview")}
				</Button>
			</DialogTrigger>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>{row.filename ?? t("title")}</DialogTitle>
					<DialogDescription>{t("previewHint")}</DialogDescription>
				</DialogHeader>
				{busy ? (
					<output className="block">{t("loading")}</output>
				) : error ? (
					<Alert variant="error">
						<AlertDescription>{t("previewError")}</AlertDescription>
					</Alert>
				) : (
					<>
						<pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-sans text-sm">
							{text}
						</pre>
						{truncated && (
							<p className="text-sm text-muted-foreground">
								{t("truncated")}
							</p>
						)}
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
function WorkspaceDocumentPicker({
	projectId,
	organizationId,
	existingIds,
	onComplete,
	onAdded,
}: {
	projectId: string;
	organizationId: string;
	existingIds: string[];
	onComplete: () => void;
	onAdded: () => void;
}) {
	const t = useTranslations("projects.contexts.workspaceLinks");
	const id = useId();
	const [workspaceId, setWorkspace] = useState("");
	const [workspaceSearch, setWorkspaceSearch] = useState("");
	const [search, setSearch] = useState("");
	const [workspaceOffset, setWorkspaceOffset] = useState(0);
	const [offset, setOffset] = useState(0);
	const [selected, setSelected] = useState<
		{ workspaceId: string; documentId: string; filename: string }[]
	>([]);
	const [adding, setAdding] = useState(false);
	const [failed, setFailed] = useState<string[]>([]);
	const [progress, setProgress] = useState(0);
	const pending = useRef(false);
	const epoch = useRef(0);
	useEffect(
		() => () => {
			epoch.current++;
		},
		[],
	);
	const workspaces = useQuery({
		queryKey: [
			"workspace-link-picker",
			organizationId,
			workspaceSearch,
			workspaceOffset,
		],
		queryFn: () =>
			orpcClient.documentWorkspaces.list({
				organizationId,
				status: "ACTIVE",
				search: workspaceSearch || undefined,
				limit: 20,
				offset: workspaceOffset,
			}),
		retry: false,
	});
	const documents = useQuery({
		queryKey: [
			"workspace-link-documents",
			organizationId,
			workspaceId,
			search,
			offset,
		],
		queryFn: () =>
			orpcClient.documentWorkspaces.documents.list({
				organizationId,
				workspaceId,
				status: "READY",
				search: search || undefined,
				limit: 20,
				offset,
			}),
		enabled: !!workspaceId,
		retry: false,
	});
	function toggle(doc: { id: string; filename: string }) {
		setFailed([]);
		setSelected((previous) =>
			previous.some((item) => item.documentId === doc.id)
				? previous.filter((item) => item.documentId !== doc.id)
				: previous.length < 12
					? [
							...previous,
							{
								workspaceId,
								documentId: doc.id,
								filename: doc.filename,
							},
						]
					: previous,
		);
	}
	async function add() {
		if (pending.current || !selected.length) {
			return;
		}
		pending.current = true;
		setAdding(true);
		setFailed([]);
		setProgress(0);
		const request = ++epoch.current;
		const failures: string[] = [];
		try {
			for (const [index, doc] of selected.entries()) {
				if (request !== epoch.current) {
					return;
				}
				try {
					const page =
						await orpcClient.documentWorkspaces.documents.readContent(
							{
								organizationId,
								workspaceId: doc.workspaceId,
								documentId: doc.documentId,
								offset: 0,
								limit: 1,
							},
						);
					if (request !== epoch.current) {
						return;
					}
					await orpcClient.projects.contexts.workspaceDocuments.add({
						projectId,
						organizationId,
						workspaceId: doc.workspaceId,
						documentId: doc.documentId,
						expectedRevision: page.revision,
					});
				} catch {
					failures.push(doc.documentId);
				}
				if (request !== epoch.current) {
					return;
				}
				setProgress(index + 1);
			}
			if (request !== epoch.current) {
				return;
			}
			onAdded();
			if (!failures.length) {
				toast.success(t("added", { count: selected.length }));
				onComplete();
			} else {
				setFailed(failures);
				setSelected((previous) =>
					previous.filter((doc) => failures.includes(doc.documentId)),
				);
			}
		} finally {
			if (request === epoch.current) {
				pending.current = false;
				setAdding(false);
			}
		}
	}
	return (
		<DialogContent
			className="max-w-2xl"
			hideCloseButton={adding}
			onEscapeKeyDown={(event) => {
				if (adding) {
					event.preventDefault();
				}
			}}
			onInteractOutside={(event) => {
				if (adding) {
					event.preventDefault();
				}
			}}
		>
			<DialogHeader>
				<DialogTitle>{t("pickerTitle")}</DialogTitle>
				<DialogDescription>{t("pickerHint")}</DialogDescription>
			</DialogHeader>
			<div className="space-y-3">
				<Input
					aria-label={t("workspaceSearch")}
					placeholder={t("workspaceSearch")}
					value={workspaceSearch}
					disabled={adding}
					onChange={(event) => {
						setWorkspaceSearch(event.target.value);
						setWorkspaceOffset(0);
					}}
				/>
				<Select
					value={workspaceId}
					disabled={
						adding || workspaces.isPending || workspaces.isError
					}
					onValueChange={(value) => {
						setWorkspace(value);
						setOffset(0);
						setSearch("");
					}}
				>
					<SelectTrigger aria-label={t("chooseWorkspace")}>
						<SelectValue placeholder={t("chooseWorkspace")} />
					</SelectTrigger>
					<SelectContent>
						{workspaces.data?.workspaces.map((workspace) => (
							<SelectItem key={workspace.id} value={workspace.id}>
								{workspace.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{workspaces.isError && (
					<Alert variant="error">
						<AlertDescription>
							{t("workspaceError")}
						</AlertDescription>
					</Alert>
				)}
				{!workspaces.isPending &&
					!workspaces.isError &&
					workspaces.data?.workspaces.length === 0 && (
						<p className="text-sm text-muted-foreground">
							{t("noWorkspaces")}
						</p>
					)}
				{(workspaceOffset > 0 || workspaces.data?.hasMore) && (
					<div className="flex gap-2">
						<Button
							variant="ghost"
							size="sm"
							disabled={
								adding ||
								workspaceOffset === 0 ||
								workspaces.isFetching
							}
							onClick={() =>
								setWorkspaceOffset((value) =>
									Math.max(0, value - 20),
								)
							}
						>
							{t("previous")}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={
								adding ||
								!workspaces.data?.hasMore ||
								workspaces.isFetching
							}
							onClick={() =>
								setWorkspaceOffset((value) => value + 20)
							}
						>
							{t("next")}
						</Button>
					</div>
				)}
				{workspaceId && (
					<>
						<Input
							aria-label={t("documentSearch")}
							placeholder={t("documentSearch")}
							disabled={adding}
							value={search}
							onChange={(event) => {
								setSearch(event.target.value);
								setOffset(0);
							}}
						/>
						{documents.isPending ? (
							<output className="block text-sm text-muted-foreground">
								{t("loading")}
							</output>
						) : documents.isError ? (
							<Alert variant="error">
								<AlertDescription>
									{t("workspaceError")}
								</AlertDescription>
							</Alert>
						) : documents.data?.documents.length === 0 ? (
							<p className="py-4 text-sm text-muted-foreground">
								{t("noReadyDocuments")}
							</p>
						) : (
							<div className="max-h-64 overflow-auto rounded-md border border-border">
								{documents.data?.documents.map((doc) => {
									const checked = selected.some(
										(item) => item.documentId === doc.id,
									);
									const linked = existingIds.includes(doc.id);
									return (
										<Label
											key={doc.id}
											className="flex cursor-pointer items-start gap-3 border-b border-border p-3 last:border-b-0"
										>
											<Checkbox
												aria-label={doc.filename}
												checked={checked || linked}
												disabled={
													adding ||
													linked ||
													(!checked &&
														selected.length >= 12)
												}
												onCheckedChange={() =>
													toggle(doc)
												}
											/>
											<span className="min-w-0 flex-1 break-words text-sm">
												{doc.filename}
											</span>
											{linked && (
												<Badge variant="secondary">
													{t("alreadyLinked")}
												</Badge>
											)}
										</Label>
									);
								})}
							</div>
						)}
						{(offset > 0 || documents.data?.hasMore) && (
							<div className="flex gap-2">
								<Button
									variant="ghost"
									size="sm"
									disabled={
										adding ||
										offset === 0 ||
										documents.isFetching
									}
									onClick={() =>
										setOffset((value) =>
											Math.max(0, value - 20),
										)
									}
								>
									{t("previous")}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									disabled={
										adding ||
										!documents.data?.hasMore ||
										documents.isFetching
									}
									onClick={() =>
										setOffset((value) => value + 20)
									}
								>
									{t("next")}
								</Button>
							</div>
						)}
					</>
				)}
				{selected.length > 0 && (
					<fieldset className="space-y-2">
						<legend className="sr-only">
							{t("selectionTitle")}
						</legend>
						<p className="text-sm font-medium">
							{t("selectedCount", { count: selected.length })}
						</p>
						<ul className="max-h-32 space-y-1 overflow-auto">
							{selected.map((doc) => (
								<li
									key={doc.documentId}
									className="flex items-start justify-between gap-2 text-sm"
								>
									<span className="min-w-0 break-words">
										{doc.filename}
									</span>
									<Button
										size="sm"
										variant="ghost"
										disabled={adding}
										aria-label={t("removeSelection", {
											name: doc.filename,
										})}
										onClick={() =>
											setSelected((previous) =>
												previous.filter(
													(item) =>
														item.documentId !==
														doc.documentId,
												),
											)
										}
									>
										{t("removeChoice")}
									</Button>
								</li>
							))}
						</ul>
					</fieldset>
				)}
				{failed.length > 0 && (
					<Alert variant="error">
						<AlertDescription role="status">
							{t("partialError", { count: failed.length })}
						</AlertDescription>
					</Alert>
				)}
			</div>
			<DialogFooter>
				<p id={id} className="mr-auto text-sm text-muted-foreground">
					{adding
						? t("addingProgress", {
								count: progress,
								total: selected.length,
							})
						: t("permissionsHint")}
				</p>
				<Button
					disabled={adding || selected.length === 0}
					aria-describedby={id}
					onClick={() => void add()}
				>
					{adding && (
						<Loader2Icon
							className="mr-2 size-4 motion-safe:animate-spin"
							aria-hidden="true"
						/>
					)}
					{adding
						? t("adding")
						: t("confirmAdd", { count: selected.length })}
				</Button>
			</DialogFooter>
		</DialogContent>
	);
}
