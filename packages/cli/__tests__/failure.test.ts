/**
 * What a failed request is allowed to say (Fizzy #2878): a status and a code
 * pick a fixed sentence that names only the deployment's origin, and what this
 * CLI writes itself has the folder's absolute path, the home folder and any
 * digest taken out before it reaches a person or an agent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliFailure, describeDuration } from "../src/lib/command-boundary.js";
import {
	asFixedFailure,
	scrubForOutput,
	UpgradeRequiredFailure,
} from "../src/lib/instructions/failure.js";
import {
	recordAuthFailure,
	takeAuthFailure,
} from "../src/lib/oauth/auth-failure.js";
import {
	recordUpgradeNotice,
	takeUpgradeNotice,
} from "../src/lib/user-agent.js";

const ORIGIN = "https://fabric.pro";

function requestError(
	message: string,
	status: number,
	code?: string,
): Error & { status: number; code?: string } {
	return Object.assign(new Error(message), { status, code });
}

beforeEach(() => {
	takeAuthFailure();
	takeUpgradeNotice();
});

afterEach(() => {
	takeAuthFailure();
	takeUpgradeNotice();
});

describe("asFixedFailure", () => {
	const SERVER_TEXT = "secret-tenant-name /srv/app/handler.ts at line 42";

	it.each([
		[
			401,
			3,
			"Your sign-in to https://fabric.pro has expired. Run: fabric auth login --base-url https://fabric.pro",
		],
		[
			403,
			5,
			"You do not have access to this project's coding instructions. Ask a project maintainer for access.",
		],
		[404, 4, "Project not found, or you cannot see it."],
		[429, 6, "Too many requests. Wait a minute and try again."],
		[400, 7, "The deployment refused the request as invalid."],
		[422, 7, "The deployment refused the request as invalid."],
		[
			500,
			1,
			"https://fabric.pro had a problem answering. Try again in a moment.",
		],
		[
			503,
			1,
			"https://fabric.pro had a problem answering. Try again in a moment.",
		],
		[
			0,
			1,
			"Could not reach https://fabric.pro. Check your network and try again.",
		],
	])(
		"maps %i to exit %i and a fixed sentence, never the server's words",
		(status, exitCode, sentence) => {
			const failure = asFixedFailure(
				requestError(SERVER_TEXT, status),
				ORIGIN,
			);

			expect(failure).toBeInstanceOf(CliFailure);
			expect(failure.exitCode).toBe(exitCode);
			expect(failure.message).toBe(sentence);
			expect(failure.message).not.toContain("secret-tenant-name");
			expect(failure.message).not.toContain("/srv/app");
		},
	);

	it("names the deployment a network failure could not reach", () => {
		expect(
			asFixedFailure(
				requestError("fetch failed", 0, "NETWORK_ERROR"),
				"https://staging.example",
			).message,
		).toBe(
			"Could not reach https://staging.example. Check your network and try again.",
		);
	});

	it("names the permission a 403 says is missing, only when it has the shape of one", () => {
		expect(
			asFixedFailure(
				requestError(
					"Missing required scope: instructions:publish",
					403,
					"MISSING_SCOPE",
				),
				ORIGIN,
			).message,
		).toBe(
			"This credential is missing the instructions:publish permission. Create a key that carries it, or run: fabric auth login --base-url https://fabric.pro",
		);
		expect(
			asFixedFailure(
				requestError(
					"Missing required scope: <script>alert(1)</script>",
					403,
					"MISSING_SCOPE",
				),
				ORIGIN,
			).message,
		).toBe(
			"This credential is missing a permission this needs. Create a key that carries it, or run: fabric auth login --base-url https://fabric.pro",
		);
	});

	it("passes through a failure that already is one", () => {
		const own = new CliFailure("already fixed", 7);

		expect(asFixedFailure(own, ORIGIN)).toBe(own);
	});

	it("says the sign-in expired when the sign-in recorded why a request never went out", () => {
		recordAuthFailure({ kind: "expired", origin: ORIGIN });

		const failure = asFixedFailure(new Error("fetch failed"), ORIGIN);

		expect(failure.exitCode).toBe(3);
		expect(failure.message).toBe(
			"Your sign-in to https://fabric.pro has expired. Run: fabric auth login --base-url https://fabric.pro",
		);
		expect(takeAuthFailure()).toBeNull();
	});

	it("gives a generic sentence for anything with no status at all", () => {
		const failure = asFixedFailure(new TypeError("x is undefined"), ORIGIN);

		expect(failure.exitCode).toBe(1);
		expect(failure.message).toBe(
			"The request failed. Try again, or run with FABRIC_DEBUG=1 to see why.",
		);
	});

	it("uses the deployment's own upgrade line for a 426, and exits 2", () => {
		recordUpgradeNotice(
			"This CLI is older than the deployment expects. Run: npx -y https://fabric.pro/cli/fabric-0.6.0.tgz instructions init",
		);

		const failure = asFixedFailure(
			requestError("Upgrade Required", 426),
			ORIGIN,
		);

		expect(failure).toBeInstanceOf(UpgradeRequiredFailure);
		expect(failure.exitCode).toBe(2);
		expect(failure.message).toBe(
			"This CLI is older than the deployment expects. Run: npx -y https://fabric.pro/cli/fabric-0.6.0.tgz instructions init",
		);
		// Said once: the failure carries it, so nothing is left to print again.
		expect(takeUpgradeNotice()).toBeNull();
	});

	it("falls back to a fixed upgrade sentence when a 426 brought no line", () => {
		expect(
			asFixedFailure(requestError("Upgrade Required", 426), ORIGIN)
				.message,
		).toBe(
			"This CLI is older than the deployment expects. Run: npm install -g @fabricorg/cli",
		);
	});
});

describe("scrubForOutput", () => {
	const options = {
		destination: "/work/example/checkout",
		destinationTyped: false,
		home: "/home/example",
	};
	const DIGEST = "a".repeat(64);

	it("takes out the folder the person did not type, and the home folder", () => {
		expect(
			scrubForOutput(
				"cannot write /work/example/checkout/.claude/x (from /home/example/.config/fabricai)",
				options,
			),
		).toBe("cannot write this folder/.claude/x (from ~/.config/fabricai)");
	});

	it("leaves a launcher that carries a path exactly as it is, so the line still runs", () => {
		const launcher =
			"node /home/example/.config/cli/https-example.com/fabric.mjs";

		expect(
			scrubForOutput(
				`Run: ${launcher} auth login; saved under /home/example/.config`,
				{ ...options, keep: launcher },
			),
		).toBe(`Run: ${launcher} auth login; saved under ~/.config`);
	});

	it("scrubs a path that merely contains a word of the launcher", () => {
		expect(
			scrubForOutput("cannot write /work/example/checkout/fabric-x", {
				...options,
				keep: "node /home/example/fabric.mjs",
			}),
		).toBe("cannot write this folder/fabric-x");
	});

	it("keeps the folder when --dest typed it", () => {
		expect(
			scrubForOutput("cannot write /work/example/checkout/.claude/x", {
				...options,
				destinationTyped: true,
			}),
		).toBe("cannot write /work/example/checkout/.claude/x");
	});

	it("takes out a Windows path in either slash spelling", () => {
		const windows = {
			destination: "D:\\work\\example",
			destinationTyped: false,
			home: null,
		};

		expect(
			scrubForOutput(
				"a D:\\work\\example\\x and b D:/work/example/y",
				windows,
			),
		).toBe("a this folder\\x and b this folder/y");
	});

	it("takes out a sha256 digest, and only a whole one", () => {
		expect(
			scrubForOutput(`hash ${DIGEST} and ${"b".repeat(40)}`, options),
		).toBe(`hash <digest> and ${"b".repeat(40)}`);
	});

	it("changes nothing in a message with none of those", () => {
		expect(scrubForOutput("a plain message", options)).toBe(
			"a plain message",
		);
	});

	it("handles an empty destination and no home", () => {
		expect(
			scrubForOutput("nothing here", {
				destination: "",
				destinationTyped: false,
				home: null,
			}),
		).toBe("nothing here");
	});
});

describe("describeDuration", () => {
	it.each([
		[10_000, "10 s"],
		[1_500, "1.5 s"],
		[1_000, "1 s"],
		[250, "250 ms"],
		[0, "0 ms"],
	])("%i ms reads %s", (ms, expected) => {
		expect(describeDuration(ms)).toBe(expected);
	});
});
