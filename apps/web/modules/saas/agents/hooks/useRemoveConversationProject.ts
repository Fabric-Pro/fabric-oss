"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";

/**
 * Removes the project from a chat (Fizzy #2040, FR12).
 *
 * Clearing the pill alone is not enough once a conversation exists: both
 * stream routes re-derive the project from the conversation's stored
 * attachment, so the next turn would carry it again. The attachment is
 * detached first, and the pill only clears once that has succeeded — a
 * failed detach (for instance without permission to update the project)
 * leaves the pill in place with a toast, rather than looking removed while
 * the project keeps arriving.
 */
export function useRemoveConversationProject({
	conversationId,
	organizationId,
	onRemoved,
}: {
	conversationId: string | null | undefined;
	organizationId: string | null | undefined;
	onRemoved: () => void;
}) {
	const queryClient = useQueryClient();
	const [isRemoving, setIsRemoving] = useState(false);

	const removeProject = useCallback(async () => {
		if (conversationId) {
			setIsRemoving(true);
			try {
				await orpcClient.projects.conversations.detach({
					conversationId,
					organizationId: organizationId ?? null,
				});
			} catch (error) {
				toast.error("Couldn't remove the project from this chat.", {
					description:
						error instanceof Error ? error.message : undefined,
				});
				return;
			} finally {
				setIsRemoving(false);
			}
			await queryClient.invalidateQueries({
				queryKey: orpc.projects.conversations.getProject.key(),
			});
		}
		onRemoved();
	}, [conversationId, organizationId, onRemoved, queryClient]);

	return { removeProject, isRemoving };
}
