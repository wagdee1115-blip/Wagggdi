export async function readBoundedRequestText(request: Request, maxBytes = 64 * 1024) {
  const rawLength = request.headers.get('content-length');
  if (rawLength !== null) {
    if (!/^\d+$/.test(rawLength)) throw new Error('INVALID_CONTENT_LENGTH');
    if (Number(rawLength) > maxBytes) throw new Error('PAYLOAD_TOO_LARGE');
  }

  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('PAYLOAD_TOO_LARGE');
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}
