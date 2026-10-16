/**
 * Fabric MCP Gateway - Page data tools
 *
 * What a published page keeps between visits: records in named collections,
 * shared by everyone who can open the page or private to one viewer. A poll's
 * votes, a checklist, a sign-up sheet. A page's script calls these as whoever is
 * viewing it; the Fabric Agent calls the same tools to seed or read a page.
 *
 * Opening the page as the caller is the permission: writing needs no more than
 * being able to open it (see `./page-store`). The store stamps every record
 * with who wrote it, so a page never trusts a name it was given. Collections
 * that start with `$` belong to the host (files, comments) and are reached only
 * through their own tools.
 */

import {
	deletePageRecords,
	getPageRecord,
	listPageRecords,
	type PageRecordScope,
	type PageRecordWrite,
	setPageRecords,
} from "@repo/database";
import {
	PAGE_BATCH_MAX,
	PAGE_LIST_DEFAULT,
	PAGE_LIST_MAX,
} from "@repo/utils/page-limits";
import { jsonResult } from "../tool-results";
import { clampLimit, nonEmptyString } from "./frame-context";
import {
	collectionOf,
	hostCollectionRefusal,
	isStorableJson,
	type PageInput,
	pageTool,
	refuse,
	VIEWER_WRITTEN_NOTE,
} from "./page-store";

function scopeOf(value: unknown): PageInput<PageRecordScope> {
	if (value === undefined || value === null || value === "shared") {
		return { ok: true, value: "shared" };
	}
	return value === "mine"
		? { ok: true, value: "mine" }
		: refuse("scope", "`scope` must be `shared` or `mine`.");
}

type CollectionRead = { collection: string; scope: PageRecordScope };

/** The collection and scope a read names, refused for a collection that belongs to the host. */
function collectionReadOf(
	args: Record<string, unknown>,
	collection: string,
): PageInput<CollectionRead> {
	const hostRefusal = hostCollectionRefusal(collection);
	if (hostRefusal) {
		return { ok: false, refusal: hostRefusal };
	}
	const scope = scopeOf(args.scope);
	return scope.ok
		? { ok: true, value: { collection, scope: scope.value } }
		: scope;
}

const handleListPageData = pageTool(
	{
		parse: (args) => {
			const collection = collectionOf(args);
			if (!collection) {
				return refuse("collection", "`collection` is required.");
			}
			const read = collectionReadOf(args, collection);
			return read.ok
				? {
						ok: true,
						value: {
							...read.value,
							since: nonEmptyString(args.since),
							cursor: nonEmptyString(args.cursor),
							limit: clampLimit(args.limit, {
								fallback: PAGE_LIST_DEFAULT,
								max: PAGE_LIST_MAX,
							}),
						},
					}
				: read;
		},
	},
	async ({ input, page, session }) => {
		const { records, nextCursor } = await listPageRecords({
			frameId: page.frameId,
			organizationId: page.organizationId,
			viewerUserId: session.userId,
			collection: input.collection,
			scope: input.scope,
			since: input.since,
			cursor: input.cursor,
			limit: input.limit,
		});
		return jsonResult({
			collection: input.collection,
			scope: input.scope,
			records,
			...(nextCursor ? { nextCursor } : {}),
			note: VIEWER_WRITTEN_NOTE,
		});
	},
);

const handleGetPageData = pageTool(
	{
		parse: (args) => {
			const collection = collectionOf(args);
			const key = nonEmptyString(args.key);
			if (!collection || !key) {
				return refuse("key", "`collection` and `key` are required.");
			}
			const read = collectionReadOf(args, collection);
			return read.ok ? { ok: true, value: { ...read.value, key } } : read;
		},
	},
	async ({ input, page, session }) =>
		jsonResult({
			collection: input.collection,
			scope: input.scope,
			record: await getPageRecord({
				frameId: page.frameId,
				organizationId: page.organizationId,
				viewerUserId: session.userId,
				collection: input.collection,
				key: input.key,
				scope: input.scope,
			}),
			note: VIEWER_WRITTEN_NOTE,
		}),
);

/** The records of a write, each checked to be a key and a value the store can keep. */
function writesOf(value: unknown): PageInput<PageRecordWrite[]> {
	if (!Array.isArray(value) || value.length === 0) {
		return refuse(
			"records",
			`\`records\` must be a list of 1 to ${PAGE_BATCH_MAX} records.`,
		);
	}
	if (value.length > PAGE_BATCH_MAX) {
		return refuse(
			"batch_size",
			`A write holds at most ${PAGE_BATCH_MAX} records.`,
		);
	}
	const records: PageRecordWrite[] = [];
	for (const entry of value) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			Array.isArray(entry)
		) {
			return refuse("records", "Every record must be an object.");
		}
		const key = nonEmptyString(Reflect.get(entry, "key"));
		if (!key) {
			return refuse("key", "Every record needs a `key`.");
		}
		if (!Object.hasOwn(entry, "value")) {
			return refuse("value", `Record "${key}" needs a \`value\`.`);
		}
		const recordValue = Reflect.get(entry, "value");
		if (recordValue !== null && !isStorableJson(recordValue)) {
			return refuse("value", `The value of "${key}" must be JSON.`);
		}
		const scope = scopeOf(Reflect.get(entry, "scope"));
		if (!scope.ok) {
			return scope;
		}
		const expectedVersion = Reflect.get(entry, "expectedVersion");
		if (
			expectedVersion !== undefined &&
			typeof expectedVersion !== "number"
		) {
			return refuse(
				"expected_version",
				"`expectedVersion` is a whole number from 0.",
			);
		}
		records.push({
			key,
			value: recordValue,
			scope: scope.value,
			expectedVersion,
		});
	}
	return { ok: true, value: records };
}

const handleSetPageData = pageTool(
	{
		rate: "write",
		parse: (args) => {
			const collection = collectionOf(args);
			if (!collection) {
				return refuse("collection", "`collection` is required.");
			}
			const writes = writesOf(args.records);
			return writes.ok
				? { ok: true, value: { collection, records: writes.value } }
				: writes;
		},
	},
	async ({ input, page, session }) => {
		const { records } = await setPageRecords({
			frameId: page.frameId,
			organizationId: page.organizationId,
			actorUserId: session.userId,
			collection: input.collection,
			records: input.records,
		});
		return jsonResult({ collection: input.collection, records });
	},
);

const handleDeletePageData = pageTool(
	{
		rate: "write",
		parse: (args) => {
			const collection = collectionOf(args);
			if (!collection) {
				return refuse("collection", "`collection` is required.");
			}
			const keys = Array.isArray(args.keys)
				? args.keys.map((key) => nonEmptyString(key))
				: [];
			const named = keys.filter((key) => key !== undefined);
			if (named.length === 0 || named.length !== keys.length) {
				return refuse("key", "`keys` must be a list of keys.");
			}
			if (named.length > PAGE_BATCH_MAX) {
				return refuse(
					"batch_size",
					`A delete holds at most ${PAGE_BATCH_MAX} keys.`,
				);
			}
			return { ok: true, value: { collection, keys: named } };
		},
	},
	async ({ input, page, session }) => {
		const { deleted } = await deletePageRecords({
			frameId: page.frameId,
			organizationId: page.organizationId,
			actorUserId: session.userId,
			isPageOwner: page.isOwner,
			collection: input.collection,
			keys: input.keys,
		});
		return jsonResult({ collection: input.collection, deleted });
	},
);

export const PAGE_DATA_HANDLERS = new Map([
	["fabric_page_data_list", handleListPageData],
	["fabric_page_data_get", handleGetPageData],
	["fabric_page_data_set", handleSetPageData],
	["fabric_page_data_delete", handleDeletePageData],
]);
