"use client";

import { Button } from "@ui/components/button";
import { SearchInput } from "@ui/components/search-input";
import { SearchIcon, TagIcon, XIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import type { Post } from "../types";
import { PostListItem } from "./PostListItem";

interface BlogListClientProps {
	posts: Post[];
}

export function BlogListClient({ posts }: BlogListClientProps) {
	const [searchQuery, setSearchQuery] = useState("");
	const [showAllTags, setShowAllTags] = useState(false);
	const router = useRouter();
	const searchParams = useSearchParams();

	// Get tag filter from URL
	const activeTag = searchParams.get("tag");

	// Get deduplicated tags with usage count.
	const allTags = useMemo(() => {
		const normalizedToOriginal = new Map<string, string>();
		const tagCounts = new Map<string, number>();

		for (const post of posts) {
			for (const tag of post.tags) {
				const normalizedTag = tag.toLowerCase().trim();
				if (!normalizedTag) {
					continue;
				}
				if (!normalizedToOriginal.has(normalizedTag)) {
					normalizedToOriginal.set(normalizedTag, tag);
				}
				tagCounts.set(
					normalizedTag,
					(tagCounts.get(normalizedTag) ?? 0) + 1,
				);
			}
		}

		return Array.from(tagCounts.entries())
			.map(([normalizedTag, count]) => ({
				normalizedTag,
				tag: normalizedToOriginal.get(normalizedTag) ?? normalizedTag,
				count,
			}))
			.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
	}, [posts]);

	const INITIAL_VISIBLE_TAGS = 12;
	const visibleTags = useMemo(() => {
		if (showAllTags) {
			return allTags;
		}
		const initialTags = allTags.slice(0, INITIAL_VISIBLE_TAGS);
		const normalizedActiveTag = activeTag?.toLowerCase();
		if (
			normalizedActiveTag &&
			!initialTags.some(
				(entry) => entry.normalizedTag === normalizedActiveTag,
			)
		) {
			const activeTagEntry = allTags.find(
				(entry) => entry.normalizedTag === normalizedActiveTag,
			);
			if (activeTagEntry) {
				return [...initialTags, activeTagEntry];
			}
		}
		return initialTags;
	}, [showAllTags, allTags, activeTag]);

	// Handle tag selection
	const handleTagClick = useCallback(
		(tag: string) => {
			const params = new URLSearchParams(searchParams.toString());
			if (activeTag === tag) {
				params.delete("tag");
			} else {
				params.set("tag", tag);
			}
			router.push(
				`/blog${params.toString() ? `?${params.toString()}` : ""}`,
			);
		},
		[activeTag, router, searchParams],
	);

	// Clear tag filter
	const clearTagFilter = useCallback(() => {
		router.push("/blog");
	}, [router]);

	// Filter posts based on search query and tag
	// Memoized to avoid recomputing on every render
	// See: rerender-memo rule from Vercel React Best Practices
	const filteredPosts = useMemo(() => {
		return posts.filter((post) => {
			// First filter by tag if active
			if (
				activeTag &&
				!post.tags.some(
					(tag: string) =>
						tag.toLowerCase() === activeTag.toLowerCase(),
				)
			) {
				return false;
			}

			// Then filter by search query
			if (!searchQuery) {
				return true;
			}

			const query = searchQuery.toLowerCase();
			const titleMatch = post.title.toLowerCase().includes(query);
			const excerptMatch = post.excerpt?.toLowerCase().includes(query);
			const tagsMatch = post.tags.some((tag: string) =>
				tag.toLowerCase().includes(query),
			);

			return titleMatch || excerptMatch || tagsMatch;
		});
	}, [posts, activeTag, searchQuery]);

	return (
		<div className="space-y-8">
			{/* Search Box */}
			<div className="mx-auto max-w-2xl">
				<div className="relative">
					<SearchIcon className="-translate-y-1/2 absolute top-1/2 left-4 size-5 text-muted-foreground" />
					<SearchInput
						placeholder="Search posts by title, content, or tags..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="h-12 w-full pl-12 text-base"
					/>
				</div>

				{/* Results Count */}
				{(searchQuery || activeTag) && (
					<div className="mt-3 text-center text-muted-foreground text-sm">
						Found {filteredPosts.length} post
						{filteredPosts.length !== 1 ? "s" : ""}
						{searchQuery && ` matching "${searchQuery}"`}
						{activeTag && ` tagged with "${activeTag}"`}
					</div>
				)}
			</div>

			{/* Tag Filter Pills */}
			<div className="mx-auto max-w-4xl space-y-3">
				<div className="flex flex-wrap items-center justify-center gap-2">
					{activeTag && (
						<Button
							variant="ghost"
							size="sm"
							onClick={clearTagFilter}
							className="h-8 gap-1 text-muted-foreground"
						>
							<XIcon className="size-3" />
							Clear filter
						</Button>
					)}
					{visibleTags.map(({ tag, count }) => (
						<button
							key={tag}
							type="button"
							onClick={() => handleTagClick(tag)}
							className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
								activeTag === tag
									? "bg-primary text-primary-foreground"
									: "bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground"
							}`}
						>
							<TagIcon className="size-3" />
							{tag}
							<span className="text-xs opacity-70">{count}</span>
						</button>
					))}
				</div>
				{allTags.length > INITIAL_VISIBLE_TAGS && (
					<div className="flex justify-center">
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setShowAllTags((prev) => !prev)}
							className="h-8 text-muted-foreground"
						>
							{showAllTags
								? "Show fewer tags"
								: `Show all ${allTags.length} tags`}
						</Button>
					</div>
				)}
			</div>

			{/* Posts Grid (Tiles) */}
			{filteredPosts.length > 0 ? (
				<div className="grid gap-8 md:grid-cols-2 lg:grid-cols-3">
					{filteredPosts.map((post) => (
						<PostListItem post={post} key={post.path} />
					))}
				</div>
			) : (
				<div className="py-16 text-center">
					<div className="mb-4 text-6xl opacity-20">📝</div>
					<h3 className="mb-2 font-semibold text-xl">
						No posts found
					</h3>
					<p className="text-muted-foreground">
						{searchQuery
							? `No posts match "${searchQuery}". Try a different search term.`
							: "No blog posts available yet."}
					</p>
				</div>
			)}
		</div>
	);
}
