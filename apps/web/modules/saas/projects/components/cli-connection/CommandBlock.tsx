"use client";

import { cn } from "@ui/lib";
import { CheckIcon, CopyIcon } from "lucide-react";
import { type Ref, useRef } from "react";
import { useTransientValue } from "./lib/use-transient-value";

const COPY_LABEL = "Copy";
const COPIED_LABEL = "Copied";
const COPY_FAILED = "Copying failed. Select the text and copy it manually.";

/** How long a copy control reads "Copied" before it goes back to "Copy". */
export const COPIED_RESET_MS = 1800;

/**
 * A recessed well: ink on the light theme, a step below the panel on the dark
 * one, where a filled-ink block would turn the page's polarity upside down.
 */
const BLOCK_CLASS_NAME =
	"rounded-lg bg-foreground text-background dark:border dark:border-border dark:bg-sidebar dark:text-foreground";

/**
 * The copy control that sits inside a code block. It carries the full action
 * ("Copy the setup line") as its accessible name, because the dialog holds
 * several of them, and drops that name for "Copied" while the confirmation
 * shows so the name never contradicts the visible text.
 */
function CopyChip({
	label,
	copied,
	onCopy,
	buttonRef,
	describedBy,
}: {
	label: string;
	copied: boolean;
	onCopy: () => void;
	buttonRef?: Ref<HTMLButtonElement>;
	describedBy?: string;
}) {
	return (
		<button
			aria-describedby={describedBy}
			aria-label={copied ? undefined : label}
			className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-background/20 bg-background/10 px-2.5 font-medium text-background text-xs transition-colors hover:bg-background/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background dark:border-border dark:bg-foreground/5 dark:text-foreground dark:focus-visible:ring-ring dark:hover:bg-foreground/10"
			onClick={onCopy}
			ref={buttonRef}
			type="button"
		>
			{copied ? (
				<CheckIcon
					aria-hidden="true"
					className="size-3.5 dark:text-success"
				/>
			) : (
				<CopyIcon aria-hidden="true" className="size-3.5" />
			)}
			<span>{copied ? COPIED_LABEL : COPY_LABEL}</span>
		</button>
	);
}

/**
 * `command`: what to type, one `$`-led row per command beside an inline copy
 * control. The `$` is drawn by CSS, so it is neither selectable nor part of the
 * text. `document`: a file's contents, with the copy control pinned to the
 * corner.
 */
type CodeBlockLayout = "command" | "document";

/**
 * The code block, with its copy state owned by the caller. The dialog drives
 * the one that holds a key this way, because its "Copied" is entangled with the
 * dismissal guard; everything else goes through `CommandBlock`.
 */
export function CodeBlock({
	text,
	layout,
	testId,
	copyLabel,
	copied,
	onCopy,
	copyButtonRef,
	copyDescribedBy,
}: {
	text: string;
	layout: CodeBlockLayout;
	testId: string;
	/** Unique in the dialog: the key route has copy controls of its own. */
	copyLabel: string;
	copied: boolean;
	onCopy: () => void;
	copyButtonRef?: Ref<HTMLButtonElement>;
	copyDescribedBy?: string;
}) {
	const chip = (
		<CopyChip
			buttonRef={copyButtonRef}
			copied={copied}
			describedBy={copyDescribedBy}
			label={copyLabel}
			onCopy={onCopy}
		/>
	);

	if (layout === "document") {
		return (
			<div className={cn(BLOCK_CLASS_NAME, "relative")}>
				<pre className="whitespace-pre-wrap break-words px-3.5 py-3 font-mono text-xs leading-5">
					<code data-testid={testId}>{text}</code>
				</pre>
				<div className="absolute top-2 right-2">{chip}</div>
			</div>
		);
	}

	return (
		<div
			className={cn(
				BLOCK_CLASS_NAME,
				"flex flex-col-reverse gap-1 py-3 pr-2 pl-3.5 sm:flex-row sm:items-start sm:gap-2.5",
			)}
		>
			<div
				className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs leading-5"
				data-testid={testId}
			>
				{text.split("\n").map((line, index) => (
					<code
						className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 before:select-none before:opacity-50 before:content-['$']"
						key={`${index}-${line}`}
					>
						{line}
					</code>
				))}
			</div>
			{/* Below sm the chip sits above the command so the line gets the full width. */}
			<div className="self-end sm:self-start">{chip}</div>
		</div>
	);
}

/**
 * A command (or a file's contents) to copy, with the outcome of the copy
 * announced through the dialog's one live region (`announce`) rather than a
 * region of its own.
 */
export function CommandBlock({
	command,
	label,
	testId,
	announce,
	layout = "command",
}: {
	command: string;
	label: string;
	testId: string;
	announce: (message: string) => void;
	layout?: CodeBlockLayout;
}) {
	const [copied, raiseCopied, lowerCopied] =
		useTransientValue<true>(COPIED_RESET_MS);
	const generation = useRef(0);

	const copy = async () => {
		const current = ++generation.current;
		try {
			await navigator.clipboard.writeText(command);
			if (current === generation.current) {
				raiseCopied(true);
				announce(`${label}: copied to the clipboard.`);
			}
		} catch {
			if (current === generation.current) {
				lowerCopied();
				announce(COPY_FAILED);
			}
		}
	};

	return (
		<CodeBlock
			copied={copied !== null}
			copyLabel={label}
			layout={layout}
			onCopy={copy}
			testId={testId}
			text={command}
		/>
	);
}
