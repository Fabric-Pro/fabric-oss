"use client";

import { SidebarContentLayout } from "@saas/shared/components/SidebarContentLayout";
import { SidebarEdgeHandle } from "@saas/shared/components/SidebarEdgeHandle";
import { cn } from "@ui/lib";
import { type PropsWithChildren, useEffect, useState } from "react";
import { SettingsMenu, type SettingsMenuSection } from "./SettingsMenu";

const STORAGE_KEY = "fabric-settings-sidebar-collapsed";

export function SettingsSidebarLayout({
	children,
	menuItems,
}: PropsWithChildren<{
	menuItems: SettingsMenuSection[];
}>) {
	const [isCollapsed, setIsCollapsed] = useState(false);

	useEffect(() => {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (stored !== null) {
				setIsCollapsed(JSON.parse(stored));
			}
		} catch {
			// ignore persisted state failures
		}
	}, []);

	const toggleCollapsed = () => {
		setIsCollapsed((prev) => {
			const next = !prev;
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
			} catch {
				// ignore persisted state failures
			}
			return next;
		});
	};

	return (
		<SidebarContentLayout
			className="lg:-ml-6"
			sidebar={
				<div className="relative w-full lg:h-full">
					<div className="w-full overflow-hidden lg:sticky lg:top-0 lg:max-h-dvh">
						<SettingsMenu
							menuItems={menuItems}
							collapsed={isCollapsed}
							onToggleCollapsed={toggleCollapsed}
							showBottomToggle={false}
						/>
					</div>
					<div className="pointer-events-none absolute inset-y-0 right-0 hidden w-0 lg:block">
						<div className="pointer-events-auto sticky top-1/2 h-0 w-0">
							<SidebarEdgeHandle
								isExpanded={!isCollapsed}
								onClick={toggleCollapsed}
								expandLabel="Expand settings sidebar"
								collapseLabel="Collapse settings sidebar"
								className="flex"
							/>
						</div>
					</div>
				</div>
			}
			noGap
			sidebarClassName={cn(
				"relative lg:h-auto lg:self-stretch lg:min-h-[calc(100dvh-3rem)] lg:border-r lg:border-border lg:bg-sidebar/60 lg:overflow-visible lg:transition-[width,max-width] lg:duration-200 lg:ease-in-out lg:z-10",
				isCollapsed
					? "lg:w-[56px] lg:max-w-[56px]"
					: "lg:w-[224px] lg:max-w-[224px]",
			)}
		>
			{/* A little gutter so the panel's edge handle, which straddles the
			    boundary, never sits over the first word of the content. */}
			<div className="w-full lg:pl-6">{children}</div>
		</SidebarContentLayout>
	);
}
