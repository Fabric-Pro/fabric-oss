"use client";

import {
	createContext,
	type PropsWithChildren,
	useCallback,
	useContext,
	useState,
} from "react";

interface FullscreenContextType {
	isFullscreen: boolean;
	setIsFullscreen: (value: boolean) => void;
	isRailExpanded: boolean;
	setIsRailExpanded: (value: boolean) => void;
}

const FullscreenContext = createContext<FullscreenContextType | undefined>(
	undefined,
);

export function FullscreenProvider({ children }: PropsWithChildren) {
	const [isFullscreen, setFullscreenState] = useState(false);
	const [isRailExpanded, setIsRailExpanded] = useState(false);
	const setIsFullscreen = useCallback((value: boolean) => {
		setFullscreenState(value);
		if (!value) {
			setIsRailExpanded(false);
		}
	}, []);

	return (
		<FullscreenContext.Provider
			value={{
				isFullscreen,
				setIsFullscreen,
				isRailExpanded,
				setIsRailExpanded,
			}}
		>
			{children}
		</FullscreenContext.Provider>
	);
}

export function useFullscreen() {
	const context = useContext(FullscreenContext);
	// Return a safe default when used outside provider
	if (context === undefined) {
		return {
			isFullscreen: false,
			setIsFullscreen: () => {},
			isRailExpanded: false,
			setIsRailExpanded: () => {},
		};
	}
	return context;
}
