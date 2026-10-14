"use client";

import { useCallback, useEffect, useState } from "react";

export const ENGAGEMENT_PROFILE_METADATA_STORAGE_KEY =
	"fabric-engagement-profile-metadata-expanded";

/** Collapsed by default; choice remembered in localStorage. */
export function useEngagementProfileExpanded() {
	const [isExpanded, setIsExpanded] = useState(false);

	useEffect(() => {
		try {
			const stored = localStorage.getItem(
				ENGAGEMENT_PROFILE_METADATA_STORAGE_KEY,
			);
			if (stored === "true") {
				setIsExpanded(true);
			}
		} catch {
			// Ignore storage access errors (private browsing / disabled storage)
		}
	}, []);

	const toggleExpanded = useCallback(() => {
		setIsExpanded((prev) => {
			const next = !prev;
			try {
				localStorage.setItem(
					ENGAGEMENT_PROFILE_METADATA_STORAGE_KEY,
					String(next),
				);
			} catch {
				// Ignore quota or permission errors
			}
			return next;
		});
	}, []);

	return {
		isExpanded,
		toggleExpanded,
	};
}
