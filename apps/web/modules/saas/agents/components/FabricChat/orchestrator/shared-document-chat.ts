/** Serialize chat creation until one upload establishes the shared document chat. */
export function sharedDocumentChat<
	I extends { chatId?: string },
	R extends { chatId?: string | null },
>(create: (input: I) => Promise<R>, initialChatId?: string) {
	let chatId = initialChatId;
	let establishing: Promise<unknown> | undefined;
	return async (input: I): Promise<R> => {
		while (!chatId && establishing) {
			await establishing.catch(() => undefined);
		}
		if (chatId) {
			return create({ ...input, chatId });
		}
		const request = create(input);
		establishing = request.then((result) => {
			chatId = result.chatId ?? undefined;
		});
		try {
			await establishing;
			return await request;
		} finally {
			establishing = undefined;
		}
	};
}
