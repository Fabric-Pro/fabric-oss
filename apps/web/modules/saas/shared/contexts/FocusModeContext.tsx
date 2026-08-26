"use client";

import { usePathname } from "next/navigation";
import {
	createContext,
	type PropsWithChildren,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";
import { useSidebarCollapse } from "./SidebarCollapseContext";

interface FocusModeContextType {
	isFocusMode: boolean;
	isFocusModeAvailable: boolean;
	setIsFocusMode: (active: boolean) => void;
	toggleFocusMode: () => void;
	registerFocusModeAvailable: () => () => void;
}

const FocusModeContext = createContext<FocusModeContextType | undefined>(
	undefined,
);

/**
 * Checks if the element (or any of its ancestors) is an editable text container,
 * canvas whiteboard (e.g. Excalidraw), or active Radix dropdown/menu.
 */
export function isEditableElement(element: Element | null): boolean {
	if (!element) {
		return false;
	}
	const tagName = element.tagName.toUpperCase();
	if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
		return true;
	}
	if (
		element.closest(
			'.tiptap, [contenteditable="true"], [contenteditable=""], canvas, [role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]',
		)
	) {
		return true;
	}
	return false;
}

export function FocusModeProvider({ children }: PropsWithChildren) {
	const [isFocusMode, setIsFocusModeState] = useState(false);
	const [activeRegisteredViews, setActiveRegisteredViews] = useState(0);
	const pathname = usePathname();
	const { setTransientCollapsed } = useSidebarCollapse();

	const isFocusModeAvailable = activeRegisteredViews > 0;

	// Reset Focus Mode on route navigation
	useEffect(() => {
		setIsFocusModeState(false);
	}, [pathname]);

	// Register / unregister supported views (Atlas, Spec Review)
	const registerFocusModeAvailable = useCallback(() => {
		setActiveRegisteredViews((prev) => prev + 1);
		return () => {
			setActiveRegisteredViews((prev) => Math.max(0, prev - 1));
		};
	}, []);

	// Sync transient sidebar collapse when isFocusMode changes
	useEffect(() => {
		setTransientCollapsed(isFocusMode ? true : null);
	}, [isFocusMode, setTransientCollapsed]);

	const toggleFocusMode = useCallback(() => {
		setIsFocusModeState((prev) => !prev);
	}, []);

	// Keyboard Shortcut Handler: F or Cmd+Shift+F / Ctrl+Shift+F
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.repeat || e.isComposing) {
				return;
			}

			// Focus mode shortcuts are strictly active on supported views only
			if (!isFocusModeAvailable) {
				return;
			}

			if (isEditableElement(document.activeElement)) {
				return;
			}

			const isFKey = e.key === "f" || e.key === "F";
			const isCmdShiftF =
				(e.metaKey || e.ctrlKey) && e.shiftKey && isFKey;
			const isBareF =
				isFKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;

			if (isBareF || isCmdShiftF) {
				e.preventDefault();
				toggleFocusMode();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isFocusModeAvailable, toggleFocusMode]);

	return (
		<FocusModeContext.Provider
			value={{
				isFocusMode,
				isFocusModeAvailable,
				setIsFocusMode: setIsFocusModeState,
				toggleFocusMode,
				registerFocusModeAvailable,
			}}
		>
			{children}
		</FocusModeContext.Provider>
	);
}

export function useFocusMode() {
	const context = useContext(FocusModeContext);
	if (context === undefined) {
		return {
			isFocusMode: false,
			isFocusModeAvailable: false,
			setIsFocusMode: () => {},
			toggleFocusMode: () => {},
			registerFocusModeAvailable: () => () => {},
		};
	}
	return context;
}
