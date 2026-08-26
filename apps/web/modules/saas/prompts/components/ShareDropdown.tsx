"use client";

import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Share2 } from "lucide-react";

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

function HackerNewsIcon({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 24 24"
			className={className}
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M0 0v24h24V0H0zm12.3 13.27V18.5h-.8v-5.23L7.7 6.5h.9l3.1 5.37 3.1-5.37h.9l-3.4 6.77z" />
		</svg>
	);
}

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

interface ShareDropdownProps {
	title: string;
	url?: string;
}

export function ShareDropdown({ title, url }: ShareDropdownProps) {
	const handleShare = (platform: "twitter" | "hackernews" | "linkedin") => {
		const shareUrl =
			url || (typeof window !== "undefined" ? window.location.href : "");
		const encodedUrl = encodeURIComponent(shareUrl);
		const encodedTitle = encodeURIComponent(`${title} Prompt`);

		let targetUrl = "";

		switch (platform) {
			case "twitter":
				targetUrl = `https://twitter.com/intent/tweet?text=${encodedTitle}&url=${encodedUrl}`;
				break;
			case "hackernews":
				targetUrl = `https://news.ycombinator.com/submitlink?u=${encodedUrl}&t=${encodedTitle}`;
				break;
			case "linkedin":
				targetUrl = `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`;
				break;
		}

		window.open(targetUrl, "_blank", "noopener,noreferrer");
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="sm">
					<Share2 className="h-4 w-4" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onClick={() => handleShare("twitter")}>
					<XIcon className="h-4 w-4 mr-2" />X / Twitter
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => handleShare("hackernews")}>
					<HackerNewsIcon className="h-4 w-4 mr-2" />
					Hacker News
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => handleShare("linkedin")}>
					<LinkedInIcon className="h-4 w-4 mr-2" />
					LinkedIn
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
