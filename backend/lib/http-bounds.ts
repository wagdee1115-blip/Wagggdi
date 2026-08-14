export function requireBoundedContentLength(request: Request, maxBytes: number) {
  const rawLength = request.headers.get('content-length');
  if (rawLength === null) throw new Error('CONTENT_LENGTH_REQUIRED');
  if (!/^\d+$/.test(rawLength)) throw new Error('INVALID_CONTENT_LENGTH');
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error('INVALID_CONTENT_LENGTH');
  if (length > maxBytes) throw new Error('PAYLOAD_TOO_LARGE');
  return length;
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes = 64 * 1024,
  errorCode = 'PROVIDER_RESPONSE_INVALID',
) {
  const rawLength = response.headers.get('content-length');
  if (rawLength !== null) {
    if (!/^\d+$/.test(rawLength)) throw new Error(errorCode);
    const declaredLength = Number(rawLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) throw new Error(errorCode);
  }
  if (!response.body) throw new Error(errorCode);

  const reader = response.body.getReader();
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
        throw new Error(errorCode);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } finally {
    reader.releaseLock();
  }
}
