/**
 * Where focus goes in the review dialog when the image dialog closes and the
 * tile that opened it is gone (the image was removed or moved): the same
 * highlight's "Add image" button when it can take focus, otherwise its
 * include checkbox, otherwise nothing (the caller then leaves focus alone).
 *
 * The rows mark these controls with `data-review-add-image` and
 * `data-review-include`, set to the highlight's index.
 */
export function reviewFocusFallback(
	container: ParentNode | null,
	highlightIndex: number,
): HTMLElement | null {
	if (!container) {
		return null;
	}
	const addImage = container.querySelector(
		`[data-review-add-image="${highlightIndex}"]`,
	);
	if (addImage instanceof HTMLElement && !addImage.hasAttribute("disabled")) {
		return addImage;
	}
	const include = container.querySelector(
		`[data-review-include="${highlightIndex}"]`,
	);
	return include instanceof HTMLElement ? include : null;
}
