"use client";

import {
	FABRIC_IGNORE_FILE,
	PROJECT_IGNORE_GLOB_LIMITS,
} from "@repo/instructions";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Checkbox } from "@ui/components/checkbox";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { SearchInput } from "@ui/components/search-input";
import { cn } from "@ui/lib";
import {
	ChevronRightIcon,
	FileIcon,
	FolderIcon,
	FolderRootIcon,
	Loader2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { useSettledValue } from "../../hooks/use-settled-value";
import {
	buildRepositoryTree,
	CONTEXT_SYNC_TREE_ENTRY_LIMIT,
	CONTEXT_SYNC_TREE_SEARCH_MAX_MATCHES,
	type RepositoryTreeNode,
	searchRepositoryTreeEntries,
} from "../../lib/context-repository-sync-tree";
import {
	repositorySyncTreeErrorKey,
	repositorySyncTreeSelection,
} from "../../lib/instructions-repository-sync";
import {
	describeExclusionRow,
	type ExcludedAncestor,
	type ExclusionCause,
	type ExclusionRow,
	excludedAncestorForChildren,
	projectIgnoreListFull,
	syncExclusionMatcher,
} from "../../lib/instructions-sync-exclusions";

/** How long the branch must stay unchanged before the listing is fetched. */
const BRANCH_DEBOUNCE_MS = 500;
const LIST_TREE_STALE_MS = 5 * 60 * 1000;

/**
 * The radio value of the "Repository root" option. Never a folder's path: a
 * listed path never starts with `/`. Radix compares values as strings, so
 * the root gets one of its own rather than `""`.
 */
const ROOT_OPTION_VALUE = "/";

/** The folders on the way to `path`, outermost first (not `path` itself). */
function ancestorsOf(path: string): string[] {
	const segments = path.split("/");
	return segments
		.slice(0, -1)
		.map((_, i) => segments.slice(0, i + 1).join("/"));
}

/**
 * The dialog's folder exclusions (Fizzy #2726), when it offers them: the
 * project's own ignore list with the staged edits applied, and the callback
 * that stages one more. Nothing here is saved; the dialog saves on submit.
 */
export type RepositorySyncTreeExclusions = {
	/**
	 * The project's own list with the staged edits applied: `null` for a
	 * project with no setting, `undefined` until the saved list has loaded.
	 */
	projectGlobs: readonly string[] | null | undefined;
	/** The saved list could not be loaded. */
	settingsFailed: boolean;
	/** Stage `pattern` (`F/**`) as excluded or not. */
	onToggle: (pattern: string, exclude: boolean) => void;
};

/** The chosen folder's `.fabricignore`, as far as the preview knows it. */
type IgnoreFileState =
	| { kind: "none" }
	| { kind: "loading" }
	| { kind: "error" }
	| { kind: "tooLarge" }
	| { kind: "rules"; rules: readonly string[] };

/**
 * What the preview knows of the chosen folder's `.fabricignore`. Only a
 * file with rules changes anything: no file, one with no rules, and one
 * over the sync's limit all leave the project's rules in force, as in the
 * sync.
 */
function ignoreFileStateOf(input: {
	read: boolean;
	failed: boolean;
	data:
		| { supported: boolean; state: string; rules: readonly string[] }
		| undefined;
}): IgnoreFileState {
	if (!input.read) {
		return { kind: "none" };
	}
	if (input.failed) {
		return { kind: "error" };
	}
	if (!input.data) {
		return { kind: "loading" };
	}
	if (!input.data.supported) {
		return { kind: "none" };
	}
	if (input.data.state === "tooLarge") {
		return { kind: "tooLarge" };
	}
	return input.data.state === "rules" && input.data.rules.length > 0
		? { kind: "rules", rules: input.data.rules }
		: { kind: "none" };
}

/**
 * The Coding Instructions configure dialog's browser over one branch of the
 * chosen repository (Fizzy #2725, after Living Memory's #2674): one radio
 * per folder plus "Repository root", with the branch's files shown muted
 * for orientation — where CLAUDE.md or AGENTS.md live — but never
 * selectable, since the sync reads a folder. The typed folder input stays
 * the only selection state: a row is selected when the typed value, trimmed
 * and without trailing slashes, is its path, and picking a row writes to
 * that input (`onSelect`), so the two can never disagree. Whatever the
 * listing's outcome, the typed input keeps working; this only renders what
 * the listing allows.
 *
 * Folder exclusions (Fizzy #2726): under the chosen folder, every row the
 * sync would skip says so in words, with the rule that skips it, and every
 * folder has an "Exclude" toggle that stages `F/**` in the project's own
 * ignore list (`exclusions`). What is skipped is computed by the sync's own
 * `resolveIgnoreGlobs` + `buildIgnoreMatcher` — every file row on its own
 * path, exactly as the sync plans it (`describeExclusionRow`) — so the chosen folder's
 * `.fabricignore` is read (`repositorySync.readIgnoreFile`) when the listing
 * has one — or might have one beyond a truncated listing. A file with rules
 * replaces the project's rules, so every toggle is then disabled and the
 * tree shows the file's exclusions. A failed read disables every toggle and
 * shows no exclusions rather than showing the project's rules as if they
 * applied.
 *
 * Laziness by expansion is the performance strategy: a folder's children
 * are rendered only while it is expanded, and a search shows at most
 * `CONTEXT_SYNC_TREE_SEARCH_MAX_MATCHES` matches.
 */
export function InstructionsRepositorySyncTreeBrowser({
	projectId,
	repositoryIntegrationId,
	branch,
	rootPath,
	disabled,
	onSelect,
	exclusions,
}: {
	projectId: string;
	repositoryIntegrationId: string;
	/** Already trimmed. */
	branch: string;
	/** The folder input's value, as typed. */
	rootPath: string;
	disabled: boolean;
	/** A folder's path, or `""` for the repository root. */
	onSelect: (rootPath: string) => void;
	/** Folder exclusions; without it the browser only picks a folder. */
	exclusions?: RepositorySyncTreeExclusions;
}) {
	const t = useTranslations("projects.codingInstructions.repositorySync");
	const hintId = useId();
	const debouncedBranch = useSettledValue(branch, BRANCH_DEBOUNCE_MS);
	// Only a settled branch is listed: a key per keystroke would be a
	// request per keystroke, and a stale one would list the wrong branch.
	const enabled =
		repositoryIntegrationId !== "" &&
		branch !== "" &&
		debouncedBranch === branch;
	const tree = useQuery(
		orpc.projects.instructions.repositorySync.listTree.queryOptions({
			input: {
				projectId,
				repositoryIntegrationId,
				ref: debouncedBranch,
			},
			enabled,
			staleTime: LIST_TREE_STALE_MS,
			retry: false,
		}),
	);
	const listing = tree.data;

	const [search, setSearch] = useState("");
	// Browse-mode expansion as the folders flipped from their default, so a
	// new listing needs no reset. By default root folders are open, and so
	// is every folder on the way to the folder the dialog opened with, so a
	// stored configuration shows its selection. Seeded once: a default that
	// followed later picks would flip folders the member already toggled.
	const [openedWith] = useState(
		() => new Set(ancestorsOf(repositorySyncTreeSelection(rootPath))),
	);
	const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
	// Search-mode expansion: every folder open unless collapsed during this
	// query. Kept apart so clearing the search restores `toggled` untouched.
	const [searchCollapsed, setSearchCollapsed] = useState<{
		query: string;
		paths: ReadonlySet<string>;
	}>({ query: "", paths: new Set() });

	const query = search.trim();
	const searching = query !== "";
	const entries = listing?.entries;
	const browseRoots = useMemo(
		() => (entries ? buildRepositoryTree(entries) : []),
		[entries],
	);
	const searchResult = useMemo(
		() =>
			entries && searching
				? searchRepositoryTreeEntries(entries, query)
				: null,
		[entries, searching, query],
	);
	const searchRoots = useMemo(
		() => (searchResult ? buildRepositoryTree(searchResult.entries) : []),
		[searchResult],
	);

	// Folder exclusions: offered once the listing is in and the project's
	// saved list has loaded.
	const selection = repositorySyncTreeSelection(rootPath);
	const projectGlobs = exclusions?.projectGlobs;
	const exclusionsOn =
		exclusions !== undefined &&
		projectGlobs !== undefined &&
		listing?.supported === true;
	const ignoreFilePath =
		selection === ""
			? FABRIC_IGNORE_FILE
			: `${selection}/${FABRIC_IGNORE_FILE}`;
	const ignoreFileLookup = useMemo(() => {
		if (!entries) {
			return { rootListed: false, entry: undefined };
		}
		return {
			rootListed:
				selection === "" ||
				entries.some((e) => e.type === "dir" && e.path === selection),
			entry: entries.find((e) => e.path === ignoreFilePath),
		};
	}, [entries, selection, ignoreFilePath]);
	// Only the exact root-level file counts, as in the sync, and only a
	// regular one: a `.fabricignore` that is a symbolic link is no file to
	// the sync, so there is nothing to read. A truncated listing may have
	// stopped before it, so the file is read then too (a 404 is simply
	// "absent").
	const readsIgnoreFile =
		exclusionsOn &&
		ignoreFileLookup.rootListed &&
		((ignoreFileLookup.entry?.type === "file" &&
			ignoreFileLookup.entry.regular !== false) ||
			(listing?.truncated === true &&
				ignoreFileLookup.entry === undefined));
	const ignoreFileQuery = useQuery(
		orpc.projects.instructions.repositorySync.readIgnoreFile.queryOptions({
			input: {
				projectId,
				repositoryIntegrationId,
				ref: debouncedBranch,
				rootPath: selection,
			},
			enabled: readsIgnoreFile,
			staleTime: LIST_TREE_STALE_MS,
			retry: false,
		}),
	);
	const ignoreFileData = ignoreFileQuery.data;
	const ignoreFile = ignoreFileStateOf({
		read: readsIgnoreFile,
		failed: ignoreFileQuery.isError,
		data: ignoreFileData,
	});
	const fabricIgnoreRules =
		ignoreFile.kind === "rules" ? ignoreFile.rules : null;
	const rulesKnown =
		ignoreFile.kind !== "loading" && ignoreFile.kind !== "error";
	// Stable while the project list and the file's rules are: every row
	// runs this matcher.
	const matcher = useMemo(
		() =>
			exclusionsOn && rulesKnown
				? syncExclusionMatcher({
						fabricIgnoreRules,
						projectGlobs: projectGlobs ?? null,
					})
				: null,
		[exclusionsOn, rulesKnown, fabricIgnoreRules, projectGlobs],
	);

	if (repositoryIntegrationId === "" || branch === "") {
		return null;
	}

	if (!enabled || tree.isPending) {
		return (
			<output className="flex items-center gap-2 text-muted-foreground text-xs">
				<Loader2Icon
					className="size-3 animate-spin"
					aria-hidden="true"
				/>
				{t("tree.loading")}
			</output>
		);
	}

	if (tree.isError) {
		return (
			<p role="alert" className="text-destructive text-xs">
				{t(repositorySyncTreeErrorKey(tree.error), {
					ref: debouncedBranch,
				})}
			</p>
		);
	}

	if (!listing?.supported) {
		return (
			<p className="text-muted-foreground text-xs">
				{t("tree.unsupported")}
			</p>
		);
	}

	if (listing.entries.length === 0) {
		return (
			<p className="text-muted-foreground text-xs">{t("tree.empty")}</p>
		);
	}

	const roots = searching ? searchRoots : browseRoots;

	function isExpanded(path: string, depth: number): boolean {
		if (searching) {
			return !(
				searchCollapsed.query === query &&
				searchCollapsed.paths.has(path)
			);
		}
		const openByDefault = depth === 0 || openedWith.has(path);
		return openByDefault !== toggled.has(path);
	}

	function toggle(path: string) {
		if (searching) {
			setSearchCollapsed((prev) => {
				const next = new Set(prev.query === query ? prev.paths : []);
				if (next.has(path)) {
					next.delete(path);
				} else {
					next.add(path);
				}
				return { query, paths: next };
			});
			return;
		}
		setToggled((prev) => {
			const next = new Set(prev);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
			}
			return next;
		});
	}

	const exclusionIds = {
		fabricIgnore: `${hintId}-fabricignore`,
		status: `${hintId}-exclusions-status`,
		full: `${hintId}-exclusions-full`,
	};
	const exclusionContext: TreeRowExclusions | null =
		exclusionsOn && exclusions
			? {
					describe: (node, excludedAncestor) =>
						describeExclusionRow({
							path: node.path,
							type: node.type,
							regular: node.regular,
							root: selection,
							excludedAncestor,
							matcher,
							projectGlobs: projectGlobs ?? null,
						}),
					onToggle: exclusions.onToggle,
					disabled,
					ids: exclusionIds,
				}
			: null;
	const rowContext: TreeRowContext = {
		isExpanded,
		toggle,
		exclusions: exclusionContext,
	};
	const rootRadioId = `${hintId}-root`;
	const projectListFull =
		exclusionsOn &&
		ignoreFile.kind !== "rules" &&
		projectIgnoreListFull(projectGlobs ?? null);

	return (
		<div className="flex flex-col gap-1.5">
			<SearchInput
				value={search}
				onChange={(e) => setSearch(e.target.value)}
				placeholder={t("tree.searchPlaceholder")}
				aria-label={t("tree.searchPlaceholder")}
			/>
			{listing.truncated ? (
				<p className="text-muted-foreground text-xs">
					{t("tree.truncated", {
						max: CONTEXT_SYNC_TREE_ENTRY_LIMIT,
					})}
				</p>
			) : null}
			<p id={hintId} className="text-muted-foreground text-xs">
				{t("tree.hint")}
			</p>
			{exclusions?.settingsFailed ? (
				<p role="alert" className="text-destructive text-xs">
					{t("tree.exclusions.settingsError")}
				</p>
			) : null}
			{exclusionsOn ? (
				<ExclusionNotices
					ignoreFile={ignoreFile}
					projectListFull={projectListFull}
					ids={exclusionIds}
				/>
			) : null}
			<RadioGroup
				value={selection === "" ? ROOT_OPTION_VALUE : selection}
				onValueChange={(value) =>
					onSelect(value === ROOT_OPTION_VALUE ? "" : value)
				}
				disabled={disabled}
				aria-label={t("tree.label")}
				aria-describedby={hintId}
				className="flex max-h-64 flex-col gap-0 overflow-y-auto rounded-md border border-input p-2"
			>
				<div className="flex min-w-0 items-center gap-2 py-0.5">
					<span className="size-4 shrink-0" aria-hidden="true" />
					<RadioGroupItem
						id={rootRadioId}
						value={ROOT_OPTION_VALUE}
						aria-label={t("tree.repositoryRoot")}
					/>
					<FolderRootIcon
						className="size-4 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					<label htmlFor={rootRadioId} className="truncate text-xs">
						{t("tree.repositoryRoot")}
					</label>
				</div>
				{roots.length === 0 ? (
					<p className="text-muted-foreground text-xs">
						{t("tree.noMatches")}
					</p>
				) : (
					<ul className="flex flex-col">
						{roots.map((node) => (
							<TreeRow
								key={node.path}
								node={node}
								depth={0}
								excludedAncestor={null}
								context={rowContext}
							/>
						))}
					</ul>
				)}
			</RadioGroup>
			{searchResult?.capped ? (
				<p className="text-muted-foreground text-xs">
					{t("tree.refineSearch", {
						max: CONTEXT_SYNC_TREE_SEARCH_MAX_MATCHES,
					})}
				</p>
			) : null}
		</div>
	);
}

type ExclusionNoticeIds = {
	fabricIgnore: string;
	status: string;
	full: string;
};

/**
 * What applies to the chosen folder's exclusions as a whole: the shared
 * rules hint, then whichever of the `.fabricignore` states or the full
 * project list the toggles defer to (each toggle it disables points here).
 */
function ExclusionNotices({
	ignoreFile,
	projectListFull,
	ids,
}: {
	ignoreFile: IgnoreFileState;
	projectListFull: boolean;
	ids: ExclusionNoticeIds;
}) {
	const t = useTranslations(
		"projects.codingInstructions.repositorySync.tree.exclusions",
	);
	return (
		<>
			<p className="text-muted-foreground text-xs">{t("hint")}</p>
			{ignoreFile.kind === "loading" ? (
				<output
					id={ids.status}
					className="flex items-center gap-2 text-muted-foreground text-xs"
				>
					<Loader2Icon
						className="size-3 animate-spin"
						aria-hidden="true"
					/>
					{t("ignoreFileLoading")}
				</output>
			) : null}
			{ignoreFile.kind === "error" ? (
				<p
					id={ids.status}
					role="alert"
					className="text-destructive text-xs"
				>
					{t("ignoreFileError")}
				</p>
			) : null}
			{ignoreFile.kind === "rules" ? (
				<p id={ids.fabricIgnore} className="text-xs">
					{t("fabricignore")}
				</p>
			) : null}
			{ignoreFile.kind === "tooLarge" ? (
				<p className="text-muted-foreground text-xs">
					{t("ignoreFileTooLarge")}
				</p>
			) : null}
			{projectListFull ? (
				<p id={ids.full} className="text-muted-foreground text-xs">
					{t("block.full", {
						max: PROJECT_IGNORE_GLOB_LIMITS.maxGlobs,
					})}
				</p>
			) : null}
		</>
	);
}

type TreeRowExclusions = {
	describe: (
		node: RepositoryTreeNode,
		excludedAncestor: ExcludedAncestor | null,
	) => ExclusionRow;
	onToggle: (pattern: string, exclude: boolean) => void;
	disabled: boolean;
	ids: ExclusionNoticeIds;
};

type TreeRowContext = {
	isExpanded: (path: string, depth: number) => boolean;
	toggle: (path: string) => void;
	/** Folder exclusions, when the dialog offers them. */
	exclusions: TreeRowExclusions | null;
};

/** The translation key and values that say why a row is skipped. */
function causeMessage(cause: ExclusionCause): {
	key: string;
	values: Record<string, string>;
} {
	if (cause.via === "ancestor") {
		return { key: "cause.ancestor", values: { path: cause.ancestor } };
	}
	if (cause.via === "notRegular") {
		return { key: "cause.notRegular", values: {} };
	}
	return { key: `cause.${cause.layer}`, values: { rule: cause.rule } };
}

/**
 * "Excluded", in words, with the rule that skips the row for a screen
 * reader and on hover. `id` names the reason for a toggle to point at.
 */
function ExcludedBadge({ cause, id }: { cause: ExclusionCause; id: string }) {
	const t = useTranslations(
		"projects.codingInstructions.repositorySync.tree.exclusions",
	);
	const message = causeMessage(cause);
	const reason = t(message.key, message.values);
	return (
		<Badge status="info" title={reason}>
			{t("excluded")}
			<span id={id} className="sr-only">
				{reason}
			</span>
		</Badge>
	);
}

/** A folder's "Exclude" toggle; a disabled one points at why. */
function ExclusionToggle({
	node,
	row,
	exclusions,
	causeId,
}: {
	node: RepositoryTreeNode;
	row: Exclude<ExclusionRow, { kind: "outside" }>;
	exclusions: TreeRowExclusions;
	causeId: string;
}) {
	const t = useTranslations(
		"projects.codingInstructions.repositorySync.tree.exclusions",
	);
	const id = useId();
	const toggle = row.toggle;
	if (!toggle) {
		return null;
	}
	const blockId = `${id}-block`;
	const ownReason =
		toggle.block === "wildcard" || toggle.block === "tooLong"
			? t(`block.${toggle.block}`)
			: null;
	// Why the row is skipped, then why the toggle cannot change it.
	const blockReasonId =
		toggle.block === "fabricignore"
			? exclusions.ids.fabricIgnore
			: toggle.block === "unknown"
				? exclusions.ids.status
				: toggle.block === "full"
					? exclusions.ids.full
					: ownReason
						? blockId
						: null;
	const describedBy =
		[row.kind === "excluded" ? causeId : null, blockReasonId]
			.filter((part): part is string => part !== null)
			.join(" ") || undefined;
	const checkboxId = `${id}-exclude`;
	return (
		<span
			className="flex items-center gap-1"
			title={ownReason ?? undefined}
		>
			<Checkbox
				id={checkboxId}
				checked={toggle.checked}
				disabled={exclusions.disabled || toggle.block !== null}
				onCheckedChange={(value) =>
					exclusions.onToggle(toggle.pattern, value === true)
				}
				aria-label={t("toggleLabel", { path: node.path })}
				aria-describedby={describedBy}
			/>
			<label
				htmlFor={checkboxId}
				className="text-muted-foreground text-xs"
			>
				{t("toggle")}
			</label>
			{ownReason ? (
				<span id={blockId} className="sr-only">
					{ownReason}
				</span>
			) : null}
		</span>
	);
}

function TreeRow({
	node,
	depth,
	excludedAncestor,
	context,
}: {
	node: RepositoryTreeNode;
	depth: number;
	/** The nearest skipped folder this row sits in, when there is one. */
	excludedAncestor: ExcludedAncestor | null;
	context: TreeRowContext;
}) {
	const id = useId();
	const row = context.exclusions?.describe(node, excludedAncestor) ?? null;
	const causeId = `${id}-cause`;
	const badge =
		row?.kind === "excluded" ? (
			<ExcludedBadge cause={row.cause} id={causeId} />
		) : null;

	if (node.type !== "dir") {
		// Orientation only: the sync reads a folder, so a file is text, with
		// no control to focus or choose.
		return (
			<li className="flex min-w-0 items-center gap-2 py-0.5 text-muted-foreground">
				<span className="size-4 shrink-0" aria-hidden="true" />
				<span className="size-4 shrink-0" aria-hidden="true" />
				<FileIcon className="size-4 shrink-0" aria-hidden="true" />
				<span
					className="min-w-0 truncate font-mono text-xs"
					title={node.path}
				>
					{node.name}
				</span>
				{badge ? (
					<span className="ml-auto shrink-0">{badge}</span>
				) : null}
			</li>
		);
	}

	const expanded = context.isExpanded(node.path, depth);
	const radioId = `${id}-radio`;
	// Children are judged on their own paths; this only tells them which
	// skipped folder, and rule, they sit in.
	const childAncestor = row
		? excludedAncestorForChildren(row, node.path, excludedAncestor)
		: null;
	return (
		<li>
			<Collapsible
				open={expanded}
				onOpenChange={() => context.toggle(node.path)}
			>
				<div className="flex min-w-0 items-center gap-2 py-0.5">
					<CollapsibleTrigger asChild>
						<button
							type="button"
							aria-label={node.name}
							className="rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						>
							<ChevronRightIcon
								className={cn(
									"size-4 transition-transform",
									expanded && "rotate-90",
								)}
								aria-hidden="true"
							/>
						</button>
					</CollapsibleTrigger>
					<RadioGroupItem
						id={radioId}
						value={node.path}
						aria-label={node.path}
					/>
					<FolderIcon
						className="size-4 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					<label
						htmlFor={radioId}
						className="min-w-0 truncate font-mono text-xs"
						title={node.path}
					>
						{node.name}
					</label>
					{row && row.kind !== "outside" && context.exclusions ? (
						<span className="ml-auto flex shrink-0 items-center gap-2">
							{badge}
							<ExclusionToggle
								node={node}
								row={row}
								exclusions={context.exclusions}
								causeId={causeId}
							/>
						</span>
					) : null}
				</div>
				<CollapsibleContent>
					<ul className="flex flex-col pl-4">
						{node.children.map((child) => (
							<TreeRow
								key={child.path}
								node={child}
								depth={depth + 1}
								excludedAncestor={childAncestor}
								context={context}
							/>
						))}
					</ul>
				</CollapsibleContent>
			</Collapsible>
		</li>
	);
}
