"use client";

import { INSTRUCTIONS_ROOT_BLOCK_ID } from "@repo/ai/sidekick/constants";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
} from "react";

// ---- Types ----

export interface SidekickFormSnapshot {
	name: string;
	description: string;
	systemPromptMarkdown: string;
	/** HTML representation of the system prompt with data-block-id attributes. */
	systemPromptHtml: string;
	model: string;
	tools: Array<{ id: string; name: string }>;
	skills: string[];
	pendingSuggestions: Array<{ sId: string; kind: string }>;
}

/** The minimal form values the provider needs from its parent. */
export interface SidekickFormValues {
	name: string;
	description: string;
	systemPromptMarkdown: string;
	systemPromptHtml?: string;
	model: string;
	tools: Array<{ id: string; name: string }>;
	skills: string[];
}

/** Pending suggestion summaries passed alongside form values. */
export interface PendingSuggestionSummary {
	sId: string;
	kind: string;
}

export interface SidekickFormContextValue {
	/** Returns a point-in-time snapshot of the current form state. */
	getSnapshot(): SidekickFormSnapshot;
	/** Updates a single form field via an updater function.
	 *  This is the mechanism suggestion cards use to mutate form values. */
	setFormField(field: string, updater: (prev: unknown) => unknown): void;
}

// ---- Context ----

const SidekickFormContext = createContext<SidekickFormContextValue | null>(
	null,
);

// ---- Provider ----

interface SidekickFormProviderProps {
	/** Current form values, kept in sync by the parent component. */
	formValues: SidekickFormValues;
	/** Pending suggestion summaries for inclusion in the snapshot. */
	pendingSuggestions?: PendingSuggestionSummary[];
	/** Callback the parent provides so suggestion cards can mutate form state. */
	onSetFormField: (
		field: string,
		updater: (prev: unknown) => unknown,
	) => void;
	children: ReactNode;
}

export function SidekickFormProvider({
	formValues,
	pendingSuggestions = [],
	onSetFormField,
	children,
}: SidekickFormProviderProps) {
	// Keep a ref that always points at the latest form values so `getSnapshot`
	// reads the freshest data without forcing context consumers to re-render
	// on every keystroke.
	const formValuesRef = useRef<SidekickFormValues>(formValues);
	const pendingSuggestionsRef =
		useRef<PendingSuggestionSummary[]>(pendingSuggestions);

	useEffect(() => {
		formValuesRef.current = formValues;
	}, [formValues]);

	useEffect(() => {
		pendingSuggestionsRef.current = pendingSuggestions;
	}, [pendingSuggestions]);

	const getSnapshot = useCallback((): SidekickFormSnapshot => {
		const current = formValuesRef.current;
		const currentPending = pendingSuggestionsRef.current;

		// If the parent already provides real HTML (from TipTap),
		// use it; otherwise wrap the markdown in a placeholder block div.
		const systemPromptHtml =
			current.systemPromptHtml ??
			`<div data-block-id="${INSTRUCTIONS_ROOT_BLOCK_ID}">${current.systemPromptMarkdown}</div>`;

		return {
			name: current.name,
			description: current.description,
			systemPromptMarkdown: current.systemPromptMarkdown,
			systemPromptHtml,
			model: current.model,
			tools: current.tools,
			skills: current.skills,
			pendingSuggestions: currentPending,
		};
	}, []);

	const setFormField = useCallback(
		(field: string, updater: (prev: unknown) => unknown) => {
			onSetFormField(field, updater);
		},
		[onSetFormField],
	);

	const value = useMemo<SidekickFormContextValue>(
		() => ({
			getSnapshot,
			setFormField,
		}),
		[getSnapshot, setFormField],
	);

	return (
		<SidekickFormContext.Provider value={value}>
			{children}
		</SidekickFormContext.Provider>
	);
}

// ---- Hook ----

export function useSidekickForm(): SidekickFormContextValue {
	const context = useContext(SidekickFormContext);
	if (!context) {
		throw new Error(
			"useSidekickForm must be used within SidekickFormProvider",
		);
	}
	return context;
}
