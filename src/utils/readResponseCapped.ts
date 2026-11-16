/**
 * Reads a response body, giving up once it exceeds the byte cap.
 * @param {Response} response Fetch response
 * @param {number} maxBytes Largest body to accept
 * @return {Promise<Uint8Array | null>} Body bytes, or null when missing or too large
 */
export const readResponseCapped = async (response: Response, maxBytes: number): Promise<Uint8Array | null> => {
	if (!response.body) return null;
	const reader = response.body.getReader();
	if (Number(response.headers.get("content-length")) > maxBytes) {
		await reader.cancel();
		return null;
	}

	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
};
