/**
 * A short checklist for a command that does several things in a row (`init`):
 * one line per step with a status mark, then only what the person still has to
 * do, numbered. Steps are collected while the command runs and rendered once
 * at the end, so the result reads at a glance instead of as a wall of prose.
 *
 * The full sentences each step used to print are kept as `details`, shown
 * under the step with `--verbose`.
 */

/** done, needs your attention, failed, skipped. */
export type StepStatus = "ok" | "action" | "failed" | "skipped";

export interface SummaryStep {
	status: StepStatus;
	label: string;
	detail: string;
	/** The long form, shown under the step with `--verbose`. */
	details: string[];
}

export interface NextStep {
	text: string;
	/** Each printed on its own line, so it can be copied as is. */
	commands?: string[];
}

export class Summary {
	readonly steps: SummaryStep[] = [];
	readonly next: NextStep[] = [];

	/** Adds a step and returns it; a later outcome may still change it. */
	add(
		status: StepStatus,
		label: string,
		detail: string,
		details: string[] = [],
	): SummaryStep {
		const step = { status, label, detail, details: [...details] };
		this.steps.push(step);
		return step;
	}

	/** Something only the person can do; listed under "Next steps". */
	todo(text: string, commands?: string[]): void {
		this.next.push(commands === undefined ? { text } : { text, commands });
	}

	get failed(): number {
		return this.steps.filter((step) => step.status === "failed").length;
	}
}

const UNICODE_MARKS: Record<StepStatus, string> = {
	ok: "✓",
	action: "!",
	failed: "✗",
	skipped: "–",
};

const ASCII_MARKS: Record<StepStatus, string> = {
	ok: "[ok]",
	action: "[!]",
	failed: "[x]",
	skipped: "[-]",
};

/**
 * Whether the terminal can show ✓ ✗ – →. Elsewhere than Windows it can; on
 * Windows only the terminals known to (Windows Terminal, VS Code, ConEmu,
 * JetBrains, mintty and other emulators that set TERM), not the old console
 * host. `FABRIC_ASCII=1` forces the plain marks anywhere.
 */
export function supportsUnicodeMarks(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (env.FABRIC_ASCII === "1" || env.FABRIC_ASCII === "true") {
		return false;
	}
	if (env.TERM === "linux") {
		return false;
	}
	if (platform !== "win32") {
		return true;
	}
	return (
		Boolean(env.WT_SESSION) ||
		Boolean(env.TERMINUS_SUBLIME) ||
		env.ConEmuTask === "{cmd::Cmder}" ||
		env.ConEmuANSI === "ON" ||
		env.TERM_PROGRAM === "vscode" ||
		env.TERM_PROGRAM === "Terminus-Sublime" ||
		env.TERMINAL_EMULATOR === "JetBrains-JediTerm" ||
		env.TERM === "xterm-256color" ||
		env.TERM === "alacritty" ||
		env.TERM === "rxvt-unicode" ||
		env.TERM === "rxvt-unicode-256color"
	);
}

export interface RenderOptions {
	/** Plain marks for a terminal that cannot show ✓ ✗ – →. */
	ascii?: boolean;
	/** Each step's long form under it. */
	verbose?: boolean;
	/** Said when nothing is left to do, and as the last next step otherwise. */
	finally?: string;
}

/** A detail may say `→`; it is shown as `->` where the marks are plain. */
export function renderSummary(
	summary: Summary,
	options: RenderOptions = {},
): string {
	const ascii = options.ascii ?? false;
	const marks = ascii ? ASCII_MARKS : UNICODE_MARKS;
	const markWidth = Math.max(
		...Object.values(marks).map((mark) => mark.length),
	);
	const labelWidth =
		Math.max(0, ...summary.steps.map((step) => step.label.length)) + 2;
	const lines: string[] = [];
	for (const step of summary.steps) {
		const mark = marks[step.status].padEnd(markWidth);
		lines.push(
			`${mark} ${step.label.padEnd(labelWidth)}${plain(step.detail, ascii)}`.trimEnd(),
		);
		if (options.verbose) {
			for (const detail of step.details) {
				lines.push(`${" ".repeat(markWidth + 3)}${detail}`);
			}
		}
	}
	const next = [...summary.next];
	if (next.length === 0) {
		if (options.finally !== undefined) {
			lines.push("", `All set. ${options.finally}`);
		}
		return lines.join("\n");
	}
	if (options.finally !== undefined) {
		next.push({ text: options.finally });
	}
	lines.push("", "Next steps:");
	next.forEach((item, index) => {
		const number = `${index + 1}. `;
		lines.push(`  ${number}${item.text}`);
		for (const command of item.commands ?? []) {
			lines.push(`  ${" ".repeat(number.length)}  ${command}`);
		}
	});
	return lines.join("\n");
}

function plain(text: string, ascii: boolean): string {
	return ascii ? text.replaceAll("→", "->").replaceAll("–", "-") : text;
}
