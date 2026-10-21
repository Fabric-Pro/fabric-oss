export type PMBoardReadErrorKind = "credentials" | "other";

function errorText(value: unknown): string {
	try {
		return typeof value === "string"
			? value
			: (JSON.stringify(value) ?? "");
	} catch {
		return "";
	}
}

/** Classify provider failures without returning provider text or credentials. */
export function pmBoardReadError(error: unknown): PMBoardReadErrorKind {
	let current = error;
	for (let depth = 0; depth < 5 && current != null; depth++) {
		try {
			const value = current as {
				message?: unknown;
				error?: unknown;
				output?: unknown;
				cause?: unknown;
			};
			const text =
				typeof current === "string"
					? current
					: [value.message, value.error, value.output]
							.map(errorText)
							.join(" ");
			if (
				/\b(?:40[13]|auth(?:entication|orization)?|oauth|unauthori[sz]ed|forbidden|access denied|credentials? (?:were )?refused|invalid (?:api )?(?:key|token))\b/i.test(
					text,
				)
			) {
				return "credentials";
			}
			current = value.cause;
		} catch {
			return "other";
		}
	}
	return "other";
}

export function pmBoardContextNote(
	type?: string,
	errorKind?: PMBoardReadErrorKind,
): string {
	const provider =
		type === "fizzy"
			? "Fizzy"
			: type === "azure-devops"
				? "Azure DevOps"
				: "PM";
	return errorKind === "credentials"
		? `Your ${provider} connection's credentials were refused, so this update was built without your board. Reconnect it in Connections.`
		: `Couldn't read your ${provider} board, so this update was built without it. Check the connection in Connections.`;
}
