export function isInitialChatRestorePending({
	initialId,
	requestedId,
	conversation,
	engineReady,
}: {
	initialId: string | null;
	requestedId: string | null;
	conversation: { id: string; isOwn: boolean } | null | undefined;
	engineReady: boolean;
}) {
	return Boolean(
		initialId &&
			requestedId === initialId &&
			(!conversation ||
				conversation.id !== initialId ||
				(conversation.isOwn && !engineReady)),
	);
}
