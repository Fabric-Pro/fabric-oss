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
				<div className="relative h-full overflow-visible">
					<div className="h-full w-full overflow-hidden">
						<SettingsMenu
							menuItems={menuItems}
							collapsed={isCollapsed}
							onToggleCollapsed={toggleCollapsed}
							showBottomToggle={false}
						/>
					</div>
					<SidebarEdgeHandle
						isExpanded={!isCollapsed}
						onClick={toggleCollapsed}
						expandLabel="Expand settings sidebar"
						collapseLabel="Collapse settings sidebar"
						className="hidden lg:flex"
					/>
				</div>
			}
			noGap
			sidebarClassName={cn(
				"lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-visible lg:transition-[width,max-width] lg:duration-200 lg:ease-in-out lg:z-10",
				isCollapsed
					? "lg:w-[48px] lg:max-w-[48px]"
					: "lg:w-[224px] lg:max-w-[224px]",
			)}
		>
			<div className="w-full">{children}</div>
		</SidebarContentLayout>
	);
}
