type State =
	| "ROOT"
	| "FINISH"
	| "INSIDE_STRING"
	| "INSIDE_STRING_ESCAPE"
	| "INSIDE_LITERAL"
	| "INSIDE_NUMBER"
	| "INSIDE_OBJECT_START"
	| "INSIDE_OBJECT_KEY"
	| "INSIDE_OBJECT_AFTER_KEY"
	| "INSIDE_OBJECT_BEFORE_VALUE"
	| "INSIDE_OBJECT_AFTER_VALUE"
	| "INSIDE_OBJECT_AFTER_COMMA"
	| "INSIDE_ARRAY_START"
	| "INSIDE_ARRAY_AFTER_VALUE"
	| "INSIDE_ARRAY_AFTER_COMMA";

function fixJson(input: string): string {
	const stack: State[] = ["ROOT"];
	let lastValidIndex = -1;
	let literalStart: number | null = null;

	function processValueStart(char: string, i: number, swapState: State) {
		switch (char) {
			case '"':
				lastValidIndex = i;
				stack.pop();
				stack.push(swapState);
				stack.push("INSIDE_STRING");
				break;
			case "f":
			case "t":
			case "n":
				lastValidIndex = i;
				literalStart = i;
				stack.pop();
				stack.push(swapState);
				stack.push("INSIDE_LITERAL");
				break;
			case "-":
				stack.pop();
				stack.push(swapState);
				stack.push("INSIDE_NUMBER");
				break;
			case "0":
			case "1":
			case "2":
			case "3":
			case "4":
			case "5":
			case "6":
			case "7":
			case "8":
			case "9":
				lastValidIndex = i;
				stack.pop();
				stack.push(swapState);
				stack.push("INSIDE_NUMBER");
				break;
			case "{":
				lastValidIndex = i;
				stack.pop();
				stack.push(swapState);
				stack.push("INSIDE_OBJECT_START");
				break;
			case "[":
				lastValidIndex = i;
				stack.pop();
				stack.push(swapState);
				stack.push("INSIDE_ARRAY_START");
				break;
		}
	}

	function processAfterObjectValue(char: string, i: number) {
		if (char === ",") {
			stack.pop();
			stack.push("INSIDE_OBJECT_AFTER_COMMA");
		} else if (char === "}") {
			lastValidIndex = i;
			stack.pop();
		}
	}

	function processAfterArrayValue(char: string, i: number) {
		if (char === ",") {
			stack.pop();
			stack.push("INSIDE_ARRAY_AFTER_COMMA");
		} else if (char === "]") {
			lastValidIndex = i;
			stack.pop();
		}
	}

	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		const currentState = stack[stack.length - 1];

		switch (currentState) {
			case "ROOT":
				processValueStart(char, i, "FINISH");
				break;
			case "INSIDE_OBJECT_START":
				if (char === '"') {
					stack.pop();
					stack.push("INSIDE_OBJECT_KEY");
				} else if (char === "}") {
					lastValidIndex = i;
					stack.pop();
				}
				break;
			case "INSIDE_OBJECT_AFTER_COMMA":
				if (char === '"') {
					stack.pop();
					stack.push("INSIDE_OBJECT_KEY");
				}
				break;
			case "INSIDE_OBJECT_KEY":
				if (char === '"') {
					stack.pop();
					stack.push("INSIDE_OBJECT_AFTER_KEY");
				}
				break;
			case "INSIDE_OBJECT_AFTER_KEY":
				if (char === ":") {
					stack.pop();
					stack.push("INSIDE_OBJECT_BEFORE_VALUE");
				}
				break;
			case "INSIDE_OBJECT_BEFORE_VALUE":
				processValueStart(char, i, "INSIDE_OBJECT_AFTER_VALUE");
				break;
			case "INSIDE_OBJECT_AFTER_VALUE":
				processAfterObjectValue(char, i);
				break;
			case "INSIDE_STRING":
				if (char === '"') {
					stack.pop();
					lastValidIndex = i;
				} else if (char === "\\") {
					stack.push("INSIDE_STRING_ESCAPE");
				} else {
					lastValidIndex = i;
				}
				break;
			case "INSIDE_ARRAY_START":
				if (char === "]") {
					lastValidIndex = i;
					stack.pop();
				} else {
					lastValidIndex = i;
					processValueStart(char, i, "INSIDE_ARRAY_AFTER_VALUE");
				}
				break;
			case "INSIDE_ARRAY_AFTER_VALUE":
				if (char === ",") {
					stack.pop();
					stack.push("INSIDE_ARRAY_AFTER_COMMA");
				} else if (char === "]") {
					lastValidIndex = i;
					stack.pop();
				} else {
					lastValidIndex = i;
				}
				break;
			case "INSIDE_ARRAY_AFTER_COMMA":
				processValueStart(char, i, "INSIDE_ARRAY_AFTER_VALUE");
				break;
			case "INSIDE_STRING_ESCAPE":
				stack.pop();
				lastValidIndex = i;
				break;
			case "INSIDE_NUMBER":
				switch (char) {
					case "0":
					case "1":
					case "2":
					case "3":
					case "4":
					case "5":
					case "6":
					case "7":
					case "8":
					case "9":
						lastValidIndex = i;
						break;
					case "e":
					case "E":
					case "-":
					case ".":
						break;
					case ",":
						stack.pop();
						if (
							stack[stack.length - 1] ===
							"INSIDE_ARRAY_AFTER_VALUE"
						) {
							processAfterArrayValue(char, i);
						}
						if (
							stack[stack.length - 1] ===
							"INSIDE_OBJECT_AFTER_VALUE"
						) {
							processAfterObjectValue(char, i);
						}
						break;
					case "}":
						stack.pop();
						if (
							stack[stack.length - 1] ===
							"INSIDE_OBJECT_AFTER_VALUE"
						) {
							processAfterObjectValue(char, i);
						}
						break;
					case "]":
						stack.pop();
						if (
							stack[stack.length - 1] ===
							"INSIDE_ARRAY_AFTER_VALUE"
						) {
							processAfterArrayValue(char, i);
						}
						break;
					default:
						stack.pop();
						break;
				}
				break;
			case "INSIDE_LITERAL": {
				// biome-ignore lint/style/noNonNullAssertion: literalStart is set before entering INSIDE_LITERAL state
				const partialLiteral = input.substring(literalStart!, i + 1);
				if (
					!"false".startsWith(partialLiteral) &&
					!"true".startsWith(partialLiteral) &&
					!"null".startsWith(partialLiteral)
				) {
					stack.pop();
					if (
						stack[stack.length - 1] === "INSIDE_OBJECT_AFTER_VALUE"
					) {
						processAfterObjectValue(char, i);
					} else if (
						stack[stack.length - 1] === "INSIDE_ARRAY_AFTER_VALUE"
					) {
						processAfterArrayValue(char, i);
					}
				} else {
					lastValidIndex = i;
				}
				break;
			}
		}
	}

	let result = input.slice(0, lastValidIndex + 1);
	for (let i = stack.length - 1; i >= 0; i--) {
		const state = stack[i];
		switch (state) {
			case "INSIDE_STRING":
				result += '"';
				break;
			case "INSIDE_OBJECT_KEY":
			case "INSIDE_OBJECT_AFTER_KEY":
			case "INSIDE_OBJECT_AFTER_COMMA":
			case "INSIDE_OBJECT_START":
			case "INSIDE_OBJECT_BEFORE_VALUE":
			case "INSIDE_OBJECT_AFTER_VALUE":
				result += "}";
				break;
			case "INSIDE_ARRAY_START":
			case "INSIDE_ARRAY_AFTER_COMMA":
			case "INSIDE_ARRAY_AFTER_VALUE":
				result += "]";
				break;
			case "INSIDE_LITERAL": {
				const partialLiteral = input.substring(
					// biome-ignore lint/style/noNonNullAssertion: literalStart is set before entering this state
					literalStart!,
					input.length,
				);
				if ("true".startsWith(partialLiteral)) {
					result += "true".slice(partialLiteral.length);
				} else if ("false".startsWith(partialLiteral)) {
					result += "false".slice(partialLiteral.length);
				} else if ("null".startsWith(partialLiteral)) {
					result += "null".slice(partialLiteral.length);
				}
				break;
			}
		}
	}

	return result;
}

export function parsePartialJson(jsonText: string | undefined): {
	value: unknown;
	state:
		| "undefined-input"
		| "successful-parse"
		| "repaired-parse"
		| "failed-parse";
} {
	if (jsonText === undefined) {
		return { value: undefined, state: "undefined-input" };
	}

	try {
		return {
			value: JSON.parse(jsonText),
			state: "successful-parse",
		};
	} catch {
		try {
			return {
				value: JSON.parse(fixJson(jsonText)),
				state: "repaired-parse",
			};
		} catch {
			return {
				value: undefined,
				state: "failed-parse",
			};
		}
	}
}
