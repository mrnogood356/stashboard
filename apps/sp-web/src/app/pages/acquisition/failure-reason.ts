/**
 * What Whisparr's message for a failed download means, in plain words, and
 * what to do about it. Null when the message is one we don't recognise; the
 * page then shows Whisparr's own words.
 */
export interface FailureReason {
  reason: string;
  /** The next step, matching a button on the card where there is one. */
  next: string;
}

const RULES: Array<{ test: RegExp; reason: FailureReason }> = [
  {
    test: /no (space|room)|disk (is )?full|not enough (free )?(disk )?space|insufficient (disk )?space|ENOSPC/i,
    reason: {
      reason: 'The download folder ran out of space.',
      next: 'Free some space on that disk, then pick the release again.',
    },
  },
  {
    test: /permission|access (is )?denied|access to the path .* is denied|read-?only|EACCES|EPERM/i,
    reason: {
      reason: 'A folder wasn’t writable: a permissions problem.',
      next: 'Check the folder in Whisparr’s message below. Whichever app writes there (Whisparr, or your download client) needs write access to it.',
    },
  },
  {
    test: /password|encrypted/i,
    reason: {
      reason: 'The download was a password-protected archive.',
      next: 'Pick another release; this one can’t be opened.',
    },
  },
  {
    test: /missing articles|incomplete|repair failed|par2|not enough (repair|recovery)|health|crc|unpack(ing)? failed|extract/i,
    reason: {
      reason: 'The download came down broken: parts of it were missing from the server.',
      next: 'Pick another release, ideally a newer one.',
    },
  },
  {
    test: /stalled|no connections|no (seeds|seeders|peers)|not enough peers/i,
    reason: {
      reason: 'The download stalled: nobody was sending the file.',
      next: 'Pick another release.',
    },
  },
  {
    test: /not an upgrade|existing file|already (exists|imported)|quality cutoff|cutoff (already )?met/i,
    reason: {
      reason: 'Whisparr already has a copy as good as this one, so it skipped it.',
      next: 'Nothing to do if you have the scene; remove this request if it’s stuck.',
    },
  },
  {
    test: /sample|no (video|media|eligible) files|no files found|unknown (scene|movie)|unable to (parse|match)|not match|wrong (scene|movie)|title mismatch/i,
    reason: {
      reason: 'Whisparr couldn’t tell that the download is this scene.',
      next: 'Import it by hand in Whisparr, or pick another release.',
    },
  },
  {
    test: /rejected|blocklist|blacklist/i,
    reason: {
      reason:
        'Whisparr turned this release down (it’s on the block list or doesn’t meet your profile).',
      next: 'Pick another release.',
    },
  },
  {
    // Only an unreachable client: "Download client reported a failure" is a
    // failed release, left to Whisparr's own words.
    test: /timed? ?out|unreachable|ECONNREFUSED|connection refused|couldn.?t (connect|reach)|download client (is )?unavailable|unable to connect/i,
    reason: {
      reason: 'Whisparr couldn’t reach the download client.',
      next: 'Check that SABnzbd (or your download client) is running, then pick the release again.',
    },
  },
];

export function failureReason(message: string | null | undefined): FailureReason | null {
  const text = message?.trim();
  if (!text) {
    return null;
  }
  return RULES.find((rule) => rule.test.test(text))?.reason ?? null;
}
