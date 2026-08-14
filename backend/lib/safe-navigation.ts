export function safeInternalDestination(candidate: string | null | undefined, origin: string) {
  if (!candidate || !candidate.startsWith('/') || candidate.includes('\\')) return '/';
  try {
    const base = new URL(origin);
    const destination = new URL(candidate, base);
    if (destination.origin !== base.origin || destination.username || destination.password) return '/';
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return '/';
  }
}
