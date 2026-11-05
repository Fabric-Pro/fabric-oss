/**
 * Card listings in report data gathering: recognising them, walking every page
 * without a model turn, and the shapes a card takes as it moves from the source
 * to the model's context and to the returned payload.
 *
 * Pure apart from the page fetch the caller injects. Used by the agent loop and
 * by the gathered-data budget, which cannot import the loop's AI and MCP
 * dependencies.
 */

/**
 * Hard stop on one listing's page walk. Page size is server-controlled, so this
 * is a runaway guard rather than a card budget: observed later pages hold 100
 * cards, so 50 pages is about 5,000 cards in one listing.
 */
export const MAX_LISTING_PAGES = 50;

/** Longest text kept on a stored card. Matches the budget's Stage A cut. */
const MAX_STORED_TEXT_CHARS = 1000;

/**
 * Longest text kept on a card fetched on its own. The model fetches a card to
 * quote it, so this allows real prose. The budget bounds the total.
 */
const MAX_FETCHED_CARD_TEXT_CHARS = 4000;

/** Longest title on a card at the budget's last rung. */
const MINIMAL_CARD_TITLE_CHARS = 80;

/** Longest scalar kept on a list item in the model's context. */
const MAX_LIST_ITEM_TEXT_CHARS = 200;

/** Arguments that never change which cards a listing returns. */
const NON_LISTING_ARGS = new Set(["page", "fields", "account_slug"]);

/**
 * Tools whose list results may arrive as a page envelope. Anchored at the end
 * of the name so `fizzy_get_cards` / `trello_list_cards` match but a
 * differently-shaped `get_cards_summary` does not.
 */
export function isCardListTool(toolName: string): boolean {
	return /(?:get|list)_cards$/i.test(toolName);
}

/** Tools that return one card. `fizzy_get_card_comments` does not match. */
export function isSingleCardTool(toolName: string): boolean {
	return /(?:get|fetch)_card$/i.test(toolName);
}

/**
 * Unwrap a card-list result that may be a page envelope
 * ({ cards, page, total_count, has_more, next_page }) or a bare card array.
 * Returns null when the value is neither.
 */
export function extractCardsArray(value: unknown): unknown[] | null {
	if (Array.isArray(value)) {
		return value;
	}
	if (value && typeof value === "object") {
		const cards = (value as { cards?: unknown }).cards;
		if (Array.isArray(cards)) {
			return cards;
		}
	}
	return null;
}

/**
 * Pagination fields of a page envelope, when present. Only reads
 * envelope-shaped values (object with an array `cards`).
 */
export function extractPageMeta(
	value: unknown,
): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const bag = value as Record<string, unknown>;
	if (!Array.isArray(bag.cards)) {
		return null;
	}
	const meta: Record<string, unknown> = {};
	for (const key of ["page", "total_count", "has_more", "next_page"]) {
		if (key in bag) {
			meta[key] = bag[key];
		}
	}
	return Object.keys(meta).length > 0 ? meta : null;
}

export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Slice by code point, not UTF-16 unit: a plain `slice` can cut an emoji in half
 * and leave a lone surrogate behind.
 */
function clipText(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	const codePoints = Array.from(text);
	return codePoints.length > maxChars
		? `${codePoints.slice(0, maxChars).join("")}…`
		: text;
}

/**
 * Slim a card down to the fields reports reason about, so a ~33KB raw card
 * (HTML description, avatar URLs, nested creator objects) becomes a few
 * hundred bytes.
 */
export function projectCardForContext(card: unknown): unknown {
	if (!isPlainObject(card)) {
		return card;
	}
	const projected: Record<string, unknown> = {};
	for (const key of [
		"id",
		"number",
		"title",
		"name",
		"status",
		"state",
		"closed",
		"postponed",
		"golden",
		"due_on",
		"due_date",
		"due",
		"created_at",
		"closed_at",
		"updated_at",
		"last_active_at",
		"url",
		"description_preview",
	]) {
		if (card[key] !== undefined) {
			projected[key] = card[key];
		}
	}
	if (isPlainObject(card.board)) {
		projected.board = { id: card.board.id, name: card.board.name };
	}
	if (isPlainObject(card.column)) {
		projected.column = { id: card.column.id, name: card.column.name };
	} else if (typeof card.column === "string") {
		projected.column = card.column;
	}
	if (Array.isArray(card.assignees)) {
		projected.assignees = card.assignees.map((a) =>
			isPlainObject(a) ? { id: a.id, name: a.name } : a,
		);
	}
	if (Array.isArray(card.tags)) {
		projected.tags = card.tags;
	}
	if (typeof card.description === "string" && card.description.length > 0) {
		projected.description = clipText(card.description, 280);
	}
	return projected;
}

/**
 * The rung between a projected card and its steering fields: everything a
 * report counts or groups by, without the text, links and repeated ids.
 */
export function slimCardForBudget(card: unknown): unknown {
	if (!isPlainObject(card)) {
		return card;
	}
	const {
		description: _description,
		description_preview: _preview,
		url: _url,
		board: _board,
		column,
		assignees,
		...rest
	} = card;
	const slim: Record<string, unknown> = rest;
	if (isPlainObject(column)) {
		slim.column = { name: column.name };
	} else if (typeof column === "string") {
		slim.column = column;
	}
	if (Array.isArray(assignees)) {
		slim.assignees = assignees.map((a) =>
			isPlainObject(a) ? { name: a.name } : a,
		);
	}
	return slim;
}

/** The fields the model needs to decide what to fetch next. */
export function cardSteeringFields(card: unknown): unknown {
	if (!isPlainObject(card)) {
		return card;
	}
	// A closed or postponed flag takes the place of the publication status, which
	// keeps a large board in budget. Without the flag a card shortened to these
	// fields could be open: its state is what says its dates do not matter.
	const stateFlags = ["closed", "postponed"].filter(
		(key) => card[key] === true,
	);
	const steering: Record<string, unknown> = {};
	for (const key of [
		"id",
		"number",
		"title",
		"name",
		...(stateFlags.length > 0 ? [] : ["status"]),
	]) {
		if (card[key] !== undefined) {
			steering[key] = card[key];
		}
	}
	if (isPlainObject(card.column)) {
		steering.column = card.column.name;
	} else if (typeof card.column === "string") {
		steering.column = card.column;
	}
	for (const key of stateFlags) {
		steering[key] = true;
	}
	return steering;
}

/** The budget's last rung: what names a card, before any card is given up. */
export function cardMinimalFields(card: unknown): unknown {
	if (!isPlainObject(card)) {
		return card;
	}
	const minimal: Record<string, unknown> =
		card.number !== undefined ? { number: card.number } : { id: card.id };
	const title = card.title ?? card.name;
	if (typeof title === "string") {
		minimal.title = clipText(title, MINIMAL_CARD_TITLE_CHARS);
	}
	return minimal;
}

/**
 * The context copy of a card page whose projection is still over the limit:
 * each card cut to its steering fields, keeping as many as serialize within
 * `maxChars`. Deterministic on purpose, because an LLM summary of each page
 * took about a minute and the stored cards are kept regardless.
 */
export function fitCardsToContext(
	projected: unknown[],
	maxChars: number,
): { cards: unknown[]; omitted: number } {
	const cards: unknown[] = [];
	// The array's brackets, then each card with its separating comma.
	let length = 2;
	for (const card of projected) {
		const steering = cardSteeringFields(card);
		const cardLength = JSON.stringify(steering).length + 1;
		if (length + cardLength <= maxChars) {
			cards.push(steering);
			length += cardLength;
		}
	}
	return { cards, omitted: projected.length - cards.length };
}

/** A nested record reduced to what identifies it. */
function reduceNestedRecord(
	value: Record<string, unknown>,
): Record<string, unknown> {
	const reduced: Record<string, unknown> = {};
	for (const key of ["id", "name", "title", "key", "login"]) {
		if (value[key] !== undefined) {
			reduced[key] = value[key];
		}
	}
	return Object.keys(reduced).length > 0 ? reduced : value;
}

/**
 * The copy of a card kept for the rest of the run. Applied as each page arrives,
 * so a large board does not hold tens of megabytes of HTML and nested records
 * until the end. Keeps every field by default, because other providers' cards
 * use field names this module has never seen.
 */
export function shrinkCardForStorage(
	card: unknown,
	maxTextChars: number = MAX_STORED_TEXT_CHARS,
): unknown {
	if (!isPlainObject(card)) {
		return card;
	}
	const shrunk: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(card)) {
		if (/_(?:html|url)$/.test(key)) {
			continue;
		}
		if (typeof value === "string") {
			shrunk[key] = clipText(value, maxTextChars);
		} else if (Array.isArray(value)) {
			shrunk[key] = value.map((item) =>
				isPlainObject(item) ? reduceNestedRecord(item) : item,
			);
		} else if (isPlainObject(value)) {
			shrunk[key] = reduceNestedRecord(value);
		} else {
			shrunk[key] = value;
		}
	}
	return shrunk;
}

/** Shrink the cards in a tool result; anything that is not a card is untouched. */
export function shrinkToolResultForStorage(
	toolName: string,
	output: unknown,
): unknown {
	if (isSingleCardTool(toolName)) {
		return shrinkCardForStorage(output, MAX_FETCHED_CARD_TEXT_CHARS);
	}
	if (!isCardListTool(toolName)) {
		return output;
	}
	if (Array.isArray(output)) {
		return output.map((card) => shrinkCardForStorage(card));
	}
	const cards = extractCardsArray(output);
	return cards
		? {
				...(output as Record<string, unknown>),
				cards: cards.map((card) => shrinkCardForStorage(card)),
			}
		: output;
}

function projectListItemForContext(item: unknown): unknown {
	if (!isPlainObject(item)) {
		return typeof item === "string"
			? clipText(item, MAX_LIST_ITEM_TEXT_CHARS)
			: item;
	}
	const projected: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(item)) {
		if (key === "url" || /_(?:url|html|at)$/.test(key)) {
			continue;
		}
		if (typeof value === "string") {
			projected[key] = clipText(value, MAX_LIST_ITEM_TEXT_CHARS);
		} else if (typeof value === "number" || typeof value === "boolean") {
			projected[key] = value;
		} else if (isPlainObject(value)) {
			const label = value.name ?? value.title ?? value.id;
			if (label !== undefined) {
				projected[key] = label;
			}
		}
	}
	return projected;
}

/**
 * The context copy of a large JSON list, such as an account's tags. The model
 * only steers from this copy, so it does not need an LLM summary, which took
 * about a minute for 13 KB of tags.
 */
export function fitListToContext(
	list: unknown[],
	maxChars: number,
): { items: unknown[]; omitted: number } {
	const items: unknown[] = [];
	let length = 2;
	for (const item of list) {
		const projected = projectListItemForContext(item);
		const itemLength = (JSON.stringify(projected) ?? "null").length + 1;
		if (length + itemLength <= maxChars) {
			items.push(projected);
			length += itemLength;
		}
	}
	return { items, omitted: list.length - items.length };
}

/**
 * The raw JSON Schema behind a tool's input schema. On the `mcpClient.tools()`
 * path the AI SDK wraps the server's schema in a `jsonSchema(...)` container, so
 * the real schema sits behind an (enumerable, synchronous) `jsonSchema` getter;
 * a bare JSON Schema is accepted too.
 */
function rawJsonSchema(inputSchema: unknown): Record<string, unknown> | null {
	if (!isPlainObject(inputSchema)) {
		return null;
	}
	return isPlainObject(inputSchema.jsonSchema)
		? inputSchema.jsonSchema
		: inputSchema;
}

/**
 * The raw `properties` bag of a tool's JSON input schema. Anything else —
 * absent, a Zod schema, a thenable — yields null.
 */
export function extractSchemaProperties(
	inputSchema: unknown,
): Record<string, unknown> | null {
	const properties = rawJsonSchema(inputSchema)?.properties;
	return isPlainObject(properties) ? properties : null;
}

function extractSchemaRequired(inputSchema: unknown): string[] {
	const required = rawJsonSchema(inputSchema)?.required;
	return Array.isArray(required)
		? required.filter((name): name is string => typeof name === "string")
		: [];
}

function schemaEnumValues(property: unknown): unknown[] {
	const values = isPlainObject(property) ? property.enum : undefined;
	return Array.isArray(values) ? values : [];
}

/** True when a card-list tool keeps closed cards out of its default listing. */
export function declaresClosedListing(inputSchema: unknown): boolean {
	return schemaEnumValues(
		extractSchemaProperties(inputSchema)?.indexed_by,
	).includes("closed");
}

function snakeToCamel(name: string): string {
	return name.replace(/_([a-z])/g, (_, letter: string) =>
		letter.toUpperCase(),
	);
}

/**
 * Ask for the server's summary projection when the tool declares it. It keeps
 * every field a report counts by and drops the description bodies, which are
 * what pushed full-mode listings over the upstream Worker's memory budget.
 */
export function withSummaryProjection(
	args: Record<string, unknown>,
	inputSchema: unknown,
): Record<string, unknown> {
	const properties = extractSchemaProperties(inputSchema);
	return args.fields === undefined &&
		schemaEnumValues(properties?.fields).includes("summary")
		? { ...args, fields: "summary" }
		: args;
}

/**
 * The name a listing's coverage is recorded under. Open and closed cards are
 * separate listings with separate totals, so one key per listing keeps a closed
 * listing's `total_count` from replacing the open one's. The plain listing of
 * the run's target board keeps the bare tool name.
 */
export function listingCoverageKey(
	toolName: string,
	args: Record<string, unknown>,
	targetBoardId: string | undefined,
): string {
	const filters = Object.entries(args)
		.filter(
			([key, value]) =>
				!NON_LISTING_ARGS.has(key) &&
				value !== undefined &&
				value !== null &&
				value !== "" &&
				!(key === "board_id" && String(value) === targetBoardId),
		)
		.map(([key, value]) => `${key}=${String(value)}`)
		.sort();
	return filters.length > 0 ? `${toolName}[${filters.join(",")}]` : toolName;
}

export interface BoardSweepPlan {
	toolName: string;
	listings: Array<Record<string, unknown>>;
}

/**
 * Decide whether the run can read a whole board before the model's first turn.
 * It can when the context names a board and a card-list tool declares both
 * `board_id` and `page`, with every required argument answered by the context.
 * Any other tool shape returns null and keeps the model-driven path.
 */
export function planBoardSweep(params: {
	tools: Record<string, { inputSchema?: unknown }>;
	context: Record<string, string | undefined>;
}): BoardSweepPlan | null {
	const { tools, context } = params;
	const boardId = context.boardId || context.board_id;
	if (!boardId) {
		return null;
	}
	for (const [toolName, toolDef] of Object.entries(tools)) {
		if (!isCardListTool(toolName)) {
			continue;
		}
		const properties = extractSchemaProperties(toolDef.inputSchema);
		if (!properties?.board_id || !properties.page) {
			continue;
		}
		const required = extractSchemaRequired(toolDef.inputSchema);
		const args: Record<string, unknown> = { board_id: boardId };
		const wanted = properties.account_slug
			? [...required, "account_slug"]
			: required;
		for (const name of wanted) {
			const value = context[name] ?? context[snakeToCamel(name)];
			if (value && args[name] === undefined) {
				args[name] = value;
			}
		}
		if (required.some((name) => args[name] === undefined)) {
			continue;
		}
		const scoped = withSummaryProjection(args, toolDef.inputSchema);
		const indexes = schemaEnumValues(properties.indexed_by);
		return {
			toolName,
			listings: [
				scoped,
				...["closed", "not_now"]
					.filter((index) => indexes.includes(index))
					.map((index) => ({ ...scoped, indexed_by: index })),
			],
		};
	}
	return null;
}

export interface ListingWalk {
	/**
	 * `complete`: the source said there is nothing more. `partial`: a page failed
	 * or the walk had to stop. `unpaginated`: the tool reports no pagination, so
	 * what it returned is all that can be known.
	 */
	status: "complete" | "partial" | "unpaginated";
	/** Pages actually read. */
	pages: number;
	/** Cards on those pages, before any de-duplication. */
	cards: number;
	/** Why a partial walk stopped. */
	reason?: string;
}

/**
 * Read a card listing to its end without a model turn. Stops when `has_more` is
 * false or a page comes back empty: an out-of-range page returns no cards while
 * still reporting `has_more: true`, so the empty check is what ends that case.
 *
 * A page that fails does not throw. The walk stops and says so, and the caller
 * keeps what it has already read through `onPage`.
 */
export async function walkCardPages(params: {
	args: Record<string, unknown>;
	fetchPage: (args: Record<string, unknown>) => Promise<unknown>;
	/** Called with each raw page as it arrives. */
	onPage: (page: unknown) => void;
	/** Called before each page so a Temporal activity stays alive. */
	beat: () => void;
	maxPages?: number;
}): Promise<ListingWalk> {
	const { args, fetchPage, onPage, beat } = params;
	const maxPages = params.maxPages ?? MAX_LISTING_PAGES;
	let pages = 0;
	let cardCount = 0;
	let requested: number | undefined;

	while (pages < maxPages) {
		beat();
		let output: unknown;
		try {
			output = await fetchPage(
				requested === undefined ? args : { ...args, page: requested },
			);
		} catch (error) {
			const detail =
				error instanceof Error ? error.message : "unknown error";
			return {
				status: "partial",
				pages,
				cards: cardCount,
				reason: `page ${requested ?? 1} could not be read: ${detail}`,
			};
		}
		pages++;
		onPage(output);

		const cards = extractCardsArray(output);
		if (!cards) {
			return pages === 1
				? { status: "unpaginated", pages, cards: 0 }
				: {
						status: "partial",
						pages,
						cards: cardCount,
						reason: `page ${requested ?? 1} was not a card list`,
					};
		}
		cardCount += cards.length;

		const meta = extractPageMeta(output);
		if (!meta || meta.has_more === undefined) {
			return {
				status: pages === 1 ? "unpaginated" : "complete",
				pages,
				cards: cardCount,
			};
		}
		if (!meta.has_more || cards.length === 0) {
			return { status: "complete", pages, cards: cardCount };
		}

		const current = requested ?? 1;
		const next =
			typeof meta.next_page === "number" ? meta.next_page : current + 1;
		if (next <= current) {
			return {
				status: "partial",
				pages,
				cards: cardCount,
				reason: `the source kept returning page ${next} after page ${current}`,
			};
		}
		requested = next;
	}

	return {
		status: "partial",
		pages,
		cards: cardCount,
		reason: `stopped after ${maxPages} pages with more still reported`,
	};
}
