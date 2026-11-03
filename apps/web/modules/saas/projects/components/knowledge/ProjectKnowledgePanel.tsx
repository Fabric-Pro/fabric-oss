"use client";

/**
 * Project knowledge hub (specs/2026-10-21-ai-artifacts-hub §5.5–5.6).
 *
 * What engineers and their AI tools saved for the project: topics (a work
 * item or a free topic), each with an AI-maintained summary and an
 * append-only timeline of entries; semantic search across them; and the
 * project's artifact type catalog. AI tools write here through the plugin's
 * `fabric-knowledge` skill; people can add entries too.
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Markdown } from "@ui/components/markdown";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import {
	BookOpenIcon,
	LoaderIcon,
	PlusIcon,
	RefreshCwIcon,
	SearchIcon,
	SettingsIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type Props = {
	projectId: string;
	canEdit?: boolean;
};

function when(value: string | Date | null | undefined): string {
	if (!value) {
		return "";
	}
	return new Date(value).toLocaleString();
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : "Something went wrong";
}

export function ProjectKnowledgePanel({ projectId, canEdit }: Props) {
	const [selected, setSelected] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [mine, setMine] = useState(false);
	const [searchText, setSearchText] = useState("");
	const [composeOpen, setComposeOpen] = useState(false);
	const [typesOpen, setTypesOpen] = useState(false);

	const topics = useQuery(
		orpc.projects.knowledge.listTopics.queryOptions({
			input: { projectId, query: query || undefined, mine, limit: 50 },
		}),
	);
	const search = useQuery({
		...orpc.projects.knowledge.search.queryOptions({
			input: { projectId, query: searchText, limit: 20 },
		}),
		enabled: searchText.trim().length > 0,
	});

	return (
		<div className="space-y-4" data-testid="project-knowledge">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div>
					<h3 className="font-semibold text-lg">Project knowledge</h3>
					<p className="text-muted-foreground text-sm">
						Notes, specs, decisions and handoffs your team and their
						AI tools saved. AI tools add them through the Coding
						Instructions plugin.
					</p>
				</div>
				<div className="flex gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={() => setTypesOpen(true)}
					>
						<SettingsIcon className="mr-2 size-4" />
						Types
					</Button>
					<Button size="sm" onClick={() => setComposeOpen(true)}>
						<PlusIcon className="mr-2 size-4" />
						New entry
					</Button>
				</div>
			</div>

			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					const form = new FormData(event.currentTarget);
					setSearchText(String(form.get("q") ?? ""));
				}}
			>
				<Input
					name="q"
					placeholder="Search everything the team saved…"
					defaultValue={searchText}
				/>
				<Button type="submit" variant="outline">
					<SearchIcon className="size-4" />
				</Button>
				{searchText && (
					<Button
						type="button"
						variant="ghost"
						onClick={() => setSearchText("")}
					>
						Clear
					</Button>
				)}
			</form>

			{searchText ? (
				<Card className="p-4">
					<div className="mb-2 flex items-center gap-2 text-sm">
						<span className="font-medium">Results</span>
						{search.data && (
							<Badge variant="outline">{search.data.mode}</Badge>
						)}
						{search.isFetching && (
							<LoaderIcon className="size-4 animate-spin" />
						)}
					</div>
					{search.data?.hits.length === 0 && (
						<p className="text-muted-foreground text-sm">
							Nothing found.
						</p>
					)}
					<ul className="space-y-3">
						{search.data?.hits.map((hit) => (
							<li key={hit.entryId}>
								<button
									type="button"
									className="w-full text-left"
									onClick={() => {
										setSelected(hit.topicId);
										setSearchText("");
									}}
								>
									<div className="flex flex-wrap items-center gap-2">
										<span className="font-medium">
											{hit.title}
										</span>
										<Badge variant="secondary">
											{hit.type}
										</Badge>
										<span className="text-muted-foreground text-xs">
											{hit.topicTitle} ·{" "}
											{search.data?.authors[
												hit.authorUserId
											] ?? ""}{" "}
											· {when(hit.createdAt)}
										</span>
									</div>
									<p className="line-clamp-2 text-muted-foreground text-sm">
										{hit.snippet}
									</p>
								</button>
							</li>
						))}
					</ul>
				</Card>
			) : (
				<div className="grid gap-4 md:grid-cols-[280px_1fr]">
					<Card className="p-3">
						<div className="mb-2 flex gap-2">
							<Input
								placeholder="Filter topics"
								value={query}
								onChange={(event) =>
									setQuery(event.target.value)
								}
							/>
						</div>
						<label className="mb-2 flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={mine}
								onChange={(event) =>
									setMine(event.target.checked)
								}
							/>
							Only topics I contributed to
						</label>
						{topics.isLoading && (
							<LoaderIcon className="size-4 animate-spin" />
						)}
						{topics.data?.topics.length === 0 && (
							<div className="py-6 text-center text-muted-foreground text-sm">
								<BookOpenIcon className="mx-auto mb-2 size-6" />
								No knowledge yet. Add an entry, or ask your AI
								tool to “save this for context”.
							</div>
						)}
						<ul className="space-y-1">
							{topics.data?.topics.map((topic) => (
								<li key={topic.id}>
									<button
										type="button"
										onClick={() => setSelected(topic.id)}
										className={`w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted ${
											selected === topic.id
												? "bg-muted"
												: ""
										}`}
									>
										<div className="font-medium">
											{topic.title}
										</div>
										<div className="text-muted-foreground text-xs">
											{topic.entryCount} entries ·{" "}
											{when(topic.lastEntryAt)}
										</div>
									</button>
								</li>
							))}
						</ul>
					</Card>
					<div>
						{selected ? (
							<TopicView
								projectId={projectId}
								topicId={selected}
								onCompose={() => setComposeOpen(true)}
							/>
						) : (
							<Card className="p-6 text-center text-muted-foreground text-sm">
								Pick a topic to read its summary and timeline.
							</Card>
						)}
					</div>
				</div>
			)}

			<ComposeDialog
				open={composeOpen}
				onOpenChange={setComposeOpen}
				projectId={projectId}
				topicId={selected}
				onSaved={(topicId) => setSelected(topicId)}
			/>
			<TypesDialog
				open={typesOpen}
				onOpenChange={setTypesOpen}
				projectId={projectId}
				canEdit={canEdit === true}
			/>
		</div>
	);
}

function TopicView({
	projectId,
	topicId,
	onCompose,
}: {
	projectId: string;
	topicId: string;
	onCompose: () => void;
}) {
	const queryClient = useQueryClient();
	const topic = useQuery({
		...orpc.projects.knowledge.getTopic.queryOptions({
			input: { projectId, topic: topicId, newestFirst: true, limit: 100 },
		}),
		refetchInterval: (query) =>
			query.state.data?.summaryInProgress ? 5000 : false,
	});
	const refresh = useMutation(
		orpc.projects.knowledge.refreshSummary.mutationOptions({
			onSuccess: () => {
				toast.success("The summary will refresh within a minute.");
				setTimeout(() => {
					queryClient.invalidateQueries({
						queryKey: orpc.projects.knowledge.key(),
					});
				}, 25_000);
			},
			onError: (error) => toast.error(errorText(error)),
		}),
	);

	if (topic.isLoading) {
		return <LoaderIcon className="size-5 animate-spin" />;
	}
	if (!topic.data) {
		return (
			<Card className="p-6 text-muted-foreground text-sm">
				Topic not found.
			</Card>
		);
	}
	const view = topic.data;
	return (
		<div className="space-y-4">
			<Card className="p-4">
				<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
					<div>
						<h4 className="font-semibold">{view.topic.title}</h4>
						<p className="text-muted-foreground text-xs">
							{view.topic.kind === "WORK_ITEM"
								? "Work item"
								: "Topic"}{" "}
							· {view.topic.entryCount} entries
						</p>
					</div>
					<div className="flex gap-2">
						{view.summaryInProgress && (
							<Badge variant="outline">Summarizing…</Badge>
						)}
						{!view.summaryInProgress && view.summaryStale && (
							<Badge variant="outline">Summary out of date</Badge>
						)}
						<Button
							size="sm"
							variant="outline"
							disabled={refresh.isPending}
							onClick={() =>
								refresh.mutate({
									projectId,
									topicId: view.topic.id,
								})
							}
						>
							<RefreshCwIcon className="mr-2 size-4" />
							Refresh summary
						</Button>
						<Button size="sm" onClick={onCompose}>
							<PlusIcon className="mr-2 size-4" />
							Add
						</Button>
					</div>
				</div>
				{view.summary?.content ? (
					<Markdown className="prose prose-sm max-w-none dark:prose-invert">
						{view.summary.content}
					</Markdown>
				) : (
					<p className="text-muted-foreground text-sm">
						No summary yet. It is written from the entries a minute
						after they arrive.
					</p>
				)}
			</Card>
			<div className="space-y-3">
				<h5 className="font-medium text-sm">Timeline (newest first)</h5>
				{view.entries.map((entry) => (
					<Card
						key={entry.id}
						className={`p-4 ${entry.supersededBy ? "opacity-60" : ""}`}
					>
						<div className="mb-2 flex flex-wrap items-center gap-2">
							<span className="font-medium">{entry.title}</span>
							<Badge variant="secondary">{entry.type.name}</Badge>
							{entry.role && (
								<Badge variant="outline">{entry.role}</Badge>
							)}
							{entry.supersededBy && (
								<Badge variant="outline">Superseded</Badge>
							)}
							<span className="text-muted-foreground text-xs">
								{view.authors[entry.authorUserId] ?? "Unknown"}
								{entry.agentClient
									? ` via ${entry.agentClient}`
									: ""}{" "}
								· {when(entry.createdAt)}
							</span>
						</div>
						<Markdown className="prose prose-sm max-w-none dark:prose-invert">
							{entry.body}
						</Markdown>
					</Card>
				))}
			</div>
		</div>
	);
}

function ComposeDialog({
	open,
	onOpenChange,
	projectId,
	topicId,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	topicId: string | null;
	onSaved: (topicId: string) => void;
}) {
	const queryClient = useQueryClient();
	const types = useQuery({
		...orpc.projects.knowledge.listTypes.queryOptions({
			input: { projectId },
		}),
		enabled: open,
	});
	const [topic, setTopic] = useState("");
	const [type, setType] = useState("note");
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [role, setRole] = useState("");
	const add = useMutation(
		orpc.projects.knowledge.addEntry.mutationOptions({
			onSuccess: (result) => {
				toast.success(result.duplicate ? "Already saved" : "Saved");
				queryClient.invalidateQueries({
					queryKey: orpc.projects.knowledge.key(),
				});
				onSaved(result.topicId);
				onOpenChange(false);
				setTitle("");
				setBody("");
			},
			onError: (error) => toast.error(errorText(error)),
		}),
	);
	const selectedType = types.data?.types.find((t) => t.key === type);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>New knowledge entry</DialogTitle>
				</DialogHeader>
				<div className="space-y-3">
					<div>
						<Label>Topic</Label>
						<Input
							placeholder={
								topicId
									? "Leave empty for the open topic"
									: "Work item (US-012, 12345) or a topic name"
							}
							value={topic}
							onChange={(event) => setTopic(event.target.value)}
						/>
					</div>
					<div className="grid grid-cols-2 gap-3">
						<div>
							<Label>Type</Label>
							<Select
								value={type}
								onValueChange={(value) => {
									setType(value);
									const template = types.data?.types.find(
										(t) => t.key === value,
									)?.template;
									if (template && !body) {
										setBody(template);
									}
								}}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{types.data?.types.map((t) => (
										<SelectItem key={t.key} value={t.key}>
											{t.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div>
							<Label>Your role (optional)</Label>
							<Input
								placeholder="FE, BE, QA…"
								value={role}
								onChange={(event) =>
									setRole(event.target.value)
								}
							/>
						</div>
					</div>
					{selectedType && (
						<p className="text-muted-foreground text-xs">
							{selectedType.description}
						</p>
					)}
					<div>
						<Label>Title</Label>
						<Input
							value={title}
							onChange={(event) => setTitle(event.target.value)}
						/>
					</div>
					<div>
						<Label>Body (markdown)</Label>
						<Textarea
							rows={10}
							value={body}
							onChange={(event) => setBody(event.target.value)}
						/>
					</div>
					<div className="flex justify-end gap-2">
						<Button
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							disabled={
								add.isPending ||
								!title.trim() ||
								!body.trim() ||
								(!topic.trim() && !topicId)
							}
							onClick={() =>
								add.mutate({
									projectId,
									topic: topic.trim() || (topicId as string),
									type,
									title,
									body,
									role: role.trim() || undefined,
								})
							}
						>
							Save
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function TypesDialog({
	open,
	onOpenChange,
	projectId,
	canEdit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	canEdit: boolean;
}) {
	const queryClient = useQueryClient();
	const types = useQuery({
		...orpc.projects.knowledge.listTypes.queryOptions({
			input: { projectId },
		}),
		enabled: open,
	});
	const [editing, setEditing] = useState<{
		key: string;
		name: string;
		description: string;
		template: string;
		summaryBehavior: "MERGE" | "LATEST_WINS" | "EXCLUDED";
		isNew: boolean;
	} | null>(null);
	const save = useMutation(
		orpc.projects.knowledge.upsertType.mutationOptions({
			onSuccess: () => {
				toast.success("Type saved");
				queryClient.invalidateQueries({
					queryKey: orpc.projects.knowledge.key(),
				});
				setEditing(null);
			},
			onError: (error) => toast.error(errorText(error)),
		}),
	);
	const archive = useMutation(
		orpc.projects.knowledge.archiveType.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: orpc.projects.knowledge.key(),
				});
			},
			onError: (error) => toast.error(errorText(error)),
		}),
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Knowledge types</DialogTitle>
				</DialogHeader>
				{editing ? (
					<div className="space-y-3">
						<div className="grid grid-cols-2 gap-3">
							<div>
								<Label>Key</Label>
								<Input
									disabled={!editing.isNew}
									value={editing.key}
									onChange={(event) =>
										setEditing({
											...editing,
											key: event.target.value,
										})
									}
								/>
							</div>
							<div>
								<Label>Name</Label>
								<Input
									value={editing.name}
									onChange={(event) =>
										setEditing({
											...editing,
											name: event.target.value,
										})
									}
								/>
							</div>
						</div>
						<div>
							<Label>When to use it (shown to AI tools)</Label>
							<Textarea
								rows={3}
								value={editing.description}
								onChange={(event) =>
									setEditing({
										...editing,
										description: event.target.value,
									})
								}
							/>
						</div>
						<div>
							<Label>Template (markdown, optional)</Label>
							<Textarea
								rows={6}
								value={editing.template}
								onChange={(event) =>
									setEditing({
										...editing,
										template: event.target.value,
									})
								}
							/>
						</div>
						<div>
							<Label>In the topic summary</Label>
							<Select
								value={editing.summaryBehavior}
								onValueChange={(value) =>
									setEditing({
										...editing,
										summaryBehavior:
											value as typeof editing.summaryBehavior,
									})
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="MERGE">
										Merged with the rest
									</SelectItem>
									<SelectItem value="LATEST_WINS">
										Only the newest counts
									</SelectItem>
									<SelectItem value="EXCLUDED">
										Left out
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="flex justify-end gap-2">
							<Button
								variant="ghost"
								onClick={() => setEditing(null)}
							>
								Cancel
							</Button>
							<Button
								disabled={save.isPending}
								onClick={() =>
									save.mutate({
										projectId,
										key: editing.key.trim(),
										name: editing.name,
										description: editing.description,
										template: editing.template || null,
										summaryBehavior:
											editing.summaryBehavior,
									})
								}
							>
								Save type
							</Button>
						</div>
					</div>
				) : (
					<div className="space-y-2">
						{types.data?.types.map((t) => (
							<div
								key={t.key}
								className="flex items-start justify-between gap-2 rounded-md border p-3"
							>
								<div>
									<div className="flex items-center gap-2">
										<span className="font-medium">
											{t.name}
										</span>
										<code className="text-muted-foreground text-xs">
											{t.key}
										</code>
										{t.builtIn && (
											<Badge variant="outline">
												built-in
											</Badge>
										)}
									</div>
									<p className="text-muted-foreground text-sm">
										{t.description}
									</p>
								</div>
								{canEdit && (
									<div className="flex shrink-0 gap-1">
										<Button
											size="sm"
											variant="ghost"
											onClick={() =>
												setEditing({
													key: t.key,
													name: t.name,
													description: t.description,
													template: t.template ?? "",
													summaryBehavior:
														t.summaryBehavior,
													isNew: false,
												})
											}
										>
											Edit
										</Button>
										{!t.builtIn && (
											<Button
												size="sm"
												variant="ghost"
												onClick={() =>
													archive.mutate({
														projectId,
														key: t.key,
													})
												}
											>
												Archive
											</Button>
										)}
									</div>
								)}
							</div>
						))}
						{canEdit && (
							<Button
								variant="outline"
								onClick={() =>
									setEditing({
										key: "",
										name: "",
										description: "",
										template: "",
										summaryBehavior: "MERGE",
										isNew: true,
									})
								}
							>
								<PlusIcon className="mr-2 size-4" />
								Add a type
							</Button>
						)}
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
