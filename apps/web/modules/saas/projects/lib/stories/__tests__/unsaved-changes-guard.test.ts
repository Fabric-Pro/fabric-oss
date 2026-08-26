import { describe, expect, it } from "vitest";
import {
	isEditorDirty,
	shouldWarnBeforeUnload,
	type UnsavedChangesGuardState,
} from "../unsaved-changes-guard";

// `hasUnsavedChanges` was a blind boolean — cleared whenever a
// save resolved, regardless of whether the editor still held content that save
// never carried. User types A, clicks Save, types B while A is in flight, and
// A's onSuccess marks everything clean: B is silently dropped.

describe("isEditorDirty", () => {
	it("is clean when the editor matches what was last saved", () => {
		expect(isEditorDirty("# Title\n\n- one", "# Title\n\n- one")).toBe(
			false,
		);
	});

	it("is dirty when the editor has moved on from the last save", () => {
		// The A/B race: lastSaved is A, the editor already holds A+B.
		expect(
			isEditorDirty("# Title\n\n- one\n- two", "# Title\n\n- one"),
		).toBe(true);
	});

	it("ignores trailing-whitespace-only differences", () => {
		// Turndown emits a trailing newline that the stored value may lack;
		// treating that as dirty would prompt on every untouched document.
		expect(isEditorDirty("# Title\n\n- one\n\n", "# Title\n\n- one")).toBe(
			false,
		);
	});

	it("treats an unreadable editor as dirty", () => {
		// null means the serializer failed. We cannot prove the content is
		// saved, so assume it is not — never clear the flag on a guess.
		expect(isEditorDirty(null, "# Title")).toBe(true);
	});

	it("treats a never-saved document with content as dirty", () => {
		expect(isEditorDirty("# Title", null)).toBe(true);
	});

	it("is clean when both sides are empty", () => {
		expect(isEditorDirty("", null)).toBe(false);
		expect(isEditorDirty(null, null)).toBe(true);
	});
});

// The description editor auto-saves on a 10s debounce, so closing
// the tab or navigating within 10s of the last keystroke silently dropped the
// edit. This predicate decides whether to raise the browser's unload prompt.

const CLEAN: UnsavedChangesGuardState = {
	hasUnsavedChanges: false,
	isSaving: false,
};

describe("shouldWarnBeforeUnload", () => {
	it("does not warn when there is nothing to lose", () => {
		expect(shouldWarnBeforeUnload(CLEAN)).toBe(false);
	});

	it("warns when the editor has unsaved edits", () => {
		expect(
			shouldWarnBeforeUnload({ ...CLEAN, hasUnsavedChanges: true }),
		).toBe(true);
	});

	it("does not warn while a save is already in flight", () => {
		// The mutation is running; the edit is on its way to the server, and
		// prompting here would be a false alarm on every manual save+close.
		expect(
			shouldWarnBeforeUnload({ hasUnsavedChanges: true, isSaving: true }),
		).toBe(false);
	});
});
