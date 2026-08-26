"use client";

import {
	createContext,
	type PropsWithChildren,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";

interface SidebarCollapseContextType {
	isCollapsed: boolean;
	toggleCollapsed: () => void;
	setTransientCollapsed: (collapsed: boolean | null) => void;
}

const SidebarCollapseContext = createContext<
	SidebarCollapseContextType | undefined
>(undefined);

const STORAGE_KEY = "fabric-sidebar-collapsed";

export function SidebarCollapseProvider({ children }: PropsWithChildren) {
	const [persistedCollapsed, setPersistedCollapsed] = useState(false);
	const [transientCollapsed, setTransientCollapsed] = useState<
		boolean | null
	>(null);

	useEffect(() => {
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (stored !== null) {
				setPersistedCollapsed(JSON.parse(stored));
			}
		} catch {
			// ignore
		}
	}, []);

	const toggleCollapsed = useCallback(() => {
		if (transientCollapsed !== null) {
			setTransientCollapsed((prev) => !prev);
			return;
		}
		setPersistedCollapsed((prev) => {
			const next = !prev;
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
			} catch {
				// ignore
			}
			return next;
		});
	}, [transientCollapsed]);

	const isCollapsed =
		transientCollapsed !== null ? transientCollapsed : persistedCollapsed;

	return (
		<SidebarCollapseContext.Provider
			value={{ isCollapsed, toggleCollapsed, setTransientCollapsed }}
		>
			{children}
		</SidebarCollapseContext.Provider>
	);
}

export function useSidebarCollapse() {
	const context = useContext(SidebarCollapseContext);
	if (context === undefined) {
		return {
			isCollapsed: false,
			toggleCollapsed: () => {},
			setTransientCollapsed: () => {},
		};
	}
	return context;
}
