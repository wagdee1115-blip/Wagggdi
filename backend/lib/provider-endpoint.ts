export function requireProviderEndpoint(rawValue: string | undefined, providerCode: string) {
  const raw = rawValue?.trim();
  if (!raw) throw new Error(`NOT_CONFIGURED:${providerCode}_REQUIRED`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`NOT_CONFIGURED:${providerCode}_URL_INVALID`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`NOT_CONFIGURED:${providerCode}_URL_INVALID`);
  }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error(`NOT_CONFIGURED:${providerCode}_HTTPS_REQUIRED`);
  }
  return url.toString();
}
