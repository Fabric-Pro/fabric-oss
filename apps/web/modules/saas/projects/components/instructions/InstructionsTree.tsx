"use client";

import { Input } from "@ui/components/input";
import {
	ChevronDownIcon,
	ChevronRightIcon,
	FileIcon,
	FolderIcon,
	SearchIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

export type TreeFile = {
	id: string;
	path: string;
	kind: string;
	name: string | null;
	description: string | null;
	size: number;
	mimeType: string;
	isText: boolean;
	mode: number | null;
};

type Node = {
	name: string;
	path: string;
	children: Map<string, Node>;
	file?: TreeFile;
	count: number;
};

function buildTree(files: TreeFile[]): Node {
	const root: Node = { name: "", path: "", children: new Map(), count: 0 };
	for (const f of files) {
		let node = root;
		const segs = f.path.split("/");
		segs.forEach((seg, i) => {
			node.count += 1;
			const path = segs.slice(0, i + 1).join("/");
			let child = node.children.get(seg);
			if (!child) {
				child = { name: seg, path, children: new Map(), count: 0 };
				node.children.set(seg, child);
			}
			node = child;
		});
		node.file = f;
		node.count = 1;
	}
	return root;
}

function sortedChildren(n: Node): Node[] {
	return [...n.children.values()].sort(
		(a, b) =>
			(a.file ? 1 : 0) - (b.file ? 1 : 0) || a.name.localeCompare(b.name),
	);
}

/**
 * Renders the published snapshot's files exactly as they sit on disk —
 * folders collapsed by default, opened by click or by a search match. The
 * search box filters by path, name, and description at once so a skill's
 * frontmatter description is as searchable as its filename.
 */
export function InstructionsTree({
	files,
	selectedPath,
	onSelect,
}: {
	files: TreeFile[];
	selectedPath: string | null;
	onSelect: (path: string) => void;
}) {
	const t = useTranslations("projects.codingInstructions.tree");
	// Reuses `fileView.kindLabels` rather than a second copy of the same
	// kind → label map under a new namespace.
	const kindLabels = useTranslations(
		"projects.codingInstructions.fileView",
	).raw("kindLabels") as Record<string, string>;
	const [query, setQuery] = useState("");
	const [kindFilter, setKindFilter] = useState<string | null>(null);
	const [open, setOpen] = useState<Set<string>>(() => new Set());
	const kindsPresent = useMemo(
		() => [...new Set(files.map((f) => f.kind))].sort(),
		[files],
	);
	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		return files.filter((f) => {
			if (kindFilter && f.kind !== kindFilter) {
				return false;
			}
			if (!q) {
				return true;
			}
			return (
				f.path.toLowerCase().includes(q) ||
				f.name?.toLowerCase().includes(q) ||
				f.description?.toLowerCase().includes(q)
			);
		});
	}, [files, query, kindFilter]);
	const tree = useMemo(() => buildTree(visible), [visible]);
	// A kind filter narrows the tree the same way a text search does, so both
	// auto-expand every folder that still has a match rather than requiring
	// the user to also click open every ancestor folder by hand.
	const searching = query.trim().length > 0 || kindFilter !== null;

	const toggle = (path: string) =>
		setOpen((s) => {
			const n = new Set(s);
			if (n.has(path)) {
				n.delete(path);
			} else {
				n.add(path);
			}
			return n;
		});

	const renderNode = (node: Node, depth: number): React.ReactNode => {
		if (node.file) {
			const active = node.path === selectedPath;
			return (
				<button
					key={node.path}
					type="button"
					onClick={() => onSelect(node.path)}
					aria-current={active ? "true" : undefined}
					className={`flex w-full items-center gap-1.5 rounded-md px-2.5 py-1 text-left font-mono text-xs hover:bg-accent ${active ? "bg-accent font-medium" : ""}`}
					// Depth is unbounded (a tree can nest arbitrarily deep), so no
					// fixed Tailwind spacing scale can cover every level — the
					// indent has to be computed, not a class.
					style={{ paddingLeft: `${10 + depth * 16 + 17}px` }}
				>
					<FileIcon
						className="size-3.5 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					<span className="truncate">{node.name}</span>
				</button>
			);
		}
		const isOpen = searching || open.has(node.path);
		return (
			<div key={node.path}>
				<button
					type="button"
					onClick={() => toggle(node.path)}
					aria-expanded={isOpen}
					className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1 text-left font-mono text-xs hover:bg-accent"
					style={{ paddingLeft: `${10 + depth * 16}px` }}
				>
					{isOpen ? (
						<ChevronDownIcon
							className="size-3.5 shrink-0 text-muted-foreground"
							aria-hidden="true"
						/>
					) : (
						<ChevronRightIcon
							className="size-3.5 shrink-0 text-muted-foreground"
							aria-hidden="true"
						/>
					)}
					<FolderIcon
						className="size-3.5 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					<span className="truncate">{node.name}</span>
					<span className="ml-auto text-muted-foreground">
						{node.count}
					</span>
				</button>
				{isOpen
					? sortedChildren(node).map((c) => renderNode(c, depth + 1))
					: null}
			</div>
		);
	};

	return (
		<div className="flex h-full flex-col rounded-lg border border-border">
			<div className="flex flex-col gap-2 border-border border-b p-2.5">
				{/* Visual grouping only — the input below carries its own
				`aria-label`, so a `<label>` wrapper here would just be a
				second, unassociated label for the same control. */}
				<div className="flex h-9 items-center gap-2 rounded-md border border-input px-2.5 text-muted-foreground">
					<SearchIcon className="size-4" aria-hidden="true" />
					<Input
						type="search"
						aria-label={t("searchLabel")}
						placeholder={t("searchPlaceholder")}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						className="h-auto border-0 p-0 shadow-none focus-visible:ring-0"
					/>
				</div>
				{kindsPresent.length > 1 ? (
					/* Named by a visually-hidden <legend>, not `aria-label`:
					   both are valid accessible names for a <fieldset>, but
					   the repo already has this exact chip-group shape in
					   `qa-settings/QaCiSetupSection.tsx` and it uses a
					   <legend>. One pattern for one UI shape. */
					<fieldset className="flex flex-wrap gap-1.5 border-0 p-0 m-0">
						<legend className="sr-only">
							{t("kindFilterLabel")}
						</legend>
						<button
							type="button"
							aria-pressed={kindFilter === null}
							onClick={() => setKindFilter(null)}
							className={`rounded-full border px-2.5 py-1 font-medium text-xs ${kindFilter === null ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}
						>
							{t("allKinds")}
						</button>
						{kindsPresent.map((kind) => (
							<button
								key={kind}
								type="button"
								aria-pressed={kindFilter === kind}
								onClick={() => setKindFilter(kind)}
								className={`rounded-full border px-2.5 py-1 font-medium text-xs ${kindFilter === kind ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}
							>
								{kindLabels[kind] ?? kind}
							</button>
						))}
					</fieldset>
				) : null}
			</div>
			<div className="flex flex-col gap-px overflow-auto p-2">
				{sortedChildren(tree).map((c) => renderNode(c, 0))}
			</div>
		</div>
	);
}
