import { cn } from "@ui/lib";
import React from "react";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
	({ className, type, ...props }, ref) => {
		return (
			<input
				type={type}
				ref={ref}
				className={cn(
					"flex h-9 w-full rounded-md bg-background border border-input px-3 py-1 text-base transition-colors file:border-0 file:bg-transparent file:font-medium file:text-sm placeholder:text-foreground/40 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:border-ring focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
					className,
				)}
				{...props}
			/>
		);
	},
);

Input.displayName = "Input";

export { Input };
