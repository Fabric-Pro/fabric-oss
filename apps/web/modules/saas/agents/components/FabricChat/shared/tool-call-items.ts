import type { ToolCallItem } from "./types";

const listCache = new WeakMap<object, Map<string, ToolCallItem[]>>();
const itemCache = new WeakMap<object, Map<string, ToolCallItem>>();

function cached<V>(
	cache: WeakMap<object, Map<string, V>>,
	owner: object,
	key: string,
	build: () => V,
): V {
	let byKey = cache.get(owner);
	if (!byKey) {
		byKey = new Map();
		cache.set(owner, byKey);
	}
	let value = byKey.get(key);
	if (value === undefined) {
		value = build();
		byKey.set(key, value);
	}
	return value;
}

/**
 * `ToolCallItem`s for a chat's tool calls that keep their identity while the
 * source objects do. Stream updates replace only what changed, so a memoized
 * `ToolCallList` (and each of its rows) re-renders only for a tool call that
 * actually moved (Fizzy #2430).
 *
 * `key` names the mapping (e.g. the message or step id): the same source array
 * rendered by two call sites with different ids gets two cached lists.
 */
export function toToolCallItems<A extends readonly object[]>(
	toolCalls: A,
	key: string,
	toItem: (toolCall: A[number], index: number) => ToolCallItem,
): ToolCallItem[] {
	return cached(listCache, toolCalls, key, () =>
		toolCalls.map((toolCall, index) =>
			cached(itemCache, toolCall, `${key}:${index}`, () =>
				toItem(toolCall, index),
			),
		),
	);
}
