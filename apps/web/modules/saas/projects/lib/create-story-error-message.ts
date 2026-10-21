export function getCreateStoryErrorMessage(
	error: unknown,
	tCreate: (key: string) => string,
): string {
	return error instanceof Error ? error.message : tCreate("creationFailed");
}
