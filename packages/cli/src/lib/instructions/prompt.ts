/**
 * The two questions `fabric instructions` ever asks a person: which of
 * several projects, and whether to clone into an empty folder. Both go to
 * stderr and read one line from stdin, so a command's stdout stays what a
 * script expects. Neither is ever asked without a terminal on both ends.
 */
import { createInterface } from "node:readline/promises";
import type { ProjectChoice } from "./outcome.js";

export interface PromptStreams {
	input: NodeJS.ReadableStream;
	output: NodeJS.WritableStream;
}

/** Whether a person is there to answer. */
export function canPrompt(
	streams: { stdin?: { isTTY?: boolean }; stderr?: { isTTY?: boolean } } = {
		stdin: process.stdin,
		stderr: process.stderr,
	},
): boolean {
	return streams.stdin?.isTTY === true && streams.stderr?.isTTY === true;
}

async function ask(question: string, streams: PromptStreams): Promise<string> {
	const reader = createInterface({
		input: streams.input,
		output: streams.output,
	});
	try {
		return (await reader.question(question)).trim();
	} finally {
		reader.close();
	}
}

/** The zero-based index of the project chosen, or `null` for anything but a listed number. */
export async function chooseProject(
	projects: ProjectChoice[],
	streams: PromptStreams = { input: process.stdin, output: process.stderr },
): Promise<number | null> {
	streams.output.write(
		`This repository is connected to ${projects.length} projects:\n`,
	);
	for (const [index, project] of projects.entries()) {
		streams.output.write(`  [${index + 1}] ${project.label}\n`);
	}
	const answer = await ask(`Which one? [1-${projects.length}] `, streams);
	const number = /^\d+$/.test(answer) ? Number(answer) : 0;
	return number >= 1 && number <= projects.length ? number - 1 : null;
}

/** Whether the person said yes. Anything but `y` or `yes` is no. */
export async function confirm(
	question: string,
	streams: PromptStreams = { input: process.stdin, output: process.stderr },
): Promise<boolean> {
	return /^y(es)?$/i.test(await ask(`${question} [y/N] `, streams));
}
