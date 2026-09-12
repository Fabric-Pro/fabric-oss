import { Slot } from "@radix-ui/react-slot";
import { cn } from "@ui/lib";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

const badgeVariants = cva(
	"inline-flex items-center justify-center rounded-[4px] border px-2 py-0.5 font-mono text-[10.5px] font-normal w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-colors duration-150 overflow-hidden",
	{
		variants: {
			variant: {
				default:
					"border-transparent bg-primary/10 text-primary dark:bg-primary/20 [a&]:hover:bg-primary/20 dark:[a&]:hover:bg-primary/30",
				// `secondary` is a surface token (light grey / charcoal), so text in
				// that colour on a tint of itself was invisible in both themes.
				// Solid surface with its paired foreground instead.
				secondary:
					"border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/80",
				destructive:
					"border-transparent bg-destructive/10 text-destructive dark:bg-destructive/20 [a&]:hover:bg-destructive/20 dark:[a&]:hover:bg-destructive/30 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
				outline:
					"text-foreground border-border/50 [a&]:hover:bg-accent [a&]:hover:text-accent-foreground [a&]:hover:border-accent-foreground/20",
				info: "border-border bg-transparent text-muted-foreground [a&]:hover:bg-muted",
				success:
					"border-[color-mix(in_srgb,var(--success)_35%,transparent)] bg-transparent text-success",
				warning:
					"border-[color-mix(in_srgb,var(--fab-warn)_35%,transparent)] bg-transparent text-[var(--fab-warn)]",
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
