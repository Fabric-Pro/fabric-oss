import { Card } from "@ui/components/card";
import { cn } from "@ui/lib";
import type { PropsWithChildren, ReactNode } from "react";

export function SettingsItem({
	children,
	title,
	description,
	danger,
}: PropsWithChildren<{
	title: string | ReactNode;
	description?: string | ReactNode;
	danger?: boolean;
}>) {
	return (
		<Card className="@container rounded-md border p-4 md:p-6">
			<div className="grid grid-cols-1 gap-4 @-xl:grid-cols-[min(100%/3,280px)_auto] @xl:gap-6">
				<div className="flex shrink-0 flex-col gap-1.5">
					<h3
						className={cn(
							"m-0 text-sm font-medium leading-tight",
							danger && "text-destructive",
						)}
					>
						{title}
					</h3>
					{description && (
						<p className="m-0 text-muted-foreground text-xs sm:text-sm">
							{description}
						</p>
					)}
				</div>
				{children}
			</div>
		</Card>
	);
}
