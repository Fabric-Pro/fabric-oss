import type { NativeInstructionBase } from "@saas/projects/lib/instruction-change-source";
import { useEffect, useState } from "react";

type Rename = { from: string; to: string; pin: NativeInstructionBase };

const samePin = (a: NativeInstructionBase, b: NativeInstructionBase) =>
	a.generation === b.generation && a.commitSha === b.commitSha;

/**
 * What the page shows between a rename's commit and the list that contains
 * the renamed file. The commit lands before the refreshed list does, and a
 * list that has dropped the old path but not yet gained the new one made the
 * page fall back to its default file. So the old file stays on screen, read at
 * the commit it was read at, until the list names the new path; then the page
 * moves to it once. A list that arrives without the new path ends the wait.
 */
export function useRenameFollowing({
	paths,
	pin,
	onLanded,
}: {
	/** The paths of the file list read at `pin`, or undefined while it is not there. */
	paths: readonly string[] | undefined;
	pin: NativeInstructionBase;
	onLanded: (path: string) => void;
}) {
	const [rename, setRename] = useState<Rename | null>(null);
	const landed = rename !== null && paths?.includes(rename.to) === true;
	const abandoned =
		rename !== null &&
		!landed &&
		paths !== undefined &&
		!samePin(rename.pin, pin);
	useEffect(() => {
		if (rename === null || !(landed || abandoned)) {
			return;
		}
		if (landed) {
			onLanded(rename.to);
		}
		setRename(null);
	}, [rename, landed, abandoned, onLanded]);
	return {
		begin: (from: string, to: string) => setRename({ from, to, pin }),
		landedPath: landed ? rename.to : null,
		waiting: rename !== null && !landed && !abandoned ? rename : null,
	};
}
