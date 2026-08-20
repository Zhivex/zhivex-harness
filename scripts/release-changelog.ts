export interface ReleaseChangelogHeading {
  kind: "unreleased" | "dated";
  value: string;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const findReleaseChangelogHeading = (
  changelog: string,
  version: string
): ReleaseChangelogHeading | undefined => {
  const match = changelog.match(new RegExp(
    `^## ${escapeRegExp(version)} - (Unreleased|\\d{4}-\\d{2}-\\d{2})$`,
    "m"
  ));
  if (!match?.[1]) return undefined;
  return {
    kind: match[1] === "Unreleased" ? "unreleased" : "dated",
    value: match[1]
  };
};
