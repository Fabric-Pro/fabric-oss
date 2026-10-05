/**
 * Failures, as the fixed sentences `outcome.ts` owns.
 *
 * What a deployment, the SDK or the network says is never what a person or an
 * agent reads: a status and a code pick a sentence, and the sentence names
 * only the deployment's origin. A server's own words can quote a path, a
 * header or another tenant's name, and under a session hook they would land in
 * an agent's context.
 *
 * `FABRIC_DEBUG=1` is the way to see the original, and the command boundary
 * prints it on its own line, never inside the sentence.
 */
import { CliFailure } from "../command-boundary.js";
import { takeAuthFailure } from "../oauth/auth-failure.js";
import { takeUpgradeNotice } from "../user-agent.js";
import { outcomeFailure, outcomeLine } from "./outcome.js";

/**
 * The deployment asked this CLI to be upgraded. A session hook says so on
 * stdout, where an agent reads it, and still exits 0; a person gets it as the
 * failure's message with exit 2. `line` is the deployment's own words when it
 * sent them, and a fixed sentence when it did not. Nothing is ever updated.
 */
export class UpgradeRequiredFailure extends CliFailure {
	constructor(readonly line: string) {
		super(line, 2);
		this.name = "UpgradeRequiredFailure";
	}
}

function readProperty(error: unknown, name: string): unknown {
	return typeof error === "object" && error !== null && name in error
		? Reflect.get(error, name)
		: undefined;
}

/**
 * The permission a refusal names (`Missing required scope: instructions:write`),
 * only when it has the shape of one — a closed vocabulary, never free text.
 */
function scopeNamed(message: unknown): string | null {
	const named =
		typeof message === "string"
			? /\bscope: ([a-z]+:[a-z]+)\b/.exec(message)?.[1]
			: undefined;
	return named ?? null;
}

/**
 * The failure an error from the SDK, or from the sign-in under it, ends a run
 * with. An error that already is one passes through unchanged.
 */
export function asFixedFailure(
	error: unknown,
	origin: string,
	project?: string,
): CliFailure {
	if (error instanceof CliFailure) {
		return error;
	}
	const failure = fixedSentenceFor(error, origin, project);
	failure.cause = error;
	return failure;
}

function fixedSentenceFor(
	error: unknown,
	origin: string,
	project: string | undefined,
): CliFailure {
	// The SDK turns anything its `fetch` throws into a network error, so the
	// sign-in's own reason arrives by the side channel it recorded it in.
	if (takeAuthFailure() !== null) {
		return outcomeFailure("sign-in-expired", { origin, project });
	}
	const status = readProperty(error, "status");
	const code = readProperty(error, "code");
	if (typeof status === "number") {
		if (status === 401) {
			return outcomeFailure("sign-in-expired", { origin, project });
		}
		if (status === 403) {
			const scope = scopeNamed(readProperty(error, "message"));
			return code === "MISSING_SCOPE" || scope !== null
				? outcomeFailure("missing-scope", { scope, origin })
				: outcomeFailure("forbidden", {});
		}
		if (status === 404) {
			return outcomeFailure("project-not-found", {});
		}
		if (status === 426) {
			return new UpgradeRequiredFailure(
				outcomeLine("upgrade-required", { line: takeUpgradeNotice() }),
			);
		}
		if (status === 429) {
			return outcomeFailure("rate-limited", {});
		}
		if (status === 400 || status === 422) {
			return outcomeFailure("request-refused", {});
		}
		if (status >= 500) {
			return outcomeFailure("server-error", { origin });
		}
		if (status === 0 || code === "NETWORK_ERROR" || code === "TIMEOUT") {
			return outcomeFailure("unreachable", { origin });
		}
	}
	return outcomeFailure("request-failed", {});
}

const SHA256 = /\b[0-9a-f]{64}\b/gi;

/**
 * A message with what a run must not print taken out of it: the absolute
 * path of the folder it ran in (the person did not type it unless `--dest`
 * said so), the user's home folder, and any sha256 digest. For the messages
 * this CLI writes itself, which can carry a path from the operating system.
 */
export function scrubForOutput(
	message: string,
	options: {
		destination: string;
		destinationTyped: boolean;
		home: string | null;
		/** Text to leave exactly as it is: the launcher of a command the message tells the person to run. */
		keep?: string;
	},
): string {
	const { keep, ...rest } = options;
	if (keep !== undefined && keep !== "" && message.includes(keep)) {
		return message
			.split(keep)
			.map((part) => scrubForOutput(part, rest))
			.join(keep);
	}
	let scrubbed = message;
	if (!options.destinationTyped) {
		scrubbed = replacePath(scrubbed, options.destination, "this folder");
	}
	scrubbed = replacePath(scrubbed, options.home ?? "", "~");
	return scrubbed.replace(SHA256, "<digest>");
}

/** `path` in either slash spelling, since Windows messages use both. */
function replacePath(
	text: string,
	target: string,
	replacement: string,
): string {
	if (target === "") {
		return text;
	}
	let out = text;
	for (const spelling of new Set([target, target.replace(/\\/g, "/")])) {
		out = out.split(spelling).join(replacement);
	}
	return out;
}
