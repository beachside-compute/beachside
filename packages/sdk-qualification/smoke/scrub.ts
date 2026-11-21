/**
 * Scrubs everything the smoke runner prints, writes to a report or hands to an issue. Public CI
 * logs mask only exact secret strings, so this also removes encoded forms and token-shaped text
 * an adapter could derive at run time.
 */
export class Scrubber {
  private readonly values: string[] = [];
  hits = 0;

  /** Secrets shorter than this are too likely to match ordinary words. */
  static readonly minimumLength = 8;

  constructor(secrets: Iterable<string>) {
    for (const secret of secrets) this.add(secret);
  }

  add(secret: string): void {
    if (secret.length < Scrubber.minimumLength) return;

    for (const form of [
      secret,
      Buffer.from(secret).toString("base64").replace(/=+$/, ""),
      Buffer.from(secret).toString("base64url"),
      encodeURIComponent(secret),
    ])
      if (!this.values.includes(form)) this.values.push(form);

    this.values.sort((a, b) => b.length - a.length);
  }

  /** The text with secrets and token-shaped strings replaced; counts every replacement. */
  scrub(text: string): string {
    let result = text;

    for (const value of this.values) {
      const parts = result.split(value);
      this.hits += parts.length - 1;
      result = parts.join("[redacted]");
    }

    // Token shapes no list can know in advance: JWTs, auth headers and provider key prefixes.
    for (const pattern of Scrubber.patterns)
      // Every pattern's first group is the text to keep before the token (often empty).
      result = result.replace(pattern, (_token: string, prefix: string) => {
        this.hits += 1;

        return `${prefix}[redacted-token]`;
      });

    return result;
  }

  static readonly patterns = [
    /()eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    /((?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic|token)?\s*)[^\s"',]{8,}/gi,
    /()\b(?:e2b|dtn|bxds|sk|pk|rk|ghp|gho|ghs|github_pat|xox[abp])_[A-Za-z0-9_-]{12,}/g,
  ];
}

/** Every value of the named variables that is set, for a Scrubber. */
export function secretValues(environment: Record<string, string | undefined>, names: string[]) {
  return names.flatMap((name) => {
    const value = environment[name];

    return value ? [value] : [];
  });
}
