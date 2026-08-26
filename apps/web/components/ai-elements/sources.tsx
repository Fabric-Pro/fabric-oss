"use client";

import { Button } from "@ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { cn } from "@ui/lib";
import { ExternalLinkIcon, FileTextIcon, LinkIcon } from "lucide-react";
import * as React from "react";

interface Source {
	id: string;
	title: string;
	url?: string;
	type?: "document" | "web" | "code" | "other";
	excerpt?: string;
	metadata?: Record<string, any>;
}

interface SourcesProps extends React.HTMLAttributes<HTMLDivElement> {
	sources: Source[];
	defaultOpen?: boolean;
}

export function Sources({
	sources,
	defaultOpen = false,
	className,
	...props
}: SourcesProps) {
	const [isOpen, setIsOpen] = React.useState(defaultOpen);

	if (!sources || sources.length === 0) {
		return null;
	}

	return (
		<Collapsible
			open={isOpen}
			onOpenChange={setIsOpen}
			className={cn("w-full", className)}
			{...props}
		>
			<CollapsibleTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className="w-full justify-between px-4 py-2 h-auto font-medium text-sm"
				>
					<span className="flex items-center gap-2">
						<FileTextIcon className="size-4" />
						Sources ({sources.length})
					</span>
					<svg
						className={cn(
							"size-4 transition-transform",
							isOpen && "rotate-180",
						)}
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<title>
							{isOpen ? "Collapse sources" : "Expand sources"}
						</title>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M19 9l-7 7-7-7"
						/>
					</svg>
				</Button>
			</CollapsibleTrigger>
			<CollapsibleContent className="px-4 py-2 space-y-2">
				{sources.map((source) => (
					<SourceItem key={source.id} source={source} />
				))}
			</CollapsibleContent>
		</Collapsible>
	);
}

interface SourceItemProps {
	source: Source;
}

function SourceItem({ source }: SourceItemProps) {
	const getIcon = () => {
		switch (source.type) {
			case "web":
				return <LinkIcon className="size-4 text-blue-500" />;
			case "document":
				return <FileTextIcon className="size-4 text-green-500" />;
			case "code":
				return <FileTextIcon className="size-4 text-purple-500" />;
			default:
				return (
					<FileTextIcon className="size-4 text-muted-foreground" />
				);
		}
	};

	return (
		<div className="rounded-lg border bg-card p-3 hover:bg-accent/50 transition-colors">
			<div className="flex items-start gap-3">
				<div className="mt-0.5">{getIcon()}</div>
				<div className="flex-1 min-w-0 space-y-1">
					<div className="flex items-start justify-between gap-2">
						<h4 className="font-medium text-sm leading-tight">
							{source.title}
						</h4>
						{source.url && (
							<a
								href={source.url}
								target="_blank"
								rel="noopener noreferrer"
								className="text-primary hover:text-primary/80 transition-colors shrink-0"
								onClick={(e) => e.stopPropagation()}
							>
								<ExternalLinkIcon className="size-3.5" />
							</a>
						)}
					</div>
					{source.excerpt && (
						<p className="text-xs text-muted-foreground line-clamp-2">
							{source.excerpt}
						</p>
					)}
					{source.metadata &&
						Object.keys(source.metadata).length > 0 && (
							<div className="flex flex-wrap gap-1 mt-1">
								{Object.entries(source.metadata)
									.slice(0, 3)
									.map(([key, value]) => (
										<span
											key={key}
											className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground"
										>
											{key}: {String(value)}
										</span>
									))}
							</div>
						)}
				</div>
			</div>
		</div>
	);
}
