/**
 * Where the document-folder picker is, what has been chosen, and why a folder
 * cannot be chosen (Fizzy #2808). Shared by the picker's levels and the
 * connect dialog around them.
 */

import {
	type EditorDocumentFolder,
	folderRelation,
} from "../use-document-folders";

type Place = "onedrive" | "sharepoint" | "googledrive";

export interface Site {
	siteId: string;
	siteName: string;
}

/** Where the browser is: a place, a SharePoint site, or a folder. */
export type Crumb =
	| { kind: "places" }
	| { kind: "sharepoint" }
	| { kind: "sharedDrives" }
	| { kind: "site"; site: Site }
	| {
			kind: "folder";
			place: Place;
			/** Unset for My OneDrive's root, which Graph lists without one. */
			driveId?: string;
			/** Unset for a drive's root. */
			itemId?: string;
			name: string;
			/** The folder's path in its drive, built from the names opened. */
			path: string;
			site?: Site;
			libraryName?: string;
			/** Google Drive: My Drive, or the shared drive's name. */
			driveName?: string;
			/**
			 * Google Drive: the ids of the folders above this one, its drive's
			 * root included. Unset for Microsoft, whose folders compare by path.
			 */
			ancestorIds?: string[];
	  };

export type FolderCrumb = Extract<Crumb, { kind: "folder" }>;

export interface Chosen {
	key: string;
	driveId: string;
	itemId: string;
	name: string;
	path: string;
	place: Place;
	site?: Site;
	libraryName?: string;
	driveName?: string;
	/** Google Drive: the ids of the folders above it, as on its crumb. */
	ancestorIds?: string[];
	description: string;
}

/** What to focus once the next level is on screen. */
export type FocusTarget = "heading" | "first" | { key: string };

export const PLACES: Crumb = { kind: "places" };

export function keyOf(folder: { driveId: string; itemId: string }): string {
	return `${folder.driveId}:${folder.itemId}`;
}

export function crumbId(crumb: Crumb): string {
	switch (crumb.kind) {
		case "places":
			return "places";
		case "sharepoint":
			return "sharepoint";
		case "sharedDrives":
			return "shared-drives";
		case "site":
			return `site:${crumb.site.siteId}`;
		case "folder":
			return crumb.driveId
				? `${crumb.driveId}:${crumb.itemId ?? "root"}`
				: "onedrive-root";
	}
}

export function crumbLabel(crumb: Crumb): string {
	switch (crumb.kind) {
		case "places":
			return "Places";
		case "sharepoint":
			return "SharePoint";
		case "sharedDrives":
			return "Shared drives";
		case "site":
			return crumb.site.siteName;
		case "folder":
			return crumb.name;
	}
}

export function levelTitle(crumb: Crumb): string {
	switch (crumb.kind) {
		case "places":
			return "Choose where to look";
		case "sharepoint":
			return "SharePoint sites";
		case "sharedDrives":
			return "Shared drives";
		case "site":
			return `Document libraries in ${crumb.site.siteName}`;
		case "folder":
			return `Folders in ${crumb.name}`;
	}
}

export function childPath(parent: string, name: string): string {
	return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

export function chosenPlace(chosen: Chosen): string {
	const path = chosen.path === "/" ? [] : [chosen.path];
	switch (chosen.place) {
		case "onedrive":
			return ["My OneDrive", ...path].join(" · ");
		case "googledrive":
			return ["Google Drive", chosen.driveName, ...path]
				.filter(Boolean)
				.join(" · ");
		case "sharepoint":
			return [
				"SharePoint",
				chosen.site?.siteName,
				chosen.libraryName,
				...path,
			]
				.filter(Boolean)
				.join(" · ");
	}
}

type Relation = "same" | "inside" | "contains" | null;

/**
 * How a Google Drive folder sits against another, by id: Drive allows sibling
 * folders with the same name, so a name path cannot tell them apart. The
 * same id, the other's id among its ancestors (inside), or its id among the
 * other's (contains). Ids are unique across Google Drive.
 */
function googleRelation(
	folder: { itemId: string; ancestorIds: readonly string[] },
	other: { itemId: string; ancestorIds: readonly string[] },
): Relation {
	if (folder.itemId === other.itemId) {
		return "same";
	}
	if (folder.ancestorIds.includes(other.itemId)) {
		return "inside";
	}
	if (other.ancestorIds.includes(folder.itemId)) {
		return "contains";
	}
	return null;
}

/**
 * Why a folder cannot be chosen: it is, or lies inside, or holds a connected
 * folder, or a folder already chosen. Null when it can be. A Google Drive
 * folder, which carries its ancestor ids, is compared with Google Drive
 * folders by id; any other by path.
 */
export function blockedBy(
	candidate: {
		key: string;
		driveId: string;
		itemId: string;
		path: string;
		ancestorIds?: readonly string[];
	},
	chosen: Map<string, Chosen>,
	connected: EditorDocumentFolder[],
): string | null {
	const at = { driveId: candidate.driveId, drivePath: candidate.path };
	const google = candidate.ancestorIds
		? { itemId: candidate.itemId, ancestorIds: candidate.ancestorIds }
		: null;
	const relationTo = (other: {
		provider: string;
		driveId: string;
		itemId: string;
		drivePath: string | null;
		ancestorIds?: readonly string[];
	}): Relation => {
		if (google) {
			return other.provider === "googledrive"
				? googleRelation(google, {
						itemId: other.itemId,
						ancestorIds: other.ancestorIds ?? [],
					})
				: null;
		}
		return other.provider === "googledrive"
			? null
			: folderRelation(at, other);
	};
	for (const folder of connected) {
		switch (relationTo(folder)) {
			case "same":
				return "Already connected to this project.";
			case "inside":
				return `Inside "${folder.name}", which is already connected.`;
			case "contains":
				return `Holds "${folder.name}", which is already connected.`;
		}
	}
	for (const other of chosen.values()) {
		if (other.key === candidate.key) {
			continue;
		}
		switch (
			relationTo({
				provider: other.place,
				driveId: other.driveId,
				itemId: other.itemId,
				drivePath: other.path,
				ancestorIds: other.ancestorIds,
			})
		) {
			case "same":
				return `Same folder as "${other.name}", which you selected.`;
			case "inside":
				return `Inside "${other.name}", which you selected.`;
			case "contains":
				return `Holds "${other.name}", which you selected.`;
		}
	}
	return null;
}
