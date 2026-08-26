"use client";

/**
 * useTemplateMention
 *
 * React hook for @template mention functionality in chat input.
 * Handles search, selection, keyboard navigation, and instruction merging.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Template data returned from search */
export interface MentionableTemplate {
	id: string;
	slug: string;
	displayName: string;
	description: string;
	category: string;
	heroEmojis: string[];
	instructions: string;
	/** Skills attached to this template (from Skill catalog) */
	skills: Array<{ name: string; content: string }>;
	/** Enabled OAuth integration IDs for this template instance */
	enabledIntegrationIds: string[];
	/** Enabled MCP config IDs for this template instance */
	enabledMcpConfigIds: string[];
	/** Enabled Fabric AI tool IDs (selective, from built-in tool config) */
	enabledFabricToolIds: string[];
}

export interface UseTemplateMentionOptions {
	organizationId?: string | null;
	enabled?: boolean;
	/** Initial selected templates (for restoring session-level selections across remounts) */
	initialSelectedTemplates?: MentionableTemplate[];
}

export interface UseTemplateMentionReturn {
	/** Current search query (text after @) */
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
	results: MentionableTemplate[];
	/** Whether search is loading */
	isLoading: boolean;
	/** Selected templates (can be multiple) */
	selectedTemplates: MentionableTemplate[];
	/** Merged instructions from all selected templates */
	mergedInstructions: string | null;
	/** Merged enabled integration IDs from all selected templates */
	mergedIntegrationIds: string[];
	/** Merged enabled MCP config IDs from all selected templates */
	mergedMcpConfigIds: string[];
	/** Merged enabled Fabric AI tool IDs from all selected templates */
	mergedFabricToolIds: string[];
	/** Select a template */
	selectTemplate: (template: MentionableTemplate) => void;
	/** Remove a selected template */
	removeTemplate: (templateId: string) => void;
	/** Clear all selected templates */
	clearTemplates: () => void;
	/** Handle keyboard navigation */
	handleKeyDown: (e: React.KeyboardEvent) => boolean;
}

const DEBOUNCE_MS = 150;

export function useTemplateMention(
	options: UseTemplateMentionOptions = {},
): UseTemplateMentionReturn {
	const {
		organizationId,
		enabled = true,
		initialSelectedTemplates,
	} = options;

	// State
	const [searchQuery, setSearchQueryRaw] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const [isOpen, setIsOpen] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [selectedTemplates, setSelectedTemplates] = useState<
		MentionableTemplate[]
	>(initialSelectedTemplates ?? []);

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

	// Query for template search
	const { data, isLoading } = useQuery({
		queryKey: ["template-mention-search", debouncedQuery, organizationId],
		queryFn: async () => {
			const result =
				await orpcClient.agentTemplates.templates.searchForMention({
					query: debouncedQuery || undefined,
					organizationId: organizationId ?? null,
					limit: 10,
				});
			return result.templates;
		},
		enabled: enabled && isOpen,
		staleTime: 30_000, // 30 seconds
	});

	const results = useMemo(() => {
		return (data || []) as MentionableTemplate[];
	}, [data]);

	// Merge instructions from all selected templates
	const mergedInstructions = useMemo(() => {
		if (selectedTemplates.length === 0) {
			return null;
		}

		const instructions = selectedTemplates
			.map((template) => {
				const parts: string[] = [];

				if (template.instructions?.trim()) {
					parts.push(template.instructions.trim());
				}

				// Skills from the Skill catalog (detailed instructions)
				if (template.skills?.length > 0) {
					const skillSections = template.skills.map(
						(skill) => `### Skill: ${skill.name}\n${skill.content}`,
					);
					parts.push(
						`## Loaded Skills\nYou have the following skills loaded. When the user's request matches a skill's purpose, you MUST follow that skill's instructions exactly, including its output format (e.g., generating HTML pages, diagrams, etc.).\n\n${skillSections.join("\n\n")}`,
					);
				}

				if (parts.length === 0) {
					return null;
				}

				return `### ${template.displayName}\n${parts.join("\n\n")}`;
			})
			.filter(Boolean);

		if (instructions.length === 0) {
			return null;
		}

		return instructions.join("\n\n---\n\n");
	}, [selectedTemplates]);

	// Merge integration IDs from all selected templates (deduplicated)
	const mergedIntegrationIds = useMemo(() => {
		if (selectedTemplates.length === 0) {
			return [];
		}
		const allIds = selectedTemplates.flatMap(
			(t) => t.enabledIntegrationIds || [],
		);
		return [...new Set(allIds)];
	}, [selectedTemplates]);

	// Merge MCP config IDs from all selected templates (deduplicated)
	const mergedMcpConfigIds = useMemo(() => {
		if (selectedTemplates.length === 0) {
			return [];
		}
		const allIds = selectedTemplates.flatMap(
			(t) => t.enabledMcpConfigIds || [],
		);
		return [...new Set(allIds)];
	}, [selectedTemplates]);

	// Merge Fabric AI tool IDs from all selected templates (deduplicated)
	const mergedFabricToolIds = useMemo(() => {
		if (selectedTemplates.length === 0) {
			return [];
		}
		const allIds = selectedTemplates.flatMap(
			(t) => t.enabledFabricToolIds || [],
		);
		return [...new Set(allIds)];
	}, [selectedTemplates]);

	// Select a template
	const selectTemplate = useCallback(
		(template: MentionableTemplate) => {
			setSelectedTemplates((prev) => {
				// Don't add duplicates
				if (prev.some((t) => t.id === template.id)) {
					return prev;
				}
				return [...prev, template];
			});
			setIsOpen(false);
			setSearchQuery("");
			setDebouncedQuery("");
		},
		[setSearchQuery],
	);

	// Remove a selected template
	const removeTemplate = useCallback((templateId: string) => {
		setSelectedTemplates((prev) => prev.filter((t) => t.id !== templateId));
	}, []);

	// Clear all selected templates
	const clearTemplates = useCallback(() => {
		setSelectedTemplates([]);
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
						selectTemplate(results[selectedIndex]);
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
		[isOpen, results, selectedIndex, selectTemplate],
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
		selectedTemplates,
		mergedInstructions,
		mergedIntegrationIds,
		mergedMcpConfigIds,
		mergedFabricToolIds,
		selectTemplate,
		removeTemplate,
		clearTemplates,
		handleKeyDown,
	};
}
