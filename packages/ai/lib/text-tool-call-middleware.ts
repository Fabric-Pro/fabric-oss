import { randomUUID } from "node:crypto";
import { logger } from "@repo/logs";
import type { LanguageModelMiddleware } from "ai";

type GenerateHook = NonNullable<LanguageModelMiddleware["wrapGenerate"]>;
type Params = Parameters<GenerateHook>[0]["params"];
type Content = Awaited<ReturnType<GenerateHook>>["content"][number];
type Part = Awaited<
	ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>
>["stream"] extends ReadableStream<infer P>
	? P
	: never;
type Call = { start: number; end: number; toolName: string; input: string };
const CLOSE = "</function>";

function offeredNames(params: Params): string[] {
	if (params.toolChoice?.type === "none") {
		return [];
	}
	const choice = params.toolChoice;
	return (params.tools ?? [])
		.filter(
			(tool) =>
				tool.type === "function" &&
				(choice?.type !== "tool" || tool.name === choice.toolName),
		)
		.map((tool) => tool.name);
}

// Tracks fenced and inline code; four-space indented code blocks are out of scope.
type CodeState = {
	fence?: { marker: string; length: number };
	inline: number;
	linePrefix?: string;
	listIndent?: number;
	blankLine: boolean;
	pendingClose: boolean;
	run?: { marker: string; length: number; fenceStart: boolean };
};
function initialCodeState(): CodeState {
	return { inline: 0, linePrefix: "", blankLine: true, pendingClose: false };
}
function copyCodeState(state: CodeState): CodeState {
	return { ...state, run: state.run ? { ...state.run } : undefined };
}

function columns(prefix: string): number {
	let count = 0;
	for (const char of prefix) {
		count += char === "\t" ? 4 - (count % 4) : 1;
	}
	return count;
}
function allowsFenceIndent(state: CodeState, indent: number): boolean {
	return (
		indent <= 3 ||
		(state.listIndent !== undefined &&
			indent >= state.listIndent &&
			indent <= state.listIndent + 3)
	);
}
function listContentIndent(
	state: CodeState,
	prefix: string,
): number | undefined {
	const item = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]{1,4}$/.exec(prefix);
	return item && allowsFenceIndent(state, columns(item[1]))
		? columns(prefix)
		: undefined;
}
function startsFence(state: CodeState): boolean {
	const prefix = state.linePrefix;
	if (prefix === undefined) {
		return false;
	}
	if (/^[ \t]*$/.test(prefix)) {
		return allowsFenceIndent(state, columns(prefix));
	}
	return !state.fence && listContentIndent(state, prefix) !== undefined;
}
function trackLinePrefix(state: CodeState, char: string) {
	const prefix = state.linePrefix;
	if (prefix === undefined) {
		return;
	}
	const next = prefix + char;
	const leading = /^[ \t]*/.exec(next)?.[0] ?? "";
	if (
		columns(leading) <= Math.max(3, (state.listIndent ?? 0) + 3) &&
		/^[ \t]*(?:(?:[-*+]|\d{1,9}[.)]?)[ \t]{0,4})?$/.test(next)
	) {
		state.linePrefix = next;
		return;
	}
	if (!state.fence) {
		const indent = listContentIndent(state, prefix);
		if (indent !== undefined) {
			state.listIndent = indent;
		} else if (columns(leading) < (state.listIndent ?? 0)) {
			state.listIndent = undefined;
		}
	}
	state.linePrefix = undefined;
}

/** Resolve marker runs on the next character, so split runs need no text buffering. */
function resolveCodeRun(state: CodeState) {
	const run = state.run;
	if (!run) {
		return;
	}
	state.run = undefined;
	if (run.fenceStart && run.length >= 3) {
		if (!state.fence) {
			state.fence = { marker: run.marker, length: run.length };
			state.inline = 0;
		} else if (
			state.fence.marker === run.marker &&
			run.length >= state.fence.length
		) {
			// The newline confirms this close if the remaining line stays whitespace-only.
			state.pendingClose = true;
		}
	} else if (!state.fence && run.marker === "`") {
		if (state.inline === 0) {
			state.inline = run.length;
		} else if (state.inline === run.length) {
			state.inline = 0;
		}
	}
}
function codeCharacter(state: CodeState, char: string): boolean {
	if (state.run && state.run.marker !== char) {
		resolveCodeRun(state);
	}
	if (state.pendingClose && !/\s/.test(char)) {
		state.pendingClose = false;
	}
	const quoted = Boolean(state.fence || state.inline);
	if (char === "\n") {
		if (state.pendingClose) {
			state.fence = undefined;
			state.inline = 0;
		}
		state.pendingClose = false;
		if (state.blankLine) {
			state.inline = 0;
		}
		state.linePrefix = "";
		state.blankLine = true;
	} else {
		if (char === "`" || char === "~") {
			if (state.run) {
				state.run.length++;
			} else {
				state.run = {
					marker: char,
					length: 1,
					fenceStart: startsFence(state),
				};
			}
		}
		trackLinePrefix(state, char);
		if (!/\s/.test(char)) {
			state.blankLine = false;
		}
	}
	return quoted;
}

function advanceCode(state: CodeState, text: string) {
	for (const char of text) {
		codeCharacter(state, char);
	}
}

/** Locate complete calls and the first suffix that could still become one. */
function scan(
	text: string,
	names: string[],
	final: boolean,
	initial = initialCodeState(),
) {
	const code = copyCodeState(initial);
	const calls: Call[] = [];
	let pending = text.length;
	for (let start = 0; start < text.length; start++) {
		const quoted = codeCharacter(code, text[start]);
		if (text[start] !== "<" || quoted) {
			continue;
		}
		const tail = text.slice(start);
		const name = names.find((n) => tail.startsWith(`<function=${n}>`));
		if (!name) {
			if (
				!final &&
				names.some((n) => `<function=${n}>`.startsWith(tail))
			) {
				pending = start;
				break;
			}
			continue;
		}
		const argsStart = start + `<function=${name}>`.length;
		let cursor = argsStart;
		while (/\s/.test(text[cursor] ?? "") && cursor < text.length) {
			cursor++;
		}
		if (cursor === text.length) {
			if (!final) {
				pending = start;
			}
			break;
		}
		if (text[cursor] !== "{") {
			continue;
		}
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (; cursor < text.length; cursor++) {
			const char = text[cursor];
			if (inString) {
				if (escaped) {
					escaped = false;
				} else if (char === "\\") {
					escaped = true;
				} else if (char === '"') {
					inString = false;
				}
			} else if (char === '"') {
				inString = true;
			} else if (char === "{" || char === "[") {
				depth++;
			} else if (char === "}" || char === "]") {
				depth--;
				if (depth === 0) {
					cursor++;
					break;
				}
			} else if (char === "<") {
				break;
			}
		}
		if (depth !== 0) {
			if (cursor === text.length && !final) {
				pending = start;
				break;
			}
			continue;
		}
		const input = text.slice(argsStart, cursor).trim();
		try {
			const value: unknown = JSON.parse(input);
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				continue;
			}
		} catch {
			continue;
		}
		while (cursor < text.length && /\s/.test(text[cursor])) {
			cursor++;
		}
		if (!text.startsWith(CLOSE, cursor)) {
			if (!final && CLOSE.startsWith(text.slice(cursor))) {
				pending = start;
				break;
			}
			continue;
		}
		const end = cursor + CLOSE.length;
		calls.push({ start, end, toolName: name, input });
		// Arguments are tool input, so backticks in JSON do not open prose code spans.
		code.linePrefix = undefined;
		code.blankLine = false;
		start = end - 1;
	}
	return { calls, pending, code };
}

function toolCall(call: Call): Extract<Content, { type: "tool-call" }> {
	return {
		type: "tool-call",
		toolCallId: randomUUID(),
		toolName: call.toolName,
		input: call.input,
	};
}
function report(calls: Call[], modelId: string, droppedCharacters: number) {
	for (const call of calls) {
		logger.info("ai.text_tool_call.recovered", {
			toolName: call.toolName,
			modelId,
			count: calls.length,
			droppedCharacters,
		});
	}
}
function rewriteText(
	text: string,
	calls: Call[],
	emitText: (text: string) => void,
	emitCall: (call: Call) => void,
) {
	let cursor = 0;
	for (const call of calls) {
		if (cursor < call.start) {
			emitText(text.slice(cursor, call.start));
		}
		emitCall(call);
		cursor = call.end;
	}
	if (cursor < text.length) {
		emitText(text.slice(cursor));
	}
}

/** Response-only recovery, after provider compatibility and reasoning extraction. */
export function createTextToolCallRecoveryMiddleware(): LanguageModelMiddleware {
	return {
		specificationVersion: "v4",
		wrapGenerate: async ({ doGenerate, params, model }) => {
			const result = await doGenerate();
			const names = offeredNames(params);
			if (
				!names.length ||
				result.content.some((p) => p.type === "tool-call")
			) {
				return result;
			}
			const content: Content[] = [];
			const recovered: Call[] = [];
			const callsByPart: Call[][] = [];
			let code = initialCodeState();
			let lastCallPart = -1;
			for (const [index, part] of result.content.entries()) {
				const found =
					part.type === "text"
						? scan(part.text, names, true, code)
						: { calls: [], code };
				code = found.code;
				callsByPart.push(found.calls);
				recovered.push(...found.calls);
				if (found.calls.length) {
					lastCallPart = index;
				}
			}
			if (lastCallPart < 0) {
				return result;
			}
			let droppedCharacters = 0;
			for (const [index, part] of result.content.entries()) {
				if (part.type !== "text") {
					content.push(part);
					continue;
				}
				const calls = callsByPart[index];
				const keepEnd =
					index < lastCallPart
						? part.text.length
						: index === lastCallPart
							? calls[calls.length - 1].end
							: 0;
				droppedCharacters += part.text.length - keepEnd;
				rewriteText(
					part.text.slice(0, keepEnd),
					calls,
					(text) => content.push({ ...part, text }),
					(call) => content.push(toolCall(call)),
				);
			}
			report(recovered, model.modelId, droppedCharacters);
			return {
				...result,
				content,
				finishReason: { ...result.finishReason, unified: "tool-calls" },
			};
		},
		wrapStream: async ({ doStream, params, model }) => {
			const result = await doStream();
			const names = offeredNames(params);
			if (!names.length) {
				return result;
			}
			return {
				...result,
				stream: recoverStream(result.stream, names, model.modelId),
			};
		},
	};
}

/** Hold a candidate suffix until finish so a later native call can veto recovery. */
function recoverStream(
	stream: ReadableStream<Part>,
	names: string[],
	modelId: string,
): ReadableStream<Part> {
	const reader = stream.getReader();
	let buffered: Part[] = [];
	let candidateText = "";
	const code = initialCodeState();
	let committedCandidate = false;
	let native = false;
	let closed = false;
	const output: Part[] = [];

	const release = () => {
		for (const part of buffered) {
			if (part.type === "text-delta") {
				advanceCode(code, part.delta);
			}
			output.push(part);
		}
		buffered = [];
		candidateText = "";
	};
	const releasePrefix = (prefixLength: number) => {
		let length = prefixLength;
		candidateText = candidateText.slice(length);
		while (length > 0 && buffered.length) {
			const part = buffered.shift() as Part;
			if (part.type !== "text-delta") {
				output.push(part);
				continue;
			}
			const take = Math.min(length, part.delta.length);
			advanceCode(code, part.delta.slice(0, take));
			output.push({ ...part, delta: part.delta.slice(0, take) });
			if (take < part.delta.length) {
				buffered.unshift({
					...part,
					delta: part.delta.slice(take),
				});
			}
			length -= take;
		}
	};
	const recover = () => {
		// Text IDs delimit blocks: a tag cannot straddle text-end/text-start.
		const texts = new Map<string, string>();
		for (const p of buffered) {
			if (p.type === "text-delta") {
				texts.set(p.id, (texts.get(p.id) ?? "") + p.delta);
			}
		}
		const callsById = new Map<string, Call[]>();
		let blockCode = copyCodeState(code);
		for (const [id, text] of texts) {
			const found = scan(text, names, true, blockCode);
			callsById.set(id, found.calls);
			blockCode = found.code;
		}
		const calls = [...callsById.values()].flat();
		if (!calls.length) {
			release();
			return false;
		}
		let remainingCalls = calls.length;
		let droppedCharacters = 0;
		const offsets = new Map<string, number>();
		for (const p of buffered) {
			if (p.type !== "text-delta") {
				output.push(p);
				continue;
			}
			const offset = offsets.get(p.id) ?? 0;
			const end = offset + p.delta.length;
			let cursor = offset;
			for (const call of callsById.get(p.id) ?? []) {
				if (call.end <= offset || call.start >= end) {
					continue;
				}
				if (cursor < call.start) {
					output.push({
						...p,
						delta: p.delta.slice(
							cursor - offset,
							call.start - offset,
						),
					});
				}
				cursor = Math.min(call.end, end);
				if (call.end <= end) {
					remainingCalls--;
					const recovered = toolCall(call);
					output.push(
						{
							type: "tool-input-start",
							id: recovered.toolCallId,
							toolName: recovered.toolName,
						},
						{
							type: "tool-input-delta",
							id: recovered.toolCallId,
							delta: recovered.input,
						},
						{
							type: "tool-input-end",
							id: recovered.toolCallId,
						},
						recovered,
					);
				}
			}
			if (cursor < end) {
				if (remainingCalls === 0) {
					droppedCharacters += end - cursor;
				} else {
					output.push({
						...p,
						delta: p.delta.slice(cursor - offset),
					});
				}
			}
			offsets.set(p.id, end);
		}
		report(calls, modelId, droppedCharacters);
		buffered = [];
		return true;
	};

	const accept = (incoming: Part) => {
		let part = incoming;
		if (part.type === "tool-call" || part.type === "tool-input-start") {
			native = true;
			release();
		}
		if (native) {
			output.push(part);
			return;
		}
		if (part.type === "finish") {
			const didRecover = recover();
			output.push(
				didRecover
					? {
							...part,
							finishReason: {
								...part.finishReason,
								unified: "tool-calls",
							},
						}
					: part,
			);
			return;
		}
		if (part.type === "error") {
			release();
			output.push(part);
			native = true;
			return;
		}
		if (part.type === "text-delta") {
			if (!buffered.length) {
				const start = part.delta.indexOf("<");
				if (start < 0) {
					advanceCode(code, part.delta);
					output.push(part);
					return;
				}
				if (start > 0) {
					advanceCode(code, part.delta.slice(0, start));
					output.push({
						...part,
						delta: part.delta.slice(0, start),
					});
				}
				part = {
					...part,
					delta: part.delta.slice(start),
				};
			}
			buffered.push(part);
			if (!committedCandidate) {
				candidateText += part.delta;
				const { calls, pending } = scan(
					candidateText,
					names,
					false,
					code,
				);
				committedCandidate = calls.length > 0;
				if (!committedCandidate && pending === candidateText.length) {
					release();
				} else {
					releasePrefix(calls[0]?.start ?? pending);
				}
			}
		} else if (buffered.length) {
			if (part.type === "text-end") {
				if (!committedCandidate) {
					release();
				}
				candidateText = "";
			}
			if (buffered.length) {
				buffered.push(part);
			} else {
				output.push(part);
			}
		} else {
			output.push(part);
		}
	};
	return new ReadableStream<Part>(
		{
			async pull(controller) {
				try {
					while (!output.length && !closed) {
						const next = await reader.read();
						if (next.done) {
							// Without a finish part there is no completed step to recover.
							release();
							closed = true;
							reader.releaseLock();
							break;
						}
						accept(next.value);
					}
					if (output.length) {
						controller.enqueue(output.shift() as Part);
					} else if (closed) {
						controller.close();
					}
				} catch (error) {
					controller.error(error);
				}
			},
			async cancel(reason) {
				if (!closed) {
					try {
						await reader.cancel(reason);
					} finally {
						reader.releaseLock();
					}
				}
			},
		},
		{ highWaterMark: 0 },
	);
}
