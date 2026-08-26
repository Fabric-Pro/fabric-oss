"use client";

import { LocaleLink } from "@i18n/routing";
import type { Post } from "@marketing/blog/types";
import { generatePostImage } from "@marketing/blog/utils/generatePostImage";
import { CalendarIcon, ClockIcon, TagIcon } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";

interface PostListItemProps {
	post: Post;
}

export function PostListItem({ post }: PostListItemProps) {
	const router = useRouter();
	const {
		title,
		excerpt,
		authorName,
		image,
		date,
		path,
		authorImage,
		authorLink,
		tags,
	} = post;

	// Generate dynamic image if no image is provided
	const postImage = image || generatePostImage(title, tags || []);

	// Handle tag click to filter blog list
	const handleTagClick = (e: React.MouseEvent, tag: string) => {
		e.preventDefault();
		e.stopPropagation();
		router.push(`/blog?tag=${encodeURIComponent(tag)}`);
	};

	// Format date safely
	const formatDate = (dateString: string) => {
		try {
			const parsedDate = new Date(
				dateString.includes("T")
					? dateString
					: `${dateString}T00:00:00`,
			);
			if (Number.isNaN(parsedDate.getTime())) {
				return dateString;
			}
			return new Intl.DateTimeFormat("en-US", {
				year: "numeric",
				month: "long",
				day: "numeric",
			}).format(parsedDate);
		} catch {
			return dateString;
		}
	};

	const formattedDate = formatDate(date);

	// Calculate reading time (rough estimate: 200 words per minute)
	const wordCount = excerpt ? excerpt.split(" ").length : 0;
	const readingTime = Math.max(1, Math.ceil(wordCount / 200));

	return (
		<div className="group flex flex-col overflow-hidden rounded-2xl border bg-card/50 transition-all hover:border-primary/50 hover:shadow-lg">
			{/* Image */}
			<div className="relative aspect-video w-full overflow-hidden">
				<Image
					src={postImage}
					alt={title}
					fill
					sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
					className="object-cover object-center transition-transform group-hover:scale-105"
					unoptimized={!image} // Don't optimize generated SVG images
				/>
				<LocaleLink
					href={`/blog/${path}`}
					className="absolute inset-0"
				/>
			</div>

			{/* Content */}
			<div className="flex flex-1 flex-col p-6">
				{/* Tags */}
				{tags && tags.length > 0 && (
					<div className="mb-3 flex flex-wrap gap-2">
						{tags.slice(0, 2).map((tag: string) => (
							<button
								key={tag}
								type="button"
								onClick={(e) => handleTagClick(e, tag)}
								className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 font-medium text-primary text-xs transition-colors hover:bg-primary/20"
							>
								<TagIcon className="size-3" />
								{tag}
							</button>
						))}
						{tags.length > 2 && (
							<span className="text-muted-foreground text-xs">
								+{tags.length - 2} more
							</span>
						)}
					</div>
				)}

				{/* Title */}
				<LocaleLink
					href={`/blog/${path}`}
					className="mb-2 font-bold text-xl transition-colors line-clamp-2 group-hover:text-primary"
				>
					{title}
				</LocaleLink>

				{/* Excerpt */}
				{excerpt && (
					<p className="mb-4 line-clamp-3 text-muted-foreground text-sm">
						{excerpt}
					</p>
				)}

				{/* Meta */}
				<div className="mt-auto flex flex-col gap-3 border-t pt-4">
					{authorName && (
						<div className="flex items-center gap-2">
							{authorImage && (
								<div className="relative size-8 overflow-hidden rounded-full">
									<Image
										src={authorImage}
										alt={authorName}
										fill
										sizes="32px"
										className="object-cover object-center"
									/>
								</div>
							)}
							{authorLink ? (
								<a
									href={authorLink}
									target="_blank"
									rel="noopener noreferrer"
									className="font-medium text-muted-foreground text-sm transition-colors hover:text-primary"
								>
									{authorName}
								</a>
							) : (
								<span className="font-medium text-muted-foreground text-sm">
									{authorName}
								</span>
							)}
						</div>
					)}

					<div className="flex items-center justify-between text-muted-foreground text-xs">
						<div className="flex items-center gap-1">
							<CalendarIcon className="size-3" />
							<span>{formattedDate}</span>
						</div>
						<div className="flex items-center gap-1">
							<ClockIcon className="size-3" />
							<span>{readingTime} min read</span>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
