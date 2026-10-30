"use client";

import type { ProposalThemePaint } from "@repo/utils/proposal-artifact/theme-tokens";
import type { VisualSpecSummary } from "@repo/utils/proposal-artifact/visual-identity";
import { orpcClient } from "@shared/lib/orpc-client";
import {
	type QueryClient,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import { getOrpcCode } from "../components/field-mapping/orpc-error";

/**
 * What a diagram on a client-document Proposal's page knows of its document
 * (Fizzy #2946): who is editing, the theme's paint, the generated visuals'
 * stored spec summaries and how to save the editor first.
 *
 * Carried by context rather than by the node's extension options, because
 * the collaborative editor builds its extensions without the Proposal's
 * options, and this is view-only chrome: it changes nothing in the schema.
 * Without a provider (every other document, StoryWorkspace, the diff and
 * version viewers) a diagram keeps its header bar as before.
 */
export interface MermaidVisualContextValue {
	projectId: string;
	documentId: string;
	/**
	 * A member of the owning organization. Build with AI resolves its model
	 * for the session's active organization, so a project guest is offered
	 * Edit with instructions only.
	 */
	isMember: boolean;
	/** The theme's paint, while the theme is worn; null otherwise. */
	paint: ProposalThemePaint | null;
	/** The stored spec summaries; undefined while they load or failed. */
	specs: readonly VisualSpecSummary[] | undefined;
	/**
	 * Saves what the editor holds before the server reads Main. `false`
	 * when saving is refused (a live run, a room behind the saved body) or
	 * fails: the diagram is then treated as changed.
	 */
	flushSave: () => Promise<boolean>;
	/** After a diagram was replaced: read the spec summaries again. */
	onVisualReplaced: () => void;
	/** Says a message in the diagrams' one polite live region. */
	announce: (message: string) => void;
}

/** What the page hands the document editor for its diagrams. */
export interface ProposalVisualsOptions {
	/** The theme's paint, while the theme is worn. */
	paint?: ProposalThemePaint;
	/** A member of the owning organization, not a project guest. */
	isMember: boolean;
}

const MermaidVisualContext = createContext<MermaidVisualContextValue | null>(
	null,
);

export function useMermaidVisualContext(): MermaidVisualContextValue | null {
	return useContext(MermaidVisualContext);
}

function visualSpecsQueryKey(projectId: string, documentId: string) {
	return [
		"projects",
		"proposalArtifact",
		"visualSpecs",
		projectId,
		documentId,
	] as const;
}

function invalidateVisualSpecs(
	queryClient: QueryClient,
	projectId: string,
	documentId: string,
): Promise<void> {
	return queryClient.invalidateQueries({
		queryKey: visualSpecsQueryKey(projectId, documentId),
	});
}

const DENIED_CODES = new Set(["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"]);

/**
 * Provides {@link MermaidVisualContextValue} to the diagrams below it, and
 * reads the document's spec summaries once for all of them. `enabled`
 * false provides nothing, so the diagrams keep their header bar.
 *
 * The diagrams speak through one live region rendered here, beside the
 * editor rather than in it. A modal overlay hides the page from screen
 * readers but keeps live regions readable, so a region inside the editor
 * made it mark the editor's blocks `aria-hidden`; ProseMirror took those
 * attribute changes for an edit and parsed the diagrams again (Fizzy #2946).
 */
export function MermaidVisualProvider({
	enabled,
	projectId,
	documentId,
	isMember,
	paint,
	flushSave,
	children,
}: {
	enabled: boolean;
	projectId: string;
	documentId: string;
	isMember: boolean;
	paint: ProposalThemePaint | null | undefined;
	flushSave: () => Promise<boolean>;
	children: ReactNode;
}) {
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: visualSpecsQueryKey(projectId, documentId),
		queryFn: async (): Promise<VisualSpecSummary[]> => {
			const result =
				await orpcClient.projects.proposalArtifact.listVisualSpecs({
					projectId,
					documentId,
				});
			return result.specs;
		},
		enabled,
		staleTime: 30_000,
		retry: (failureCount, error) =>
			!DENIED_CODES.has(getOrpcCode(error) ?? "") && failureCount < 2,
	});
	const specs = query.isError ? undefined : query.data;
	const onVisualReplaced = useCallback(() => {
		void invalidateVisualSpecs(queryClient, projectId, documentId);
	}, [queryClient, projectId, documentId]);
	const [announcement, setAnnouncement] = useState("");
	const value = useMemo<MermaidVisualContextValue | null>(
		() =>
			enabled
				? {
						projectId,
						documentId,
						isMember,
						paint: paint ?? null,
						specs,
						flushSave,
						onVisualReplaced,
						announce: setAnnouncement,
					}
				: null,
		[
			enabled,
			projectId,
			documentId,
			isMember,
			paint,
			specs,
			flushSave,
			onVisualReplaced,
		],
	);
	return (
		<MermaidVisualContext.Provider value={value}>
			{children}
			{enabled && (
				<output className="sr-only" aria-live="polite">
					{announcement}
				</output>
			)}
		</MermaidVisualContext.Provider>
	);
}
