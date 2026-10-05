/** What `/oauth2/consent` and `/oauth2/continue` answer a browser fetch. */
export interface AuthorizationRedirect {
	redirect?: boolean;
	url?: string;
}

/**
 * Send the browser on to where the authorization server said, exactly once.
 *
 * The auth client's built-in redirect plugin already navigates when an answer
 * carries `redirect: true`, so navigating again requests the same URL twice. A
 * client listening on a loopback port (the CLI, a coding agent) takes the code
 * from the first request and closes the port, and the second one ends on
 * "127.0.0.1 refused to connect" although the sign-in worked.
 */
export function followAuthorizationRedirect(
	answer: AuthorizationRedirect & { url: string },
	location: Pick<Location, "assign"> = window.location,
): void {
	if (answer.redirect !== true) {
		location.assign(answer.url);
	}
}
