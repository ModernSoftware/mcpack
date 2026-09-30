// Supported release channels are deliberately narrower than arbitrary SemVer.
export function releaseDistTag(version) {
  if (typeof version !== 'string' || version.trim() !== version) {
    throw new Error('Release version must not contain surrounding whitespace');
  }

  const number = '(?:0|[1-9][0-9]*)';

  const core = `${number}\\.${number}\\.${number}`;

  if (new RegExp(`^${core}$`).test(version)) {
    return 'latest';
  }

  if (new RegExp(`^${core}-alpha\\.${number}$`).test(version)) {
    return 'alpha';
  }

  throw new Error('Release version must be X.Y.Z or X.Y.Z-alpha.N');
}

export function validateReleaseRef(version, ref) {
  const channel = releaseDistTag(version);

  if (ref !== `refs/tags/v${version}`) {
    throw new Error('Run publication from the matching version tag');
  }

  return channel;
}
