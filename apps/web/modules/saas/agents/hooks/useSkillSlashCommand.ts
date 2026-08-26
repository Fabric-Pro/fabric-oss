"use client";

/**
 * useSkillSlashCommand
 *
 * React hook for /slash-command skill selection in chat input.
 * Handles search, filtering, keyboard navigation, and skill selection.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

/** Skill data returned from slash-command search */
export interface SlashCommandSkill {
	id: string;
	name: string;
	slug: string;
	description: string;
	content: string;
}

export interface UseSkillSlashCommandOptions {
	organizationId?: string | null;
}

export interface UseSkillSlashCommandReturn {
	/** Whether autocomplete dropdown is open */
	isOpen: boolean;
	/** Current search query (text after /) */
	query: string;
	/** Set search query */
	setQuery: (query: string) => void;
	/** Filtered skill results */
	results: SlashCommandSkill[];
	/** Whether search is loading */
	isLoading: boolean;
	/** Currently selected index in dropdown */
	selectedIndex: number;
	/** Set currently selected index */
	setSelectedIndex: (index: number) => void;
	/** Select a skill */
	selectSkill: (skill: SlashCommandSkill) => void;
	/** Close the dropdown */
	close: () => void;
	/** Open the dropdown with a query */
	open: (query: string) => void;
	/** Handle keyboard navigation */
	handleKeyDown: (e: React.KeyboardEvent) => boolean;
}

export function useSkillSlashCommand(
	options: UseSkillSlashCommandOptions = {},
): UseSkillSlashCommandReturn {
	const { organizationId } = options;

	// State
	const [isOpen, setIsOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);

	// Query for skills (fetch all, filter client-side)
	const { data, isLoading } = useQuery({
		queryKey: ["skills-slash-command", organizationId],
		queryFn: async () => {
			const result = await orpcClient.skills.list({
				organizationId: organizationId ?? null,
				limit: 50,
				sortBy: "useCount",
				sortOrder: "desc",
			});
			return result.skills;
		},
		enabled: isOpen,
		staleTime: 30_000,
	});

	// Filter skills by query
	const results = useMemo(() => {
		if (!data) {
			return [];
		}
		if (!query.trim()) {
			return data.slice(0, 5) as SlashCommandSkill[];
		}
		const lowerQuery = query.toLowerCase();
		return data
			.filter(
				(s) =>
					s.slug.toLowerCase().startsWith(lowerQuery) ||
					s.name.toLowerCase().includes(lowerQuery),
			)
			.slice(0, 5) as SlashCommandSkill[];
	}, [data, query]);

	// Reset selected index when results change
	useEffect(() => {
		setSelectedIndex(0);
	}, [results.length]);

	// Select a skill
	const selectSkill = useCallback((_skill: SlashCommandSkill) => {
		setIsOpen(false);
		setQuery("");
	}, []);

	// Close dropdown
	const close = useCallback(() => {
		setIsOpen(false);
		setQuery("");
		setSelectedIndex(0);
	}, []);

	// Open dropdown with query
	const open = useCallback((newQuery: string) => {
		setQuery(newQuery);
		setIsOpen(true);
		setSelectedIndex(0);
	}, []);

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
						selectSkill(results[selectedIndex]);
						return true;
					}
					return false;

				case "Escape":
					e.preventDefault();
					close();
					return true;

				default:
					return false;
			}
		},
		[isOpen, results, selectedIndex, selectSkill, close],
	);

	return {
		isOpen,
		query,
		setQuery,
		results,
		isLoading,
		selectedIndex,
		setSelectedIndex,
		selectSkill,
		close,
		open,
		handleKeyDown,
	};
}
