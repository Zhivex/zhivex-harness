/** Shared lexical exclusions for workspace access and acceptance preflight. */
export const HARD_IGNORES = new Set(['.git', '.next', '.turbo', '.zhivex-harness', 'coverage', 'dist', 'node_modules']);
export const isSensitiveName = (name: string) => {
  const normalized = name.toLocaleLowerCase();
  return normalized === '.env' || (normalized.startsWith('.env.') && normalized !== '.env.example') ||
    normalized === '.npmrc' || normalized === 'id_rsa' || normalized === 'id_ed25519' ||
    ['.key','.pem','.p12','.pfx'].some(extension => normalized.endsWith(extension));
};
export const isHardIgnored = (relativePath: string) => relativePath.split('/').some(segment => HARD_IGNORES.has(segment.toLocaleLowerCase()) || isSensitiveName(segment));
