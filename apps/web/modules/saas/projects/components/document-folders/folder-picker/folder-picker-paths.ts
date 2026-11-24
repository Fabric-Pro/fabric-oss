/**
 * Where the document-folder picker is, what has been chosen, and why a folder
 * cannot be chosen (Fizzy #2808). Shared by the picker's levels and the
 * connect dialog around them.
 */

import {
	type EditorDocumentFolder,
	folderRelation,
} from "../use-document-folders";

type Place = "onedrive" | "sharepoint";

export interface Site {
	siteId: string;
	siteName: string;
}

/** Where the browser is: a place, a SharePoint site, or a folder. */
export type Crumb =
	| { kind: "places" }
	| { kind: "sharepoint" }
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
	return chosen.place === "onedrive"
		? ["My OneDrive", ...path].join(" · ")
		: ["SharePoint", chosen.site?.siteName, chosen.libraryName, ...path]
				.filter(Boolean)
				.join(" · ");
}

/**
 * Why a folder cannot be chosen: it is, or lies inside, or holds a connected
 * folder, or a folder already chosen. Null when it can be.
 */
export function blockedBy(
	candidate: { key: string; driveId: string; path: string },
	chosen: Map<string, Chosen>,
	connected: EditorDocumentFolder[],
): string | null {
	const at = { driveId: candidate.driveId, drivePath: candidate.path };
	for (const folder of connected) {
		switch (folderRelation(at, folder)) {
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
			folderRelation(at, {
				driveId: other.driveId,
				drivePath: other.path,
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
