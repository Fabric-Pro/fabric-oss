"use client";

import { memo, useCallback, useEffect, useRef } from "react";
import { InstructionsSuggestionCard } from "../cards/InstructionsSuggestionCard";
import { ToolSuggestionCard } from "../cards/ToolSuggestionCard";
import { useSidekickForm } from "../SidekickFormContext";
import type { AgentSuggestionRecord } from "../SidekickSuggestionsContext";
import { useSidekickSuggestions } from "../SidekickSuggestionsContext";

interface SidekickSuggestionHostProps {
	sid?: string;
	kind?: string;
}

/**
 * Host component that renders inside markdown chat responses.
 * The remark directive plugin rewrites `:agent_suggestion[]{sId=xxx kind=yyy}`
 * into `<agent-suggestion sid="xxx" kind="yyy" />`, and this component
 * is registered as the React renderer for that custom element.
 *
 * It looks up the suggestion from the SidekickSuggestionsContext and
 * dispatches to the correct card component by kind.
 */
export const SidekickSuggestionHost = memo(function SidekickSuggestionHost({
	sid,
	kind,
}: SidekickSuggestionHostProps) {
	const {
		getSuggestion,
		triggerRefetch,
		hasAttemptedRefetch,
		acceptSuggestion,
		rejectSuggestion,
	} = useSidekickSuggestions();
	const { setFormField } = useSidekickForm();

	const hasTriggeredRefetch = useRef(false);

	const suggestion = sid ? getSuggestion(sid) : null;

	// Wrap acceptSuggestion to also apply tool changes to the form state.
	// Without this, approving a tool card only updates the backend — the
	// form still has the old tool list when the user saves.
	// Note: knowledge integration types are also stored in the tools array
	// since BuilderFormData has no separate dataSources field.
	const acceptToolSuggestion = useCallback(
		async (s: AgentSuggestionRecord): Promise<boolean> => {
			const payload = s.payload as
				| { action: "add" | "remove"; toolId: string }
				| null
				| undefined;
			if (payload?.toolId) {
				const toolEntry = { id: payload.toolId, name: s.title };

				if (payload.action === "add") {
					setFormField("tools", (prev: unknown) => {
						const arr =
							(prev as Array<{ id: string; name: string }>) ?? [];
						if (arr.some((t) => t.id === toolEntry.id)) {
							return arr;
						}
						return [...arr, toolEntry];
					});
				} else {
					setFormField("tools", (prev: unknown) => {
						const arr =
							(prev as Array<{ id: string; name: string }>) ?? [];
						return arr.filter((t) => t.id !== toolEntry.id);
					});
				}
			}
			return acceptSuggestion(s);
		},
		[acceptSuggestion, setFormField],
	);

	// If the suggestion isn't in cache yet and we haven't tried to refetch, do so once
	useEffect(() => {
		if (!sid || suggestion || hasTriggeredRefetch.current) {
			return;
		}
		if (hasAttemptedRefetch(sid)) {
			return;
		}

		hasTriggeredRefetch.current = true;
		triggerRefetch(sid);
	}, [sid, suggestion, hasAttemptedRefetch, triggerRefetch]);

	// Suggestion doesn't exist (deleted or outdated) — render nothing
	if (!suggestion) {
		if (sid && hasAttemptedRefetch(sid)) {
			return null;
		}

		// Loading state — show a skeleton
		return <div className="my-2 h-16 animate-pulse rounded-lg bg-muted" />;
	}

	// Dispatch to the correct card component by kind
	switch (kind ?? suggestion.kind) {
		case "tools":
			return (
				<ToolSuggestionCard
					suggestion={suggestion}
					onAccept={acceptToolSuggestion}
					onReject={rejectSuggestion}
				/>
			);

		case "instructions":
			return (
				<InstructionsSuggestionCard
					suggestion={suggestion}
					onAccept={acceptSuggestion}
					onReject={rejectSuggestion}
				/>
			);

		// TODO: skills, model, knowledge, sub_agent cards

		default:
			// Unrecognized kind — render a basic fallback
			return (
				<div className="my-2 rounded-lg border border-muted p-3 text-sm text-muted-foreground">
					{suggestion.title}
				</div>
			);
	}
});
