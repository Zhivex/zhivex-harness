/** Process-local host identity; never populated from a client command or run metadata. */
const identities = new WeakMap<object, { digest: string; explicitReview: boolean }>();
export const bindHostPolicyIdentity = (host: object, digest: string, explicitReview = false) => {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest) || identities.has(host)) throw new Error('Invalid host policy identity.');
  identities.set(host, { digest, explicitReview });
};
export const hostPolicyIdentity = (host: object): string | null => identities.get(host)?.digest ?? null;
export const requiresExplicitHostReview = (host: object): boolean => identities.get(host)?.explicitReview ?? false;
