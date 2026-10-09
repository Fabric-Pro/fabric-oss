import { orpc } from "@shared/lib/orpc-query-utils";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

/**
 * Keeps the project header's "N contexts" in step with the Context tab's list.
 *
 * The header reads `_count.contexts` from `projects.get`; the list reads
 * `contexts.list`. An upload, a pasted link or a delete refreshes the list
 * only, so the header kept the count it was loaded with until the page was
 * reloaded, and the same went for the readiness counters while a repository's
 * first sync filled the list in. The signature names the rows and their
 * extraction states; when it changes from one already shown, the project is
 * read again. The first signature seen is only recorded: the project was just
 * read alongside it.
 */
export function useProjectContextCountSync(
	projectId: string,
	signature: string | undefined,
) {
	const queryClient = useQueryClient();
	const seen = useRef<{ projectId: string; signature: string } | null>(null);
	useEffect(() => {
		if (signature === undefined) {
			return;
		}
		const previous = seen.current;
		seen.current = { projectId, signature };
		if (
			previous &&
			previous.projectId === projectId &&
			previous.signature !== signature
		) {
			void queryClient.invalidateQueries({
				queryKey: orpc.projects.get.key({ input: { id: projectId } }),
			});
		}
	}, [queryClient, projectId, signature]);
}
