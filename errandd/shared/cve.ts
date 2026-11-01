/** Browser-safe CVE configuration and normalization for CVE.org/CVEFeed. */
export interface CveRule {
  repositories: string[];
  severity: string[];
  product: string[];
  vendor: string[];
  project: string[];
  ecosystem: string[];
  language: string[];
  technology: string[];
  webserver?: string[];
  lockfiles?: boolean;
  history?: boolean;
  autoResolve?: boolean;
  includeUnclassified: boolean;
  poll: boolean;
}
export const defaultCveRule = (): CveRule => ({
  repositories: ["current"],
  severity: ["high", "critical"],
  product: [],
  vendor: [],
  project: [],
  ecosystem: [],
  language: [],
  technology: [],
  webserver: [],
  lockfiles: false,
  history: false,
  autoResolve: true,
  includeUnclassified: true,
  poll: true,
});
export function parseCveRule(value: unknown): CveRule | false {
  if (value === false) return false;
  if (value === true || value == null) return defaultCveRule();
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("cve: expected true, false, or a mapping");
  const raw = value as Record<string, unknown>;
  const rule = defaultCveRule();
  for (const key of [
    "repositories",
    "severity",
    "product",
    "vendor",
    "project",
    "ecosystem",
    "language",
    "technology",
    "webserver",
  ] as const) {
    if (raw[key] === undefined) continue;
    const values = typeof raw[key] === "string" ? [raw[key]] : raw[key];
    if (!Array.isArray(values) || values.some((item) => typeof item !== "string" || !item.trim()))
      throw new Error(`cve.${key}: expected a string or list of nonempty strings`);
    rule[key] = [...new Set(values.map((item) => (item as string).trim()))];
  }
  if (rule.repositories.some((repo) => repo !== "current" && !/^[\w.-]+\/[\w.-]+$/.test(repo)))
    throw new Error("cve.repositories: use current or explicit owner/repo names");
  if (
    rule.severity.some(
      (severity) =>
        !["*", "unknown", "low", "medium", "high", "critical"].includes(severity.toLowerCase()),
    )
  )
    throw new Error("cve.severity: unknown severity");
  rule.severity = rule.severity.map((severity) => severity.toLowerCase());
  for (const key of ["lockfiles", "history", "autoResolve"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "boolean") throw new Error(`cve.${key}: expected a boolean`);
    rule[key] = raw[key];
  }
  if (raw.poll !== undefined) {
    if (typeof raw.poll !== "boolean") throw new Error("cve.poll: expected a boolean");
    rule.poll = raw.poll;
  }
  if (raw.includeUnclassified !== undefined) {
    if (typeof raw.includeUnclassified !== "boolean")
      throw new Error("cve.includeUnclassified: expected a boolean");
    rule.includeUnclassified = raw.includeUnclassified;
  }
  return rule;
}

export interface CveAlert {
  schema: "errandd.cve.v1";
  source: "cve.org" | "cvefeed" | "github" | "osv" | "nvd" | "pypi" | "npm";
  aliases?: string[];
  sources?: { source: string; url: string; updatedAt: string }[];
  id: string;
  title: string;
  description: string;
  severity: string;
  score: number | null;
  updatedAt: string;
  url: string;
  project: string;
  products: { vendor: string; product: string }[];
  ecosystems: string[];
  languages: string[];
  technologies: string[];
  affected: unknown[];
  weaknesses?: { id: string; name?: string }[];
  references: string[];
  rejected: boolean;
  test: boolean;
  targetRepository?: string;
  dependencyScanGeneration?: number;
  dependencyEvidence?: { name: string; version: string; ecosystem: string; path: string }[];
}
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const ECOSYSTEM_LANGUAGES: Record<string, string[]> = {
  npm: ["javascript", "typescript"],
  pypi: ["python"],
  maven: ["java", "kotlin"],
  cargo: ["rust"],
  golang: ["go"],
  gem: ["ruby"],
  composer: ["php"],
  nuget: ["c#", "f#"],
  swift: ["swift"],
  conan: ["c", "c++"],
};
const COLLECTION_ECOSYSTEMS: Record<string, string> = {
  "npmjs.com": "npm",
  "registry.npmjs.org": "npm",
  "pypi.org": "pypi",
  "rubygems.org": "gem",
  "crates.io": "cargo",
  "pkg.go.dev": "golang",
  "packagist.org": "composer",
  "nuget.org": "nuget",
  "repo.maven.apache.org": "maven",
  "repo1.maven.org": "maven",
};
const ECOSYSTEM_ALIASES: Record<string, string> = {
  pip: "pypi",
  python: "pypi",
  rubygems: "gem",
  rust: "cargo",
  "crates.io": "cargo",
  go: "golang",
};
export const ecosystemName = (value: string) =>
  ECOSYSTEM_ALIASES[value.toLowerCase()] ?? value.toLowerCase();
export const ecosystemLanguages = (value: string): string[] => ECOSYSTEM_LANGUAGES[ecosystemName(value)] ?? [];
export const isCveId = (value: string): boolean => /^CVE-\d{4}-\d{4,}$/.test(value);
export const isGhsaId = (value: string): boolean =>
  /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/i.test(
    value,
  );
export const advisoryId = (value: string): string =>
  isCveId(value.toUpperCase())
    ? value.toUpperCase()
    : isGhsaId(value)
      ? `GHSA-${value.slice(5).toLowerCase()}`
      : !/^(CVE|GHSA)-/i.test(value) &&
          /^[A-Z][A-Z0-9]{1,24}-[A-Za-z0-9][A-Za-z0-9:._+-]{1,120}$/.test(value)
        ? value
        : "";
/** Only explicit CWE identifiers assert a weakness classification. */
export function readCveWeaknesses(values: unknown[]): NonNullable<CveAlert["weaknesses"]> {
  const result = new Map<string, { id: string; name?: string }>();
  for (const value of values) {
    const item = object(value);
    const id = (typeof value === "string" ? value : string(item.cweId) || string(item.cwe_id)).toUpperCase();
    if (!/^CWE-[1-9]\d*$/.test(id)) continue;
    const name = string(item.name) || string(item.description);
    result.set(id, { id, ...(name ? { name } : {}) });
  }
  return [...result.values()];
}
export function queuedCveAlert(payload: unknown): CveAlert | null {
  const root = object(payload);
  return root.schema === "errandd.cve.v1" &&
    Boolean(advisoryId(string(root.id))) &&
    Array.isArray(root.products)
    ? (root as unknown as CveAlert)
    : readCveAlert(payload);
}

export function readCveAlert(payload: unknown): CveAlert | null {
  const root = object(payload);
  const feed = object(root.vulnerability);
  const metadata = object(root.cveMetadata);
  const isFeed = Object.keys(feed).length > 0;
  const id = string(isFeed ? feed.id : metadata.cveId).toUpperCase();
  if (!isCveId(id)) return null;
  const containers = object(root.containers);
  const cna = object(containers.cna);
  const allContainers = [cna, ...list(containers.adp).map(object)];
  const affected = isFeed
    ? Array.isArray(feed.configurations)
      ? feed.configurations
      : feed.configurations
        ? [feed.configurations]
        : []
    : allContainers.flatMap((container) => list(container.affected));
  const products: CveAlert["products"] = [];
  if (isFeed) {
    for (const value of [root.affected_products, ...list(feed.affected_products)]) {
      const product = object(value);
      const name = string(product.name);
      if (name) products.push({ product: name, vendor: string(object(product.vendor).name) });
    }
  } else
    for (const value of affected) {
      const product = object(value);
      if (product.product || product.packageName)
        products.push({
          product: string(product.packageName) || string(product.product),
          vendor: string(product.vendor),
        });
    }
  const metrics = allContainers.flatMap((container) => list(container.metrics)).map(object);
  const cvss = metrics
    .flatMap((metric) => [metric.cvssV4_0, metric.cvssV3_1, metric.cvssV3_0, metric.cvssV2_0])
    .map(object);
  const scoreValue = isFeed
    ? feed.cvss_score
    : cvss.find((metric) => typeof metric.baseScore === "number")?.baseScore;
  const numeric =
    typeof scoreValue === "number"
      ? scoreValue
      : typeof scoreValue === "string" && scoreValue.trim()
        ? Number(scoreValue)
        : NaN;
  const score = Number.isFinite(numeric) && numeric >= 0 && numeric <= 10 ? numeric : null;
  const severity = (
    string(isFeed ? feed.severity : cvss.find((metric) => metric.baseSeverity)?.baseSeverity) ||
    (score == null
      ? "unknown"
      : score >= 9
        ? "critical"
        : score >= 7
          ? "high"
          : score >= 4
            ? "medium"
            : "low")
  ).toLowerCase();
  const references = (
    isFeed
      ? list(feed.references)
      : allContainers.flatMap((container) => list(container.references))
  )
    .map((value) => (typeof value === "string" ? value : string(object(value).url)))
    .filter((value) => /^https?:\/\//i.test(value));
  const descriptions = list(cna.descriptions).map(object);
  const ecosystems = new Set<string>();
  const technologies = new Set(
    products.flatMap((product) => [product.product, product.vendor]).filter(Boolean),
  );
  // Only structured fields classify the advisory; prose is never a language detector.
  const classify = (value: unknown, depth = 0): void => {
    if (depth > 12) return;
    if (Array.isArray(value)) {
      for (const child of value) classify(child, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(object(value))) {
      if (typeof child === "string") {
        if (/^collectionURL$/i.test(key)) {
          try {
            const ecosystem = COLLECTION_ECOSYSTEMS[new URL(child).hostname.replace(/^www\./, "")];
            if (ecosystem) ecosystems.add(ecosystem);
          } catch {
            /* Not a known package registry URL. */
          }
        }
        if (/^(ecosystem|packageType)$/i.test(key)) ecosystems.add(ecosystemName(child));
        if (/^(packageURL|purl)$/i.test(key)) {
          const parsed = /^pkg:([^/]+)\/([^?#]+)/.exec(child);
          if (parsed?.[1] && parsed[2]) {
            ecosystems.add(ecosystemName(parsed[1]));
            try {
              technologies.add(decodeURIComponent(parsed[2].replace(/@[^/]*$/, "")));
            } catch {
              /* malformed PURL remains unclassified */
            }
          }
        }
        if (/^(product|packageName|vendor)$/i.test(key)) technologies.add(child);
        if (/^cpe:2\.3:/i.test(child)) {
          const parts = child.split(":");
          for (const token of [parts[3], parts[4], parts[10]])
            if (token && token !== "*" && token !== "-") technologies.add(token);
        }
      }
      if (/^(modules|platforms)$/i.test(key))
        for (const token of list(child)) if (typeof token === "string") technologies.add(token);
      if (child && typeof child === "object") classify(child, depth + 1);
    }
  };
  classify(affected);
  if (isFeed) classify(feed.affected_products);
  for (const ecosystem of ecosystems) technologies.add(ecosystem);
  return {
    schema: "errandd.cve.v1",
    source: isFeed ? "cvefeed" : "cve.org",
    id,
    aliases: [id],
    title: (string(isFeed ? feed.title : cna.title) || id).slice(0, 500),
    description: (isFeed
      ? string(feed.description)
      : string(descriptions.find((description) => description.lang === "en")?.value) ||
        string(descriptions[0]?.value)
    ).slice(0, 16000),
    severity,
    score,
    updatedAt: string(isFeed ? feed.last_modified : metadata.dateUpdated),
    url: `https://www.cve.org/CVERecord?id=${id}`,
    project:
      string(root.project_slug) ||
      (typeof root.project_id === "number" ? String(root.project_id) : string(root.project_id)),
    products: products.slice(0, 200),
    affected,
    weaknesses: readCveWeaknesses(allContainers.flatMap(container => list(container.problemTypes).flatMap(value => list(object(value).descriptions)))),
    ecosystems: [...ecosystems],
    languages: [
      ...new Set([...ecosystems].flatMap((ecosystem) => ECOSYSTEM_LANGUAGES[ecosystem] ?? [])),
    ],
    technologies: [...technologies].slice(0, 500),
    references: [...new Set(references)].slice(0, 40),
    rejected:
      feed.is_rejected === true ||
      string(isFeed ? feed.status : metadata.state).toUpperCase() === "REJECTED",
    test:
      isFeed &&
      root.unread !== undefined &&
      root.timestamp !== undefined &&
      root.created_at === undefined,
  };
}

/** Normalize the public, reviewed GitHub Advisory API (including GHSA-only records). */
export function readGithubAdvisory(payload: unknown): CveAlert | null {
  const raw = object(payload);
  const ghsa = advisoryId(string(raw.ghsa_id));
  if (!isGhsaId(ghsa) || raw.type !== "reviewed") return null;
  const aliases = [
    ...new Set(
      [
        ghsa,
        advisoryId(string(raw.cve_id)),
        ...list(raw.identifiers).map((value) => advisoryId(string(object(value).value))),
      ].filter(Boolean),
    ),
  ];
  const id = aliases.find(isCveId) ?? ghsa;
  const affected = list(raw.vulnerabilities).map(object);
  const ecosystems = [
    ...new Set(
      affected
        .map((value) => ecosystemName(string(object(value.package).ecosystem)))
        .filter(Boolean),
    ),
  ];
  const products = affected
    .map((value) => ({ vendor: "", product: string(object(value.package).name) }))
    .filter((value) => value.product);
  const cvss = object(raw.cvss);
  const severity = string(raw.severity).toLowerCase();
  const url = `https://github.com/advisories/${ghsa}`;
  return {
    schema: "errandd.cve.v1",
    source: "github",
    id,
    aliases,
    title: (string(raw.summary) || id).slice(0, 500),
    description: string(raw.description).slice(0, 16000),
    severity: ["low", "medium", "high", "critical"].includes(severity) ? severity : "unknown",
    score:
      typeof cvss.score === "number" && cvss.score >= 0 && cvss.score <= 10 ? cvss.score : null,
    updatedAt: string(raw.updated_at),
    url,
    project: "",
    products: products.slice(0, 200),
    affected,
    weaknesses: readCveWeaknesses(list(raw.cwes)),
    ecosystems,
    languages: [...new Set(ecosystems.flatMap((value) => ECOSYSTEM_LANGUAGES[value] ?? []))],
    technologies: [...new Set([...products.map((value) => value.product), ...ecosystems])].slice(
      0,
      500,
    ),
    references: [
      ...new Set([
        url,
        ...list(raw.references).filter(
          (value): value is string => typeof value === "string" && /^https?:\/\//i.test(value),
        ),
      ]),
    ].slice(0, 80),
    rejected: Boolean(raw.withdrawn_at),
    test: false,
  };
}

export const CVE_PR_POLICY = `## CVE remediation pull requests

Apply the label errandd:cve-response to every pull request created or reused for CVE remediation, including code fixes and dependency upgrades. For PRs whose entire diff changes only dependency versions and generated lock metadata, additionally apply errandd:automerge after verifying the upgrade and relevant tests. Mixed code/dependency fixes receive errandd:cve-response only unless separately authorized. Preserve unrelated labels. Create missing labels when permitted and verify both label updates on the actual PR; report any labeling blocker. The automerge label authorizes the existing review-and-CI merge workflow, not bypassing required checks or approvals. Code-fix PRs require errandd:cve-response but do not gain automatic merge authorization solely because they respond to a CVE.

When multiple advisories affect the same dependency in the target repository, reuse one remediation branch and PR if a tested upgrade addresses them together. Include every covered CVE/GHSA ID and validate each advisory against the resulting locked version. Keep applicability and resolution evidence separate for each advisory. Upon resolving one finding in a remediation group, recheck every CVE thread for that technology in the same repository, including legacy per-CVE chats. Use the latest complete version-aware lockfile scan to reconcile each advisory against its own affected ranges across every installed occurrence. Let deterministic scan results resolve sibling findings and cancel their pending remediation work; do not start separate agent chats merely to confirm the same version bump. Retain affected or inconclusive status for vulnerable, unscanned or unknown-version paths. A merged PR or a shared fixed-version label alone is not resolution evidence. Update the related tracking issues with each advisory’s verified coverage; repository lockfile resolution does not prove the deployed runtime is fixed. The chat is a repository/package remediation lane, not a single advisory or lockfile. Review every incoming advisory in this chat and every occurrence of the package across the repository. Maintain a CVE × lockfile/version coverage matrix, including incompatible release lines and unknown fixes. A merged PR covering one path does not resolve other paths. Reuse the existing remediation PR where compatible; create separate PRs only when fixes cannot safely ship together, and keep their progress in this same chat.`;

export const CVE_REMEDIATION_PROMPT = `# Assess and remediate a CVE

Is the target codebase or product susceptible to the vulnerability (CVE or GHSA) in the incoming alert?

1. Use only the target repository named in the alert. "current" means the configured working repository: verify its git root and origin before proceeding. For owner/repo targets, use an isolated checkout/worktree of that repository. If the target cannot be resolved, report blocked and stop.
2. Use the advisory context supplied above to check the target repository’s manifests, resolved lockfiles, transitive dependencies, container/base images, code paths and deployment configuration. Determine whether the affected versions and exploit prerequisites apply.
3. Use the repository's configured ticketing system and project. Search for an existing tracking issue using the target repository and every CVE/GHSA alias; reuse it instead of creating duplicates. If none exists, create one before investigating further. Include the advisory aliases, severity, source links, target repository and initial lockfile evidence. Set priority and urgency using the ticketing system's supported values and the project's severity mapping: critical gets the highest security priority/urgency, then high, medium and low; unknown severity requires triage rather than being treated as low. Reassess priority/urgency when severity or exposure evidence changes, and explain any adjustment. If the ticketing destination or access is unavailable, report that blocker explicitly; do not invent a destination or claim an issue was created.
4. Keep that same issue updated as new information is found: applicability, installed versions and affected ranges, exploit prerequisites, investigation progress, remediation decisions, validation results, blockers and fix PR links. Report its URL in the errand conversation.
5. Report affected, not affected, or inconclusive, with all CVE/GHSA aliases, installed versions, affected ranges, reachable code/configuration and source links. If not affected or inconclusive, explain why; do not fabricate a fix or open an empty PR.
6. If affected, find an existing fix PR/branch for this vulnerability (checking every CVE/GHSA alias) and target before creating one. Make the smallest correct fix on an isolated branch, update lockfiles, and add a regression test where useful. Do not run public exploit code against production.
7. For Python dependency fixes, rerun pip-audit against the updated locked dependencies; for npm dependencies, rerun npm audit (or the repository package manager’s audit). Use the existing package manager and update its lockfile. Prefer the smallest compatible patched version; if none exists, report the blocker rather than claiming a fix. Run the relevant tests and checks. If the fix is verified, commit it and open or update a PR against the target repository's default branch. Include applicability evidence, changes, validation, limitations and the advisory links. Report the PR URL and update the tracking issue. Keep affected issues open while the fix is pending; a PR alone is not proof of remediation. Record a not-affected conclusion with evidence, and resolve the issue only according to the project's workflow after verified remediation or confirmed non-applicability. Do not merge, deploy, or modify unrelated repositories.

${CVE_PR_POLICY}
`;
export const CVE_JOB_TEMPLATE = `---\nenabled: true\nnotify: error\non:\n  - cve:\n      repositories: [current]\n      severity: ["*"]\n      poll: true\n      lockfiles: true\n      history: true\n      autoResolve: true\n---\n\n${CVE_REMEDIATION_PROMPT}`;
