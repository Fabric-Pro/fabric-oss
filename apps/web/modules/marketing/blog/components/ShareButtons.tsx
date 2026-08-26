"use client";

import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { CheckIcon, LinkIcon } from "lucide-react";
import { useState } from "react";

interface ShareButtonsProps {
	title: string;
	url: string;
	tags?: string[];
	description?: string;
}

// Custom Twitter/X icon
function XIcon({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 24 24"
			className={className}
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
		</svg>
	);
}

// Custom LinkedIn icon
function LinkedInIcon({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 24 24"
			className={className}
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
		</svg>
	);
}

export function ShareButtons({
	title,
	url,
	tags = [],
	description,
}: ShareButtonsProps) {
	const [copied, setCopied] = useState(false);

	// Build hashtags string for Twitter
	const hashtags = tags.map((tag) => tag.replace(/\s+/g, "")).join(",");

	// Twitter share URL
	const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}${hashtags ? `&hashtags=${encodeURIComponent(hashtags)}` : ""}`;

	// LinkedIn share URL - using shareArticle endpoint which is more reliable
	const linkedInUrl = `https://www.linkedin.com/shareArticle?mini=true&url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}${description ? `&summary=${encodeURIComponent(description)}` : ""}`;

	const copyToClipboard = async () => {
		try {
			await navigator.clipboard.writeText(url);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch (err) {
			console.error("Failed to copy:", err);
		}
	};

	return (
		<TooltipProvider>
			<div className="flex items-center gap-2">
				<span className="text-muted-foreground text-sm">Share:</span>

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="size-9"
							asChild
						>
							<a
								href={twitterUrl}
								target="_blank"
								rel="noopener noreferrer"
								aria-label="Share on X (Twitter)"
							>
								<XIcon className="size-4" />
							</a>
						</Button>
					</TooltipTrigger>
					<TooltipContent>Share on X</TooltipContent>
				</Tooltip>

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="size-9"
							asChild
						>
							<a
								href={linkedInUrl}
								target="_blank"
								rel="noopener noreferrer"
								aria-label="Share on LinkedIn"
							>
								<LinkedInIcon className="size-4" />
							</a>
						</Button>
					</TooltipTrigger>
					<TooltipContent>Share on LinkedIn</TooltipContent>
				</Tooltip>

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="size-9"
							onClick={copyToClipboard}
							aria-label="Copy link"
						>
							{copied ? (
								<CheckIcon className="size-4 text-green-500" />
							) : (
								<LinkIcon className="size-4" />
							)}
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						{copied ? "Copied!" : "Copy link"}
					</TooltipContent>
				</Tooltip>
			</div>
		</TooltipProvider>
	);
}
