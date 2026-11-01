import { cn } from "@ui/lib";
import * as React from "react";

const Textarea = ({
	className,
	...props
}: React.ComponentProps<"textarea">) => {
	return (
		<textarea
			className={cn(
				"flex min-h-[80px] w-full rounded-md bg-background border border-input px-3 py-2 text-base md:text-sm text-foreground transition-colors duration-150 placeholder:text-muted-foreground hover:border-muted-foreground focus-visible:outline-hidden focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring aria-invalid:border-destructive focus-visible:aria-invalid:border-destructive focus-visible:aria-invalid:ring-destructive disabled:border-input disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	);
};

export { Textarea };
