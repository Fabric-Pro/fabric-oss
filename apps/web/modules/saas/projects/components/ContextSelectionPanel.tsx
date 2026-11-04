"use client";
import type {
	ContextSelectionInput,
	SelectedContextPacket,
} from "@repo/rag/lib/context-continuity/contracts";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { ChevronDownIcon, DownloadIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { triggerBlobDownload } from "../lib/markdown-to-document";

type ContextSelectionReference = ContextSelectionInput["selections"][number];

interface Props {
	projectId: string;
	organizationId: string | null;
	sources: { id: string; title: string; version: string }[];
}
function key(ref: ContextSelectionReference) {
	return ref.sourceKind === "project_context"
		? `project:${ref.sourceId}`
		: `workspace:${ref.workspaceId}:${ref.documentId}`;
}
/** Deliberate, caller-owned inspection/export. No implicit attachment to runs, tasks or shared servers. */
function ContextSelectionContent({
	projectId,
	organizationId,
	sources,
}: Props) {
	const t = useTranslations("projects.contexts.selection");
	const [selected, setSelected] = useState<ContextSelectionReference[]>([]);
	const [packet, setPacket] = useState<SelectedContextPacket | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [workspace, setWorkspace] = useState("");
	const [browse, setBrowse] = useState(false);
	const [search, setSearch] = useState("");
	const [workspacePage, setWorkspacePage] = useState(0);
	const [documentPage, setDocumentPage] = useState(0);
	const epoch = useRef(0);
	const pending = useRef(false);
	const scope = JSON.stringify([
		projectId,
		organizationId,
		sources.map((s) => [s.id, s.version]),
	]);
	const currentScope = useRef(scope);
	currentScope.current = scope;
	useEffect(() => {
		epoch.current++;
		pending.current = false;
		setSelected([]);
		setPacket(null);
		setError(null);
		setBusy(false);
		setWorkspace("");
		setBrowse(false);
		return () => {
			epoch.current++;
		};
	}, [scope]);
	const workspaces = useQuery(
		orpc.documentWorkspaces.list.queryOptions({
			input: {
				organizationId,
				limit: 20,
				offset: workspacePage * 20,
				status: "ACTIVE",
			},
			enabled: browse && !!organizationId,
			retry: false,
		}),
	);
	const documents = useQuery(
		orpc.documentWorkspaces.documents.list.queryOptions({
			input: {
				organizationId,
				workspaceId: workspace,
				status: "READY",
				limit: 20,
				offset: documentPage * 20,
				search: search || undefined,
			},
			enabled: !!workspace && !!organizationId,
			retry: false,
		}),
	);
	function invalidate() {
		epoch.current++;
		pending.current = false;
		setBusy(false);
		setPacket(null);
		setError(null);
	}
	function toggle(ref: ContextSelectionReference) {
		invalidate();
		setSelected((previous) =>
			previous.some((item) => key(item) === key(ref))
				? previous.filter((item) => key(item) !== key(ref))
				: previous.length < 12
					? [...previous, ref]
					: previous,
		);
	}
	async function inspect(download = false) {
		if (pending.current || selected.length === 0 || !organizationId) return;
		pending.current = true;
		setBusy(true);
		setError(null);
		const request = ++epoch.current;
		const requestedScope = scope;
		const input =
			download && packet
				? packet.sources.map((source) => source.ref)
				: selected;
		setPacket(null);
		try {
			const result = await orpcClient.projects.contexts.assemble({
				projectId,
				organizationId,
				selections: input,
			});
			if (
				request !== epoch.current ||
				currentScope.current !== requestedScope
			)
				return;
			setPacket(result);
			if (download)
				triggerBlobDownload(
					new Blob([JSON.stringify(result, null, 2)], {
						type: "application/json",
					}),
					"fabric-selected-context.json",
				);
		} catch {
			if (
				request === epoch.current &&
				currentScope.current === requestedScope
			)
				setError(t("error"));
		} finally {
			if (
				request === epoch.current &&
				currentScope.current === requestedScope
			) {
				pending.current = false;
				setBusy(false);
			}
		}
	}
	function choice(ref: ContextSelectionReference, title: string) {
		const checked = selected.some((item) => key(item) === key(ref));
		return (
			<Label
				key={key(ref)}
				className="flex min-w-0 items-start gap-3 rounded-md px-2 py-2 hover:bg-muted"
			>
				<Checkbox
					checked={checked}
					disabled={!checked && selected.length >= 12}
					onCheckedChange={() => toggle(ref)}
				/>
				<span className="min-w-0 break-words text-sm">{title}</span>
			</Label>
		);
	}
	return (
		<div className="space-y-4 border-t border-border p-4">
			<p className="max-w-prose text-sm text-muted-foreground">
				{t("description")}
			</p>
			<div className="grid gap-4 md:grid-cols-2">
				<fieldset className="min-w-0">
					<legend className="mb-2 text-sm font-medium">
						{t("projectSources")}
					</legend>
					<div className="max-h-64 overflow-auto">
						{sources.length ? (
							sources.map((source) =>
								choice(
									{
										sourceKind: "project_context",
										sourceId: source.id,
									},
									source.title,
								),
							)
						) : (
							<p className="text-sm text-muted-foreground">
								{t("empty")}
							</p>
						)}
					</div>
				</fieldset>
				<fieldset className="min-w-0 space-y-3">
					<legend className="mb-2 text-sm font-medium">
						{t("workspaceSources")}
					</legend>
					{!browse ? (
						<Button
							variant="outline"
							size="sm"
							disabled={!organizationId}
							onClick={() => setBrowse(true)}
						>
							{t("browse")}
						</Button>
					) : (
						<>
							{workspaces.isError ? (
								<p
									role="alert"
									className="text-sm text-destructive"
								>
									{t("workspaceError")}
								</p>
							) : (
								<Select
									value={workspace}
									onValueChange={(value) => {
										setWorkspace(value);
										setDocumentPage(0);
										setSearch("");
									}}
								>
									<SelectTrigger
										aria-label={t("chooseWorkspace")}
									>
										<SelectValue
											placeholder={
												workspaces.isFetching
													? t("loading")
													: t("chooseWorkspace")
											}
										/>
									</SelectTrigger>
									<SelectContent>
										{workspaces.data?.workspaces.map(
											(item) => (
												<SelectItem
													key={item.id}
													value={item.id}
												>
													{item.name}
												</SelectItem>
											),
										)}
									</SelectContent>
								</Select>
							)}
							{workspaces.data && (
								<div className="flex items-center gap-2">
									<Button
										variant="ghost"
										size="sm"
										disabled={
											workspacePage === 0 ||
											workspaces.isFetching
										}
										onClick={() =>
											setWorkspacePage((p) => p - 1)
										}
									>
										{t("previous")}
									</Button>
									<Button
										variant="ghost"
										size="sm"
										disabled={
											!workspaces.data.hasMore ||
											workspaces.isFetching
										}
										onClick={() =>
											setWorkspacePage((p) => p + 1)
										}
									>
										{t("moreWorkspaces")}
									</Button>
								</div>
							)}
							{workspace && (
								<>
									<Input
										value={search}
										aria-label={t("search")}
										placeholder={t("search")}
										onChange={(event) => {
											setSearch(event.target.value);
											setDocumentPage(0);
										}}
									/>
									{documents.isError ? (
										<p
											role="alert"
											className="text-sm text-destructive"
										>
											{t("workspaceError")}
										</p>
									) : documents.isFetching ? (
										<p
											role="status"
											className="text-sm text-muted-foreground"
										>
											{t("loading")}
										</p>
									) : (
										<div className="max-h-64 overflow-auto">
											{documents.data?.documents.map(
												(doc) =>
													choice(
														{
															sourceKind:
																"workspace_document",
															workspaceId:
																workspace,
															documentId: doc.id,
														},
														doc.filename,
													),
											)}
											{documents.data?.documents
												.length === 0 && (
												<p className="text-sm text-muted-foreground">
													{t("emptyDocuments")}
												</p>
											)}
										</div>
									)}
									<div className="flex gap-2">
										<Button
											variant="ghost"
											size="sm"
											disabled={
												documentPage === 0 ||
												documents.isFetching
											}
											onClick={() =>
												setDocumentPage((p) => p - 1)
											}
										>
											{t("previous")}
										</Button>
										<Button
											variant="ghost"
											size="sm"
											disabled={
												!documents.data?.hasMore ||
												documents.isFetching
											}
											onClick={() =>
												setDocumentPage((p) => p + 1)
											}
										>
											{t("moreDocuments")}
										</Button>
									</div>
								</>
							)}
						</>
					)}
				</fieldset>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Badge variant="secondary">
					{t("count", { count: selected.length })}
				</Badge>
				<Button
					size="sm"
					disabled={busy || !selected.length || !organizationId}
					onClick={() => void inspect()}
				>
					{busy && (
						<Loader2Icon
							className="mr-2 size-4 motion-safe:animate-spin"
							aria-hidden="true"
						/>
					)}
					{t("inspect")}
				</Button>
				{packet && (
					<Button
						variant="outline"
						size="sm"
						disabled={busy}
						onClick={() => void inspect(true)}
					>
						<DownloadIcon
							className="mr-2 size-4"
							aria-hidden="true"
						/>
						{t("download")}
					</Button>
				)}
			</div>
			{error && (
				<Alert variant="error">
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}
			{packet && (
				<div className="space-y-3" aria-live="polite">
					<p className="text-sm text-muted-foreground">
						{t("notice")}
					</p>
					{packet.omissions.length > 0 && (
						<p className="text-sm text-highlight-ink">
							{t("omitted", {
								count: packet.omissions.length,
							})}
						</p>
					)}
					{packet.sources.map((source) => (
						<article
							key={source.selectionIndex}
							className="space-y-2 border-t border-border pt-3"
						>
							<div className="flex flex-wrap items-center gap-2">
								<h3 className="min-w-0 break-words text-sm font-medium">
									{source.title}
								</h3>
								<Badge variant="outline">
									{source.truncated
										? t("excerpt")
										: t("complete")}
								</Badge>
								<span className="text-xs text-muted-foreground">
									{t("bytes", {
										count: source.byteLength,
									})}
								</span>
							</div>
							<p className="break-all text-xs text-muted-foreground">
								{t("revision")}:{" "}
								<code>{source.sourceRevision}</code>
							</p>
							<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm font-sans">
								{source.content}
							</pre>
						</article>
					))}
				</div>
			)}
		</div>
	);
}

export function ContextSelectionPanel(props: Props) {
	const t = useTranslations("projects.contexts.selection");
	const id = useId();
	const [open, setOpen] = useState(false);
	return (
		<section
			className="rounded-lg border border-border bg-card"
			aria-label={t("title")}
		>
			<Button
				variant="ghost"
				className="flex h-auto w-full justify-between gap-2 whitespace-normal px-4 py-3 text-left"
				aria-expanded={open}
				aria-controls={id}
				onClick={() => setOpen((value) => !value)}
			>
				{t("title")}
				<ChevronDownIcon
					className="size-4 shrink-0"
					aria-hidden="true"
				/>
			</Button>
			{open && (
				<div id={id}>
					<ContextSelectionContent {...props} />
				</div>
			)}
		</section>
	);
}
