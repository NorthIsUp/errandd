/** Version parsing shared by the plugin and marketplace release scripts. */
export type BumpType = "patch" | "minor" | "major";

export function parseBumpType(raw = "patch"): BumpType {
  if (raw === "patch" || raw === "minor" || raw === "major") return raw;
  throw new Error(`Unsupported bump type: ${raw}. Use patch, minor, or major.`);
}

export function bumpVersion(version: string, type: BumpType): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) throw new Error(`Unsupported version format: ${version}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (type === "major") return `${major + 1}.0.0`;
  if (type === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
