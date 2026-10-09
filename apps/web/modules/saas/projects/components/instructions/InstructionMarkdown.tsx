"use client";

import { remarkHideHtmlComments } from "@saas/projects/lib/remark-hide-html-comments";
import { Markdown } from "@ui/components/markdown";
import { type MouseEvent, useMemo } from "react";
import type { Components } from "react-markdown";
import {
	instructionPathOf,
	type RepositoryLinks,
	repositoryWebUrl,
	resolveInstructionLink,
} from "./instruction-links";

/**
 * The viewer's body scrolls as a whole and wraps anywhere, which crushes a
 * wide table into the column and clips a long code line. Tables scroll
 * horizontally once their columns cannot each keep a readable width, a narrow
 * prose table wraps, and cells break only between words. Ligatures are off so
 * the text of a file reads as written: `-->` stays three characters.
 */
const MARKDOWN_VIEW_CLASS =
	"[font-variant-ligatures:none] [&_pre]:overflow-x-auto [&_pre]:[overflow-wrap:normal] [&_table]:w-full [&_td]:min-w-32 [&_td]:[overflow-wrap:normal] [&_td]:[word-break:normal] [&_th]:min-w-32 [&_th]:[overflow-wrap:normal] [&_th]:[word-break:normal]";

const EXTERNAL_LINK = { target: "_blank", rel: "noopener noreferrer" } as const;

/**
 * An instruction file's text. A link in it is read from the file that holds
 * it: a relative one opens the instruction file it names in this view, or the
 * file in the repository at the ref on screen, and an address elsewhere opens
 * in a new tab. A link with nowhere to go (a file outside the instructions of
 * an uploaded version) reads as plain text rather than as a broken one.
 */
export function InstructionMarkdown({
	children,
	path,
	existingPaths,
	repositoryLinks,
	onOpenPath,
}: {
	children: string;
	/** The file the text belongs to; relative links start from its folder. */
	path: string;
	existingPaths?: ReadonlySet<string>;
	repositoryLinks?: RepositoryLinks | null;
	/** Opens an instruction file in this view; absent where the view cannot. */
	onOpenPath?: (path: string) => void;
}) {
	const components = useMemo<Components>(
		() => ({
			table: ({ node: _node, ...props }) => (
				<div className="max-w-full overflow-x-auto">
					<table {...props} />
				</div>
			),
			a: ({ node: _node, href, children: label, ...props }) => {
				if (!href) {
					return <span>{label}</span>;
				}
				const rootPath = repositoryLinks?.rootPath ?? "";
				const link = resolveInstructionLink(href, path, rootPath);
				if (link.kind === "external") {
					return (
						<a {...props} href={href} {...EXTERNAL_LINK}>
							{label}
						</a>
					);
				}
				const repoPath =
					link.kind === "anchor"
						? [rootPath, path].filter(Boolean).join("/")
						: link.repoPath;
				const { hash } = link;
				const repositoryHref = repositoryLinks
					? `${repositoryWebUrl(repositoryLinks, repoPath)}${hash}`
					: null;
				const instructionPath =
					link.kind === "path"
						? instructionPathOf(link.repoPath, rootPath)
						: null;
				if (
					instructionPath !== null &&
					onOpenPath &&
					existingPaths?.has(instructionPath)
				) {
					return (
						<a
							{...props}
							href={
								repositoryHref ??
								`#${encodeURI(instructionPath)}`
							}
							onClick={(event: MouseEvent<HTMLAnchorElement>) => {
								const modified =
									event.metaKey ||
									event.ctrlKey ||
									event.shiftKey ||
									event.altKey;
								if (modified && repositoryHref) {
									return;
								}
								event.preventDefault();
								onOpenPath(instructionPath);
							}}
						>
							{label}
						</a>
					);
				}
				if (repositoryHref) {
					return (
						<a {...props} href={repositoryHref} {...EXTERNAL_LINK}>
							{label}
						</a>
					);
				}
				return <span>{label}</span>;
			},
		}),
		[path, existingPaths, repositoryLinks, onOpenPath],
	);
	return (
		<Markdown
			className={MARKDOWN_VIEW_CLASS}
			components={components}
			remarkPlugins={[remarkHideHtmlComments]}
		>
			{children}
		</Markdown>
	);
}
