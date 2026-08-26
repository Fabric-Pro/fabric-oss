"use client";

import {
	createContext,
	type PropsWithChildren,
	useContext,
	useState,
} from "react";

interface FullscreenContextType {
	isFullscreen: boolean;
	setIsFullscreen: (value: boolean) => void;
}

const FullscreenContext = createContext<FullscreenContextType | undefined>(
	undefined,
);

export function FullscreenProvider({ children }: PropsWithChildren) {
	const [isFullscreen, setIsFullscreen] = useState(false);

	return (
		<FullscreenContext.Provider value={{ isFullscreen, setIsFullscreen }}>
			{children}
		</FullscreenContext.Provider>
	);
}

export function useFullscreen() {
	const context = useContext(FullscreenContext);
	// Return a safe default when used outside provider
	// This allows FullscreenToggle to be used in pages without FullscreenProvider
	if (context === undefined) {
		return {
			isFullscreen: false,
			setIsFullscreen: () => {},
		};
	}
	return context;
}
