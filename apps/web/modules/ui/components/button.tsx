"use client";

import { Slot } from "@radix-ui/react-slot";
import { cn } from "@ui/lib";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

const buttonVariants = cva(
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors duration-150 cursor-pointer disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 aria-invalid:border-destructive focus-visible:aria-invalid:ring-destructive",
	{
		variants: {
			variant: {
				default:
					"bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active",
				primary:
					"bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active",
				destructive:
					"bg-destructive text-destructive-foreground hover:bg-destructive-hover active:bg-destructive-active focus-visible:ring-destructive",
				error: "bg-destructive text-destructive-foreground hover:bg-destructive-hover active:bg-destructive-active focus-visible:ring-destructive",
				outline:
					"border border-input bg-background text-foreground hover:bg-muted hover:border-muted-foreground active:bg-accent dark:bg-card dark:hover:bg-accent dark:active:bg-accent/80",
				secondary:
					"border border-border bg-secondary text-secondary-foreground hover:bg-accent active:bg-accent/80",
				ghost: "hover:bg-muted hover:text-foreground active:bg-accent dark:hover:bg-accent/50 dark:active:bg-accent/80",
				link: "text-primary underline-offset-4 hover:underline",
				light: "bg-background border border-border hover:bg-muted hover:border-primary/20 dark:bg-card dark:border-input dark:hover:bg-accent",
				/** Editorial style — matches marketing page CTA: bordered rectangle, uppercase tracking */
				editorial:
					"border border-primary bg-transparent text-primary hover:bg-primary hover:text-primary-foreground font-sans text-[11px] uppercase tracking-[0.2em] rounded-none h-auto px-8 py-3",
				"editorial-ghost":
					"border border-border bg-transparent text-foreground hover:border-primary/40 hover:text-primary font-sans text-[11px] uppercase tracking-[0.2em] rounded-none h-auto px-8 py-3",
			},
			size: {
				default: "h-9 px-3.5 py-2 has-[>svg]:px-3",
				xs: "h-7 rounded-md gap-1 px-2.5 text-xs has-[>svg]:px-2",
				sm: "h-8 rounded-md gap-1.5 px-3 text-xs has-[>svg]:px-2.5",
				lg: "h-10 rounded-md px-5 has-[>svg]:px-4",
				icon: "size-9",
				"icon-sm": "size-8",
				"icon-lg": "size-10",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (typeof value === "object" && value !== null && "then" in value) ||
		typeof value === "function"
		? typeof (value as { then?: unknown }).then === "function"
		: false;
}

type ButtonClickHandler = (
	event: React.MouseEvent<HTMLButtonElement, MouseEvent>,
) => unknown;

function Button({
	className,
	variant,
	size,
	asChild = false,
	loading = false,
	autoLoading = true,
	children,
	disabled,
	onClick,
	...props
}: Omit<React.ComponentProps<"button">, "onClick"> &
	VariantProps<typeof buttonVariants> & {
		asChild?: boolean;
		loading?: boolean;
		autoLoading?: boolean;
		onClick?: ButtonClickHandler;
	}) {
	const Comp = asChild ? Slot : "button";
	const [isAutoLoading, setIsAutoLoading] = React.useState(false);
	const isMountedRef = React.useRef(true);

	React.useEffect(() => {
		// Strict Mode replays setup after cleanup without replacing this ref.
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	const isLoading = loading || isAutoLoading;

	const handleClick = (
		event: React.MouseEvent<HTMLButtonElement, MouseEvent>,
	) => {
		if (disabled || loading || isAutoLoading) {
			return;
		}
		if (!onClick) {
			return;
		}

		if (!autoLoading) {
			onClick(event);
			return;
		}

		const result = onClick(event);
		if (event.defaultPrevented) {
			return;
		}

		// If handler returns a promise, keep loading until it settles.
		if (isPromiseLike(result)) {
			setIsAutoLoading(true);
			Promise.resolve(result).finally(() => {
				if (isMountedRef.current) {
					setIsAutoLoading(false);
				}
			});
		}
	};

	return (
		<Comp
			data-slot="button"
			className={cn(buttonVariants({ variant, size, className }))}
			disabled={disabled || isLoading}
			onClick={handleClick}
			{...props}
		>
			{isLoading ? (
				<>
					<svg
						className="animate-spin size-4"
						xmlns="http://www.w3.org/2000/svg"
						fill="none"
						viewBox="0 0 24 24"
						aria-hidden="true"
					>
						<circle
							className="opacity-25"
							cx="12"
							cy="12"
							r="10"
							stroke="currentColor"
							strokeWidth="4"
						/>
						<path
							className="opacity-75"
							fill="currentColor"
							d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
						/>
					</svg>
					{children}
				</>
			) : (
				children
			)}
		</Comp>
	);
}

export { Button, buttonVariants };
