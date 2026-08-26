import { cn } from "@ui/lib";
import type { ReactNode } from "react";

export function SidebarContentLayout({
	children,
	sidebar,
	sidebarClassName,
	className,
	noGap = false,
}: {
	children: React.ReactNode;
	sidebar: ReactNode;
	sidebarClassName?: string;
	className?: string;
	noGap?: boolean;
}) {
	return (
		<div className={cn("relative", className)}>
			<div
				className={cn(
					"flex flex-col items-start lg:flex-row h-full",
					noGap ? "gap-0" : "gap-4 lg:gap-6",
				)}
			>
				{sidebar && (
					<div
						className={cn(
							"w-full lg:max-w-[190px] shrink-0 h-full",
							sidebarClassName,
						)}
					>
						{sidebar}
					</div>
				)}
				<div className="w-full max-w-full min-w-0 flex-1 h-full overflow-hidden">
					{children}
				</div>
			</div>
		</div>
	);
}
