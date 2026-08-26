"use client";

import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { ScrollArea } from "@ui/components/scroll-area";
import { cn } from "@ui/lib";
import { CheckCircle2Icon, ChevronDownIcon, CircleIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

// Main Queue container
export type QueueProps = ComponentProps<"div">;

export const Queue = ({ className, ...props }: QueueProps) => (
	<div className={cn("space-y-2", className)} {...props} />
);

// Queue section (collapsible group)
export type QueueSectionProps = ComponentProps<typeof Collapsible>;

export const QueueSection = ({
	className,
	defaultOpen = true,
	...props
}: QueueSectionProps) => (
	<Collapsible
		className={cn("rounded-lg border bg-card", className)}
		defaultOpen={defaultOpen}
		{...props}
	/>
);

// Queue section trigger
export type QueueSectionTriggerProps = ComponentProps<
	typeof CollapsibleTrigger
>;

export const QueueSectionTrigger = ({
	className,
	...props
}: QueueSectionTriggerProps) => (
	<CollapsibleTrigger
		className={cn(
			"flex w-full items-center justify-between p-3 hover:bg-muted/50 transition-colors group",
			className,
		)}
		{...props}
	/>
);

// Queue section label
export type QueueSectionLabelProps = ComponentProps<"div"> & {
	label: string;
	count?: number;
	icon?: ReactNode;
};

export const QueueSectionLabel = ({
	className,
	label,
	count,
	icon,
	...props
}: QueueSectionLabelProps) => (
	<div className={cn("flex items-center gap-2", className)} {...props}>
		{icon}
		<span className="font-medium text-sm">{label}</span>
		{count !== undefined && (
			<span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
				{count}
			</span>
		)}
		<ChevronDownIcon className="h-4 w-4 text-muted-foreground ml-auto transition-transform group-data-[state=open]:rotate-180" />
	</div>
);

// Queue section content
export type QueueSectionContentProps = ComponentProps<
	typeof CollapsibleContent
>;

export const QueueSectionContent = ({
	className,
	...props
}: QueueSectionContentProps) => (
	<CollapsibleContent className={cn("border-t", className)} {...props} />
);

// Queue list with scroll area
export type QueueListProps = ComponentProps<typeof ScrollArea> & {
	maxHeight?: string;
};

export const QueueList = ({
	className,
	maxHeight = "300px",
	children,
	...props
}: QueueListProps) => (
	<ScrollArea
		className={cn("p-2", className)}
		style={{ maxHeight }}
		{...props}
	>
		<div className="space-y-1">{children}</div>
	</ScrollArea>
);

// Queue item
export type QueueItemProps = ComponentProps<"div"> & {
	isCompleted?: boolean;
};

export const QueueItem = ({
	className,
	isCompleted,
	...props
}: QueueItemProps) => (
	<div
		className={cn(
			"flex items-start gap-2 p-2 rounded-md hover:bg-muted/50 transition-colors group",
			isCompleted && "opacity-60",
			className,
		)}
		{...props}
	/>
);

// Queue item indicator
export type QueueItemIndicatorProps = ComponentProps<"div"> & {
	isCompleted?: boolean;
};

export const QueueItemIndicator = ({
	className,
	isCompleted,
	...props
}: QueueItemIndicatorProps) => (
	<div className={cn("mt-0.5 flex-shrink-0", className)} {...props}>
		{isCompleted ? (
			<CheckCircle2Icon className="h-4 w-4 text-green-500" />
		) : (
			<CircleIcon className="h-4 w-4 text-muted-foreground" />
		)}
	</div>
);

// Queue item content
export type QueueItemContentProps = ComponentProps<"div">;

export const QueueItemContent = ({
	className,
	...props
}: QueueItemContentProps) => (
	<div className={cn("flex-1 min-w-0", className)} {...props} />
);

// Queue item description
export type QueueItemDescriptionProps = ComponentProps<"p">;

export const QueueItemDescription = ({
	className,
	...props
}: QueueItemDescriptionProps) => (
	<p
		className={cn("text-xs text-muted-foreground truncate", className)}
		{...props}
	/>
);
