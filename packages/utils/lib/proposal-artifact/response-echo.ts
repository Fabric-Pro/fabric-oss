/**
 * The echo check of a Proposal's Main (Fizzy #2946): whether a text about to
 * reach a reader repeats the wording of an answer or a finding title that a
 * prompt carried.
 *
 * Answers to the Internal Analysis are internal material. They may steer a
 * generation or a revision of Main, but their wording must never land in a
 * document every reader sees, project guests included. The worker checks a
 * generated Main before saving it, the agent checks each proposed document
 * before it reaches the conversation, and the save path checks an accepted
 * change as the backstop: all with these functions, so all agree.
 *
 * The carried text is prompt-only: it, and a guard built from it, must never
 * enter an activity result, a log or a failure message. Results name indexes
 * and stable keys, never words.
 *
 * Pure and deterministic, and no Node built-ins: the worker, the API, the
 * agent and the editor bundle can all import it. The settled-decisions feed
 * (`@repo/temporal`) builds the carried text and re-exports these, with
 * {@link joinSettledDecisions}, which the worker and the agent both use to
 * add its block to a prompt.
 */

/**
 * Consecutive normalised words a Main must repeat from one carried answer or
 * title before it counts as an echo. An answer shorter than this can never
 * trigger the check, so a plain factual answer (a price, a duration, a date,
 * a short name) is always free to appear in Main.
 */
export const RESPONSE_ECHO_MIN_WORDS = 12;

/**
 * Normalised words a finding title needs before Main may not repeat it
 * whole. A title is usually shorter than {@link RESPONSE_ECHO_MIN_WORDS}, so
 * one of this many words or more counts as an echo when Main holds all of
 * it; a shorter title ("Price is missing") never does.
 */
export const TITLE_ECHO_MIN_WORDS = 4;

/**
 * The text a prompt carried, for {@link checkResponseEcho}. Prompt-only: the
 * texts and titles must never enter an activity result, a log or a failure
 * message. The keys, one per text and one per title in the same order, are
 * ids and may be logged.
 */
export interface CarriedSettledText {
	responseTexts: readonly string[];
	findingTitles: readonly string[];
	/** The stable key of each entry of `responseTexts`, in order. */
	responseKeys?: readonly string[];
	/** The stable key of each entry of `findingTitles`, in order. */
	titleKeys?: readonly string[];
	/**
	 * Indexes into `findingTitles` that hold a finding's recommendation
	 * rather than its title. A recommendation is checked only by runs of
	 * {@link RESPONSE_ECHO_MIN_WORDS} words, never whole: applying it is
	 * meant to carry it into Main.
	 */
	recommendationIndexes?: readonly number[];
}

export interface ResponseEchoInput {
	/** The Main about to be saved. */
	mainText: string;
	/** What the prompt carried: the builder's `carried`, or a caller's own. */
	carried: CarriedSettledText;
	/**
	 * The generation's source context. A run of words found here is the
	 * source's, not the answer's, and never counts.
	 */
	sourceContext?: string | readonly string[] | null;
	/** The Main before this save. A run already there never counts. */
	previousMain?: string | null;
	/**
	 * The run length for each carried answer, by its index in
	 * `carried.responseTexts`, in place of {@link RESPONSE_ECHO_MIN_WORDS}.
	 * A caller that holds a text no reader may see even in part (the bound
	 * prompt, for a guest) checks it with shorter runs. Absent, every answer
	 * uses the default.
	 */
	responseRunWords?: (index: number) => number;
	/**
	 * Whether a finding title of {@link TITLE_ECHO_MIN_WORDS} to
	 * {@link RESPONSE_ECHO_MIN_WORDS} words counts when Main holds it whole.
	 * On by default; a caller whose refusal cannot be retried (the Main
	 * generation) turns it off and checks titles by the long runs only.
	 */
	wholeTitles?: boolean;
}

export interface ResponseEchoResult {
	echoed: boolean;
	/** Indexes into `carried.responseTexts` whose wording Main repeats. */
	responseIndexes: number[];
	/** Indexes into `carried.findingTitles` whose wording Main repeats. */
	titleIndexes: number[];
}

/**
 * Whether `mainText` repeats {@link RESPONSE_ECHO_MIN_WORDS} or more
 * consecutive words of a carried answer or finding title, or the whole of a
 * finding title of {@link TITLE_ECHO_MIN_WORDS} words or more, leaving out
 * every run that also appears in the source context or the previous Main.
 *
 * Words are compared normalised: NFKC, lower case, split on anything that is
 * not a letter, mark or digit, so markdown emphasis, punctuation and case do
 * not hide a copy. An answer shorter than the threshold can never match, so
 * short factual answers pass. The result names indexes only, never words:
 * a caller refuses with its `RESPONSE_ECHOED` code and a message that names
 * no text (the worker's `RESPONSE_ECHOED_MESSAGE`), and logs the indexes at
 * most.
 *
 * One check of one Main. A caller that checks many texts against the same
 * carried text and context (every live preview of a run) builds a
 * {@link buildEchoGuard} once and asks {@link checkEcho} instead; the answers
 * are the same.
 */
export function checkResponseEcho(
	input: ResponseEchoInput,
): ResponseEchoResult {
	const { mainText, ...fixed } = input;
	return checkEcho(buildEchoGuard(fixed), mainText);
}

/**
 * {@link checkResponseEcho} prepared once for inputs that do not change
 * between checks: each carried text's word runs, computed up front, and the
 * text a run may also appear in, normalised on first need and kept, with
 * every run's verdict against it. Built by {@link buildEchoGuard}; read only
 * by {@link checkEcho}. Holds carried text, so it is prompt-only like
 * {@link CarriedSettledText}.
 */
export interface ResponseEchoGuard {
	/** What the prompt carried, for {@link echoedStableKeys}. */
	readonly carried: CarriedSettledText;
	/** Each carried text's runs: every answer in order, then every title. */
	readonly entries: readonly CarriedEchoEntry[];
	/** Whether a run also appears in the source context or previous Main. */
	readonly allowed: (run: string) => boolean;
}

interface CarriedEchoEntry {
	kind: "response" | "title";
	/** Index into `carried.responseTexts` or `carried.findingTitles`. */
	index: number;
	/** The words in each of `runs`. */
	runWords: number;
	runs: readonly string[];
}

/**
 * The guard for an echo check's inputs other than the Main, which stay fixed
 * for a whole attempt.
 */
export function buildEchoGuard(
	input: Omit<ResponseEchoInput, "mainText">,
): ResponseEchoGuard {
	const allowedTexts = [
		...(typeof input.sourceContext === "string"
			? [input.sourceContext]
			: (input.sourceContext ?? [])),
		input.previousMain ?? "",
	];
	let haystack: string | null = null;
	const verdicts = new Map<string, boolean>();
	const responseRunWords = input.responseRunWords;
	const recommendations = new Set(input.carried.recommendationIndexes);
	const wholeTitles = input.wholeTitles ?? true;
	return {
		carried: input.carried,
		entries: [
			...input.carried.responseTexts.map((text, index) =>
				responseEntry(
					text,
					index,
					responseRunWords?.(index) ?? RESPONSE_ECHO_MIN_WORDS,
				),
			),
			...input.carried.findingTitles.map((text, index) =>
				titleEntry(
					text,
					index,
					!wholeTitles || recommendations.has(index),
				),
			),
		],
		allowed: (run) => {
			let verdict = verdicts.get(run);
			if (verdict === undefined) {
				// `|` is never part of a word, so no run spans two texts.
				haystack ??= ` ${allowedTexts
					.map((text) => normalizedWords(text).join(" "))
					.join(" | ")} `;
				verdict = haystack.includes(` ${run} `);
				verdicts.set(run, verdict);
			}
			return verdict;
		},
	};
}

/** {@link checkResponseEcho} of `mainText`, against a prepared guard. */
export function checkEcho(
	guard: ResponseEchoGuard,
	mainText: string,
): ResponseEchoResult {
	const responseIndexes: number[] = [];
	const titleIndexes: number[] = [];
	if (guard.entries.length === 0) {
		return { echoed: false, responseIndexes, titleIndexes };
	}
	const mainWords = normalizedWords(mainText);
	// Main's runs of each length an entry needs, built on first need.
	const mainRuns = new Map<number, ReadonlySet<string>>();
	const mainRunsOf = (runWords: number) => {
		let runs = mainRuns.get(runWords);
		if (!runs) {
			runs = new Set(wordRuns(mainWords, runWords));
			mainRuns.set(runWords, runs);
		}
		return runs;
	};

	for (const entry of guard.entries) {
		if (entry.runs.length === 0 || mainWords.length < entry.runWords) {
			continue;
		}
		const runs = mainRunsOf(entry.runWords);
		const repeated = entry.runs.some(
			(run) => runs.has(run) && !guard.allowed(run),
		);
		if (repeated) {
			(entry.kind === "response" ? responseIndexes : titleIndexes).push(
				entry.index,
			);
		}
	}

	return {
		echoed: responseIndexes.length > 0 || titleIndexes.length > 0,
		responseIndexes,
		titleIndexes,
	};
}

const NON_WORD = /[^\p{L}\p{M}\p{N}]+/u;

/**
 * Characters that draw nothing (a zero-width space, a soft hyphen, a word
 * joiner): removed before splitting, so one placed inside a word cannot
 * break a copy into runs that match nothing.
 */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;

function normalizedWords(text: string): string[] {
	return text
		.normalize("NFKC")
		.replace(INVISIBLE, "")
		.toLowerCase()
		.split(NON_WORD)
		.filter(Boolean);
}

/** Every run of exactly `runWords` words, space-joined. */
function wordRuns(words: readonly string[], runWords: number): string[] {
	const runs: string[] = [];
	for (let start = 0; start + runWords <= words.length; start += 1) {
		runs.push(words.slice(start, start + runWords).join(" "));
	}
	return runs;
}

/** A carried answer's entry: its runs of `runWords` words. */
function responseEntry(
	text: string,
	index: number,
	runWords: number,
): CarriedEchoEntry {
	const length = Math.max(1, Math.floor(runWords));
	return {
		kind: "response",
		index,
		runWords: length,
		runs: wordRuns(normalizedWords(text), length),
	};
}

/**
 * A finding title's entry: its runs of {@link RESPONSE_ECHO_MIN_WORDS} words
 * when it is that long, otherwise the whole title as one run when it has
 * {@link TITLE_ECHO_MIN_WORDS} words or more, and no run when it is shorter.
 * With `longRunsOnly` (a recommendation, or a caller without whole titles)
 * it gets the long runs only.
 */
function titleEntry(
	text: string,
	index: number,
	longRunsOnly: boolean,
): CarriedEchoEntry {
	const words = normalizedWords(text);
	const runWords =
		words.length >= RESPONSE_ECHO_MIN_WORDS || longRunsOnly
			? RESPONSE_ECHO_MIN_WORDS
			: words.length;
	return {
		kind: "title",
		index,
		runWords,
		runs: runWords >= TITLE_ECHO_MIN_WORDS ? wordRuns(words, runWords) : [],
	};
}

/**
 * The stable keys of the answers an echo repeated, for a log line that lets
 * someone find the answer to reword or clear (Fizzy #2946). Keys only, never
 * the text; empty when the carried text came without keys.
 */
export function echoedStableKeys(
	carried: CarriedSettledText,
	echo: Pick<ResponseEchoResult, "responseIndexes" | "titleIndexes">,
): string[] {
	const keys = new Set<string>();
	for (const index of echo.responseIndexes) {
		const key = carried.responseKeys?.[index];
		if (key) {
			keys.add(key);
		}
	}
	for (const index of echo.titleIndexes) {
		const key = carried.titleKeys?.[index];
		if (key) {
			keys.add(key);
		}
	}
	return [...keys];
}

/**
 * Add the settled-decisions block to text a caller already has, after it.
 * With no block, `base` comes back unchanged, byte for byte, so a prompt
 * without answers is exactly today's.
 */
export function joinSettledDecisions(
	base: string,
	block: string | null | undefined,
): string {
	if (!block) {
		return base;
	}
	if (!base) {
		return block;
	}
	return `${base}\n\n${block}`;
}
