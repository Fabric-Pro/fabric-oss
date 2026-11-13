import type { resolveEnvironmentAuth } from "@repo/database";

/**
 * How a browser run authenticates against an environment, and the request
 * headers that carry a TOKEN or HEADER credential. Shared by the QA runner
 * and the release-notes screenshot capture, which drive the same browser.
 *
 * The secret only ever reaches `signInWithForm` (FORM) or the outbound guard's
 * scoped headers (TOKEN, HEADER) — never a prompt, a log or a step record.
 */
export type RunnerAuth =
	| { kind: "NONE" }
	| { kind: "FORM"; username: string; secret: string }
	| { kind: "TOKEN"; secret: string }
	| { kind: "HEADER"; headerName: string; secret: string };

export function runnerAuthFromEnvironment(
	environment: Awaited<ReturnType<typeof resolveEnvironmentAuth>>,
): RunnerAuth {
	if (
		!environment ||
		environment.authKind === "NONE" ||
		!environment.secret
	) {
		return { kind: "NONE" };
	}
	if (environment.authKind === "FORM") {
		return environment.username
			? {
					kind: "FORM",
					username: environment.username,
					secret: environment.secret,
				}
			: { kind: "NONE" };
	}
	if (environment.authKind === "TOKEN") {
		return { kind: "TOKEN", secret: environment.secret };
	}
	if (environment.authKind === "HEADER" && environment.headerName) {
		return {
			kind: "HEADER",
			headerName: environment.headerName,
			secret: environment.secret,
		};
	}
	return { kind: "NONE" };
}

/** The headers a TOKEN or HEADER credential adds, scoped to `origin` only. */
export function scopedHeadersForAuth(
	auth: RunnerAuth,
	origin: string,
): { origin: string; headers: Record<string, string> } | undefined {
	switch (auth.kind) {
		case "TOKEN":
			return {
				origin,
				headers: { Authorization: `Bearer ${auth.secret}` },
			};
		case "HEADER":
			return { origin, headers: { [auth.headerName]: auth.secret } };
		case "NONE":
		case "FORM":
			return undefined;
		default: {
			const exhaustive: never = auth;
			return exhaustive;
		}
	}
}
