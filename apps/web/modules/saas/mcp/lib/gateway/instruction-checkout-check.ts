/**
 * The `checkout` check of `fabric_instruction_checks` (Fizzy #2878): the
 * caller reports the git checkout it runs in, and the report says whether it
 * is the published commit of a repository-sourced project.
 *
 * A hookless editor (VS Code, Cursor) has no session hook to fast-forward or
 * warn, so this is how its agent learns at session start that the checkout is
 * current, behind, foreign, or that Fabric's own copy is the stale one. The
 * evidence is `caller-reported`: the server compares what it is told against
 * what it published, and the decision itself is `decideCheckoutVerdict`, the
 * twin of the CLI's copy in `instruction-checks.ts`.
 *
 * Nothing here runs git, and nothing in the result entitles the caller to.
 */
import {
	CHECK_TITLES,
	CHECKOUT_BRANCH_LITERAL,
	CHECKOUT_BRANCH_MAX_CHARS,
	CHECKOUT_COMMIT_SHA,
	CHECKOUT_REMOTE_URL_MAX_CHARS,
	type CheckoutFacts,
	decideCheckoutVerdict,
	type InstructionCheck,
	type PublishedInstructionRepositoryConfig,
	type PublishedInstructionSource,
} from "./instruction-checks";

/** The JSON schema the tool advertises; the gateway does not enforce it, `readCheckoutFacts` does. */
export const CHECKOUT_INPUT_SCHEMA = {
	type: "object",
	description:
		"Facts about the git checkout you are running in, to compare with the commit the project published. Read them with read-only git commands: remoteUrl from `git remote get-url` for the remote the checkout fetches from, headSha from `git rev-parse HEAD`, branch from `git branch --show-current` (omit it when HEAD is detached), and clean as true only when BOTH `git diff --quiet` and `git diff --cached --quiet` exit 0 (no tracked file's content differs from the index or HEAD). Do NOT derive clean from `git status --porcelain`: untracked files and line-ending-only differences are listed by status but are not changes, and reporting them as dirty raises a false uncommitted-changes warning. When you already know the published commit (the `published` check's source.commitSha from an earlier call), add containsPublished as whether `git merge-base --is-ancestor <published commit> HEAD` succeeds: it tells a checkout that is ahead from one that is behind. Only meaningful on a repository-sourced project.",
	properties: {
		remoteUrl: {
			type: "string",
			minLength: 1,
			maxLength: CHECKOUT_REMOTE_URL_MAX_CHARS,
		},
		headSha: {
			type: "string",
			pattern: CHECKOUT_COMMIT_SHA.source,
		},
		branch: {
			type: "string",
			minLength: 1,
			maxLength: CHECKOUT_BRANCH_MAX_CHARS,
			pattern: CHECKOUT_BRANCH_LITERAL.source,
		},
		clean: {
			type: "boolean",
			description:
				"true when `git diff --quiet && git diff --cached --quiet` succeeds; untracked files and line-ending-only differences do not make a checkout dirty.",
		},
		containsPublished: { type: "boolean" },
	},
	required: ["remoteUrl", "headSha", "clean"],
} as const;

/**
 * The caller's `checkout` argument, validated, or why it is unusable.
 *
 * Every message names the field and the rule and never the value: a remote
 * URL may carry credentials in its userinfo, and an agent that pasted the
 * wrong string must not have it echoed back into a transcript. The remote is
 * only ever compared after its userinfo is dropped, and is never returned.
 */
export function readCheckoutFacts(
	raw: unknown,
): { facts: CheckoutFacts } | { error: string } {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return {
			error: "checkout must be an object with remoteUrl, headSha, branch and clean.",
		};
	}
	const { remoteUrl, headSha, branch, clean, containsPublished } =
		raw as Record<string, unknown>;
	if (
		typeof remoteUrl !== "string" ||
		remoteUrl.length === 0 ||
		remoteUrl.length > CHECKOUT_REMOTE_URL_MAX_CHARS
	) {
		return {
			error: `checkout.remoteUrl must be a string of 1 to ${CHECKOUT_REMOTE_URL_MAX_CHARS} characters.`,
		};
	}
	if (typeof headSha !== "string" || !CHECKOUT_COMMIT_SHA.test(headSha)) {
		return {
			error: "checkout.headSha must be a full lowercase commit id (40 or 64 hexadecimal characters).",
		};
	}
	if (
		branch !== undefined &&
		branch !== null &&
		(typeof branch !== "string" ||
			branch.length > CHECKOUT_BRANCH_MAX_CHARS ||
			!CHECKOUT_BRANCH_LITERAL.test(branch))
	) {
		return {
			error: `checkout.branch must be a branch name of at most ${CHECKOUT_BRANCH_MAX_CHARS} characters (letters, digits, . _ / -); omit it when HEAD is detached.`,
		};
	}
	if (typeof clean !== "boolean") {
		return { error: "checkout.clean must be true or false." };
	}
	if (
		containsPublished !== undefined &&
		containsPublished !== null &&
		typeof containsPublished !== "boolean"
	) {
		return {
			error: "checkout.containsPublished must be true or false when given.",
		};
	}
	return {
		facts: {
			remoteUrl,
			headSha,
			branch: branch ?? null,
			clean,
			...(typeof containsPublished === "boolean"
				? { containsPublished }
				: {}),
		},
	};
}

/**
 * The `checkout` check. `sourceOfTruth` and `repository` come from the SAME
 * settings read that built the `published` check, so the two cannot disagree
 * about whether the project is repository-sourced.
 */
export function instructionCheckoutCheck(input: {
	facts: CheckoutFacts | undefined;
	sourceOfTruth: "UPLOAD" | "REPOSITORY";
	repository: PublishedInstructionRepositoryConfig | null;
	source: PublishedInstructionSource;
}): InstructionCheck {
	const skip = (detail: string): InstructionCheck => ({
		id: "checkout",
		title: CHECK_TITLES.checkout,
		status: "skip",
		evidence: "server",
		detail,
	});
	const { facts, sourceOfTruth, repository, source } = input;
	if (sourceOfTruth !== "REPOSITORY" || repository === null) {
		return skip(
			"not a repository-sourced project: its instructions are not read from a checkout",
		);
	}
	if (facts === undefined) {
		return skip(
			"pass checkout (remoteUrl, headSha, branch, clean) to compare this checkout with the published commit",
		);
	}
	if (source.kind !== "REPOSITORY") {
		return skip(
			"the published version was not synced from the repository, so there is no commit to compare with",
		);
	}
	const decision = decideCheckoutVerdict({
		checkout: facts,
		repository,
		published: source,
	});
	return {
		id: "checkout",
		title: CHECK_TITLES.checkout,
		status: decision.status,
		evidence: "caller-reported",
		detail: decision.detail,
		...(decision.fix ? { fix: decision.fix } : {}),
	};
}
