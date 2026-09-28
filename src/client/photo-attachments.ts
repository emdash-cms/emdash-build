import type { FileUIPart } from "ai";

export const MAX_PHOTOS = 4;
// Photos ride inside the persisted chat message, which the agent SDK caps at
// ~1.8 MB and never compacts, so keep each one small and the set bounded.
const MAX_EDGE = 1024;
const MAX_TOTAL_URL_LENGTH = 1_200_000;

/** Decode an image file and re-encode it as a bounded JPEG data URL part. */
export async function preparePhoto(file: File): Promise<FileUIPart> {
	const bitmap = await createImageBitmap(file);
	try {
		const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
		const width = Math.round(bitmap.width * scale);
		const height = Math.round(bitmap.height * scale);
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Canvas unavailable");
		// JPEG has no alpha; flatten transparent PNGs onto white, not black.
		context.fillStyle = "#fff";
		context.fillRect(0, 0, width, height);
		context.drawImage(bitmap, 0, 0, width, height);
		return {
			type: "file",
			mediaType: "image/jpeg",
			filename: file.name,
			url: canvas.toDataURL("image/jpeg", 0.8),
		};
	} finally {
		bitmap.close();
	}
}

export function fitsPhotoBudget(photos: FileUIPart[]): boolean {
	return photos.reduce((total, photo) => total + photo.url.length, 0) <= MAX_TOTAL_URL_LENGTH;
}

/** Photos read back from session storage, keeping only well-formed image parts. */
export function storedPhotos(value: unknown): FileUIPart[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter(
			(photo): photo is FileUIPart =>
				photo?.type === "file" &&
				typeof photo.mediaType === "string" &&
				typeof photo.url === "string" &&
				photo.url.startsWith("data:image/"),
		)
		.slice(0, MAX_PHOTOS);
}
