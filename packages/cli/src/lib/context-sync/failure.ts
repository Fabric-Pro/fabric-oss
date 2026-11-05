/**
 * How `fabric context push` and `fabric context reset` turn an SDK error
 * into a documented exit code, with one addition to `asCliFailure`: a 403
 * for a missing API-key scope names the scope and says to create a key that
 * carries it, rather than printing the server's bare refusal.
 */
import { asCliFailure, CliFailure } from "../command-boundary.js";
import { fabricCommand } from "../launcher.js";
import { missingScopeOf, signInCanGrant } from "../missing-scope.js";

function missingScopeSentence(scope: string | null): string {
	const named = scope ?? "projects:write";
	if (signInCanGrant(named)) {
		return `This credential is missing the ${named} scope. Create an API key with the ${named} scope and run again, or sign in with: ${fabricCommand("auth login")}`;
	}
	return `This credential is missing the ${named} scope, which a browser sign-in does not carry. Create an API key with the ${named} scope and sign in with it: ${fabricCommand("auth login")} --key <api-key>`;
}

export function contextCliFailure(error: unknown): CliFailure {
	if (error instanceof CliFailure) {
		return error;
	}
	const missing = missingScopeOf(error);
	if (missing !== null) {
		return new CliFailure(missingScopeSentence(missing.scope), 5, {
			cause: error,
		});
	}
	return asCliFailure(error);
}
