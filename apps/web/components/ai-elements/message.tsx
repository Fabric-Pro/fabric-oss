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
			"group flex w-full max-w-full min-w-0 items-start gap-3 py-3",
			from === "user"
				? "is-user flex-row-reverse justify-start"
				: "is-assistant justify-start",
			className,
		)}
		{...props}
	/>
);

const messageContentVariants = cva(
	"is-user:dark flex flex-col gap-2.5 overflow-hidden rounded-2xl text-[15px] leading-relaxed tracking-[0.01em] [&_*]:text-inherit break-words min-w-0",
	{
		variants: {
			variant: {
				contained: [
					"px-4 py-3",
					// User bubble – soft, high-contrast in both themes
					"group-[.is-user]:max-w-[75%] group-[.is-user]:bg-accent group-[.is-user]:text-accent-foreground",
					// Assistant bubble – card palette per theme, full width
					"group-[.is-assistant]:bg-card group-[.is-assistant]:text-card-foreground",
				],
				flat: [
					"group-[.is-user]:max-w-[75%] group-[.is-user]:bg-accent/80 group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-accent-foreground",
					"group-[.is-assistant]:text-foreground",
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
	<Avatar className={cn("size-8 ring-1 ring-border", className)} {...props}>
		<AvatarImage alt="" className="mt-0 mb-0" src={src} />
		<AvatarFallback>{name?.slice(0, 2) || "ME"}</AvatarFallback>
	</Avatar>
);
