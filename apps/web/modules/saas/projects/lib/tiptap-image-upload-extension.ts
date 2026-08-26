/**
 * TipTap extension for image upload placeholder nodes.
 *
 * Creates a temporary atom node in the editor that shows upload progress.
 * Replaced with the actual image node once upload completes.
 */

import { mergeAttributes, Node } from "@tiptap/core";

interface ImageUploadAttributes {
	/** Unique identifier for this upload */
	uploadId: string;
	/** Original filename */
	filename: string;
	/** Upload progress percentage (0-100) */
	progress: number;
	/** Error message if upload failed */
	error: string | null;
}

declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		imageUpload: {
			/**
			 * Insert an image upload placeholder
			 */
			insertImageUpload: (attrs: ImageUploadAttributes) => ReturnType;
			/**
			 * Update an existing upload placeholder's progress
			 */
			updateImageUpload: (
				uploadId: string,
				attrs: Partial<ImageUploadAttributes>,
			) => ReturnType;
			/**
			 * Remove an upload placeholder (on success or cancel)
			 */
			removeImageUpload: (uploadId: string) => ReturnType;
		};
	}
}

export const ImageUploadPlaceholder = Node.create({
	name: "imageUpload",
	group: "block",
	atom: true,
	draggable: false,
	selectable: true,

	addAttributes() {
		return {
			uploadId: { default: "" },
			filename: { default: "" },
			progress: { default: 0 },
			error: { default: null },
		};
	},

	parseHTML() {
		return [
			{
				tag: 'div[data-type="image-upload"]',
			},
		];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"div",
			mergeAttributes(HTMLAttributes, {
				"data-type": "image-upload",
				"data-upload-id": HTMLAttributes.uploadId,
				class: "image-upload-placeholder",
			}),
		];
	},

	addCommands() {
		return {
			insertImageUpload:
				(attrs) =>
				({ commands }) => {
					return commands.insertContent({
						type: this.name,
						attrs,
					});
				},

			updateImageUpload:
				(uploadId, attrs) =>
				({ tr, state, dispatch }) => {
					if (!dispatch) {
						return false;
					}

					let found = false;
					state.doc.descendants((node, pos) => {
						if (
							node.type.name === this.name &&
							node.attrs.uploadId === uploadId
						) {
							const newAttrs = { ...node.attrs, ...attrs };
							tr.setNodeMarkup(pos, undefined, newAttrs);
							found = true;
							return false; // stop traversal
						}
						return true;
					});

					return found;
				},

			removeImageUpload:
				(uploadId) =>
				({ tr, state, dispatch }) => {
					if (!dispatch) {
						return false;
					}

					let found = false;
					state.doc.descendants((node, pos) => {
						if (
							node.type.name === this.name &&
							node.attrs.uploadId === uploadId
						) {
							tr.delete(pos, pos + node.nodeSize);
							found = true;
							return false;
						}
						return true;
					});

					return found;
				},
		};
	},
});
