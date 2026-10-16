/** Offers `href` to the browser as a file called `filename`. */
export function downloadHref(href: string, filename: string): void {
	const link = document.createElement("a");
	link.href = href;
	link.download = filename;
	link.click();
}

function bytesOfBase64(encoded: string): Uint8Array<ArrayBuffer> {
	const binary = atob(encoded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

/** Saves a file the viewer accepted, from the base64 a page sent. */
export function saveBase64File(file: {
	filename: string;
	mimeType: string;
	dataBase64: string;
}): void {
	const url = URL.createObjectURL(
		new Blob([bytesOfBase64(file.dataBase64)], { type: file.mimeType }),
	);
	downloadHref(url, file.filename);
	URL.revokeObjectURL(url);
}
