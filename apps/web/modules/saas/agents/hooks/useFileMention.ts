"use client";

/**
 * useFileMention
 *
 * React hook for @file mention functionality in chat input.
 * Handles search, selection, and keyboard navigation for code file mentions.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** File data returned from search */
export interface MentionableFile {
	id: string;
	path: string;
	language: string | null;
	size: number | null;
}

export interface UseFileMentionOptions {
	projectId?: string;
	organizationId?: string | null;
	enabled?: boolean;
}

export interface UseFileMentionReturn {
	/** Current search query (text after @file:) */
	searchQuery: string;
	/** Set search query (debounced internally) */
	setSearchQuery: (query: string) => void;
	/** Whether autocomplete dropdown should be open */
	isOpen: boolean;
	/** Open/close the dropdown */
	setIsOpen: (open: boolean) => void;
	/** Currently selected index in dropdown */
	selectedIndex: number;
	/** Set selected index */
	setSelectedIndex: (index: number) => void;
	/** Search results */
	results: MentionableFile[];
	/** Whether search is loading */
	isLoading: boolean;
	/** Select a file */
	selectItem: (file: MentionableFile) => void;
	/** Handle keyboard navigation */
	handleKeyDown: (e: React.KeyboardEvent) => boolean;
}

const DEBOUNCE_MS = 150;

export function useFileMention(
	options: UseFileMentionOptions = {},
): UseFileMentionReturn {
	const { projectId, organizationId, enabled = true } = options;

	// State
	const [searchQuery, setSearchQueryRaw] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const [isOpen, setIsOpen] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);

	// Debounce timer ref
	const debounceRef = useRef<NodeJS.Timeout | null>(null);

	// Debounced search query setter
	const setSearchQuery = useCallback((query: string) => {
		setSearchQueryRaw(query);

		if (debounceRef.current) {
			clearTimeout(debounceRef.current);
		}

		debounceRef.current = setTimeout(() => {
			setDebouncedQuery(query);
		}, DEBOUNCE_MS);
	}, []);

	// Cleanup debounce on unmount
	useEffect(() => {
		return () => {
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
			}
		};
	}, []);

	// Reset selected index when results change
	useEffect(() => {
		setSelectedIndex(0);
	}, [debouncedQuery]);

	// Query for file search
	const { data, isLoading } = useQuery({
		queryKey: [
			"file-mention-search",
			debouncedQuery,
			projectId,
			organizationId,
		],
		queryFn: async () => {
			if (!projectId) {
				return { files: [] };
			}
			return await orpcClient.projects.searchCodeFiles({
				projectId,
				query: debouncedQuery || "",
				organizationId: organizationId ?? null,
			});
		},
		enabled: enabled && isOpen && !!projectId,
		staleTime: 30_000,
	});

	const results = useMemo(() => {
		return (
			(data?.files || []).map(
				(file): MentionableFile => ({
					id: file.path || "",
					path: file.path || "",
					language: file.language ?? null,
					size: file.size ?? null,
				}),
			) || []
		);
	}, [data]);

	// Select a file
	const selectItem = useCallback(
		(_file: MentionableFile) => {
			setIsOpen(false);
			setSearchQuery("");
			setDebouncedQuery("");
		},
		[setSearchQuery],
	);

	// Handle keyboard navigation
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent): boolean => {
			if (!isOpen || results.length === 0) {
				return false;
			}

			switch (e.key) {
				case "ArrowDown":
					e.preventDefault();
					setSelectedIndex((prev) => (prev + 1) % results.length);
					return true;

				case "ArrowUp":
					e.preventDefault();
					setSelectedIndex(
						(prev) => (prev - 1 + results.length) % results.length,
					);
					return true;

				case "Enter":
				case "Tab":
					if (results[selectedIndex]) {
						e.preventDefault();
						selectItem(results[selectedIndex]);
						return true;
					}
					return false;

				case "Escape":
					e.preventDefault();
					setIsOpen(false);
					return true;

				default:
					return false;
			}
		},
		[isOpen, results, selectedIndex, selectItem],
	);

	return {
		searchQuery,
		setSearchQuery,
		isOpen,
		setIsOpen,
		selectedIndex,
		setSelectedIndex,
		results,
		isLoading,
		selectItem,
		handleKeyDown,
	};
}
