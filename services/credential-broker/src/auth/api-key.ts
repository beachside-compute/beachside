const encoder = new TextEncoder();

export const apiKeyPattern = /^[A-Za-z0-9_-]{32,256}$/;

export async function matchesKey(
  expected: string | undefined,
  presented: string,
): Promise<boolean> {
  if (!expected || !apiKeyPattern.test(expected) || !apiKeyPattern.test(presented)) return false;

  const [stored, candidate] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
  ]);

  return crypto.subtle.timingSafeEqual(stored, candidate);
}
