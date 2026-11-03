export async function loadDataAnalystRuntime() {
	const [events, transport, requestReply] = await Promise.all([
		import("./data-analyst-runtime-events"),
		import("./direct-runtime-transport"),
		import("./request-reply-runtime"),
	]);
	return {
		applyEvent: events.applyDataAnalystEvent,
		stream: requestReply.streamRequestReplyRun,
		errorMessageOf: transport.errorMessageOf,
		isAbortError: transport.isAbortError,
	};
}
