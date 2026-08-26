"use client";

import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { cn } from "@ui/lib";
import { ChevronRightIcon } from "lucide-react";
import * as React from "react";

const ContextMenu = ContextMenuPrimitive.Root;

const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

const ContextMenuSub = ContextMenuPrimitive.Sub;

const ContextMenuSubTrigger = ({
	className,
	inset,
	children,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
	inset?: boolean;
}) => (
	<ContextMenuPrimitive.SubTrigger
		className={cn(
			"flex cursor-default select-none items-center rounded-md px-3 py-1.5 text-sm outline-hidden focus:bg-accent data-[state=open]:bg-accent",
			inset ? "pl-8" : "",
			className,
		)}
		{...props}
	>
		{children}
		<ChevronRightIcon className="ml-auto size-4" />
	</ContextMenuPrimitive.SubTrigger>
);

const ContextMenuSubContent = ({
	className,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) => (
	<ContextMenuPrimitive.SubContent
		className={cn(
			"data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-lg data-[state=closed]:animate-out data-[state=open]:animate-in",
			className,
		)}
		{...props}
	/>
);

const ContextMenuContent = ({
	className,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) => (
	<ContextMenuPrimitive.Portal>
		<ContextMenuPrimitive.Content
			className={cn(
				"z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-lg",
				"data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=open]:animate-in",
				className,
			)}
			{...props}
		/>
	</ContextMenuPrimitive.Portal>
);

const ContextMenuItem = ({
	className,
	inset,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
	inset?: boolean;
}) => (
	<ContextMenuPrimitive.Item
		className={cn(
			"relative flex cursor-default select-none items-center rounded-md px-3 py-2 text-sm outline-hidden transition-colors focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
			inset ? "pl-8" : "",
			className,
		)}
		{...props}
	/>
);

const ContextMenuLabel = ({
	className,
	inset,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
	inset?: boolean;
}) => (
	<ContextMenuPrimitive.Label
		className={cn(
			"px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground",
			inset ? "pl-8" : "",
			className,
		)}
		{...props}
	/>
);

const ContextMenuSeparator = ({
	className,
	...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) => (
	<ContextMenuPrimitive.Separator
		className={cn("-mx-1 my-1 h-px bg-border", className)}
		{...props}
	/>
);

export {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
};
