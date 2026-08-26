import { Slot } from "@radix-ui/react-slot";
import { cn } from "@ui/lib";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

const badgeVariants = cva(
	"inline-flex items-center justify-center rounded-sm border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-colors duration-150 overflow-hidden",
	{
		variants: {
			variant: {
				default:
					"border-transparent bg-primary/10 text-primary dark:bg-primary/20 [a&]:hover:bg-primary/20 dark:[a&]:hover:bg-primary/30",
				secondary:
					"border-transparent bg-secondary/10 text-secondary dark:bg-secondary/20 [a&]:hover:bg-secondary/20 dark:[a&]:hover:bg-secondary/30",
				destructive:
					"border-transparent bg-destructive/10 text-destructive dark:bg-destructive/20 [a&]:hover:bg-destructive/20 dark:[a&]:hover:bg-destructive/30 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
				outline:
					"text-foreground border-border/50 [a&]:hover:bg-accent [a&]:hover:text-accent-foreground [a&]:hover:border-accent-foreground/20",
				info: "border-transparent bg-blue-500/10 text-blue-600 dark:text-blue-400 dark:bg-blue-500/20 [a&]:hover:bg-blue-500/20 dark:[a&]:hover:bg-blue-500/30",
				success:
					"border-transparent bg-success/10 text-success dark:bg-success/20 [a&]:hover:bg-success/20 dark:[a&]:hover:bg-success/30",
				warning:
					"border-transparent bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 dark:bg-yellow-500/20 [a&]:hover:bg-yellow-500/20 dark:[a&]:hover:bg-yellow-500/30",
				error: "border-transparent bg-destructive/10 text-destructive dark:bg-destructive/20 [a&]:hover:bg-destructive/20 dark:[a&]:hover:bg-destructive/30",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

export type BadgeProps = React.ComponentProps<"span"> &
	VariantProps<typeof badgeVariants> & {
		asChild?: boolean;
		status?:
			| "info"
			| "success"
			| "warning"
			| "error"
			| "default"
			| "secondary"
			| "destructive"
			| "outline";
	};

function Badge({
	className,
	variant,
	status,
	asChild = false,
	...props
}: BadgeProps) {
	const Comp = asChild ? Slot : "span";

	// If status is provided, use it as variant
	const effectiveVariant = status || variant;

	return (
		<Comp
			data-slot="badge"
			className={cn(
				badgeVariants({ variant: effectiveVariant }),
				className,
			)}
			{...props}
		/>
	);
}

export { Badge };
