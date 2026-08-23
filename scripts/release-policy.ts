export const HARNESS_RELEASE_CHANNELS = ["latest", "next"] as const;

export type HarnessReleaseChannel = (typeof HARNESS_RELEASE_CHANNELS)[number];

export interface HarnessReleaseVersion {
  version: string;
  tag: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: boolean;
  releaseCandidate?: number;
  channel: HarnessReleaseChannel;
}

const RELEASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/;

export const parseHarnessReleaseVersion = (version: string): HarnessReleaseVersion => {
  const match = RELEASE_VERSION_PATTERN.exec(version);
  if (!match) {
    throw new Error(
      `Unsupported release version ${version}; expected stable SemVer or release candidate X.Y.Z-rc.N.`
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const releaseCandidate = match[4] === undefined ? undefined : Number(match[4]);
  if (major === 0 && minor !== 11) {
    throw new Error(`Unsupported pre-1.0 release line ${version}; only 0.11.x remains releasable.`);
  }
  return {
    version,
    tag: `v${version}`,
    major,
    minor,
    patch,
    prerelease: releaseCandidate !== undefined,
    ...(releaseCandidate === undefined ? {} : { releaseCandidate }),
    channel: releaseCandidate === undefined ? "latest" : "next"
  };
};

export const assertHarnessReleaseChannel = (
  version: string,
  channel: string
): HarnessReleaseVersion => {
  const release = parseHarnessReleaseVersion(version);
  if (channel !== release.channel) {
    throw new Error(
      `${release.prerelease ? "Prerelease" : "Stable release"} ${version} must use npm channel ${release.channel}, not ${channel}.`
    );
  }
  return release;
};
