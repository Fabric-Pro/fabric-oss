import { getAvatarInitials } from "@shared/lib/avatar-initials";
import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { cn } from "@ui/lib";
import type { UIMessage } from "ai";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps, HTMLAttributes } from "react";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
	from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
	<div
		className={cn(
			"group flex w-full max-w-full min-w-0 items-start gap-2.5 py-2.5",
			from === "user"
				? "is-user flex-row-reverse justify-start"
				: "is-assistant justify-start",
			className,
		)}
		{...props}
	/>
);

const messageContentVariants = cva(
	"is-user:dark flex flex-col gap-2 overflow-hidden text-sm leading-6 [&_*]:text-inherit break-words min-w-0",
	{
		variants: {
			variant: {
				contained: [
					// User bubble – Databricks Genie soft rounded pill, right-aligned
					"group-[.is-user]:max-w-[75%] group-[.is-user]:rounded-2xl group-[.is-user]:border group-[.is-user]:border-primary/15 group-[.is-user]:bg-primary/[0.08] dark:group-[.is-user]:bg-primary/[0.15] group-[.is-user]:px-4 group-[.is-user]:py-2.5 group-[.is-user]:text-foreground",
					// Assistant bubble – clean Genie full-width response
					"group-[.is-assistant]:w-full group-[.is-assistant]:rounded-xl group-[.is-assistant]:bg-card group-[.is-assistant]:text-card-foreground",
				],
				flat: [
					"group-[.is-user]:max-w-[75%] group-[.is-user]:rounded-2xl group-[.is-user]:border group-[.is-user]:border-primary/15 group-[.is-user]:bg-primary/[0.08] dark:group-[.is-user]:bg-primary/[0.15] group-[.is-user]:px-4 group-[.is-user]:py-2.5 group-[.is-user]:text-foreground",
					"group-[.is-assistant]:w-full group-[.is-assistant]:text-foreground",
				],
			},
		},
		defaultVariants: {
			variant: "contained",
		},
	},
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement> &
	VariantProps<typeof messageContentVariants>;

export const MessageContent = ({
	children,
	className,
	variant,
	...props
}: MessageContentProps) => (
	<div
		className={cn(messageContentVariants({ variant, className }))}
		{...props}
	>
		{children}
	</div>
);

export type MessageAvatarProps = ComponentProps<typeof Avatar> & {
	src: string;
	name?: string;
};

export const MessageAvatar = ({
	src,
	name,
	className,
	...props
}: MessageAvatarProps) => (
	<Avatar
		className={cn(
			"size-7 ring-1 ring-border group-[.is-user]:hidden",
			className,
		)}
		{...props}
	>
		<AvatarImage alt="" className="mt-0 mb-0" src={src} />
		<AvatarFallback>{getAvatarInitials(name, "ME")}</AvatarFallback>
	</Avatar>
);
