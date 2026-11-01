import {
  Boxes,
  Code,
  Coffee,
  Database,
  Hexagon,
  Package,
  Server,
  type LucideProps,
} from "lucide-react";
import type { ComponentType } from "react";
import type { CveFindingSummary } from "../../../shared/cveSubscriptions";

// Python brand mark from Simple Icons: https://simpleicons.org/icons/python.svg
function PythonIcon({ size = 14, ...props }: LucideProps) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M14.25.18l.9.2.73.26.59.3.45.32.34.34.25.34.16.33.1.3.04.26.02.2-.01.13V8.5l-.05.63-.13.55-.21.46-.26.38-.3.31-.33.25-.35.19-.35.14-.33.1-.3.07-.26.04-.21.02H8.77l-.69.05-.59.14-.5.22-.41.27-.33.32-.27.35-.2.36-.15.37-.1.35-.07.32-.04.27-.02.21v3.06H3.17l-.21-.03-.28-.07-.32-.12-.35-.18-.36-.26-.36-.36-.35-.46-.32-.59-.28-.73-.21-.88-.14-1.05-.05-1.23.06-1.22.16-1.04.24-.87.32-.71.36-.57.4-.44.42-.33.42-.24.4-.16.36-.1.32-.05.24-.01h.16l.06.01h8.16v-.83H6.18l-.01-2.75-.02-.37.05-.34.11-.31.17-.28.25-.26.31-.23.38-.2.44-.18.51-.15.58-.12.64-.1.71-.06.77-.04.84-.02 1.27.05zm-6.3 1.98l-.23.33-.08.41.08.41.23.34.33.22.41.09.41-.09.33-.22.23-.34.08-.41-.08-.41-.23-.33-.33-.22-.41-.09-.41.09zm13.09 3.95l.28.06.32.12.35.18.36.27.36.35.35.47.32.59.28.73.21.88.14 1.04.05 1.23-.06 1.23-.16 1.04-.24.86-.32.71-.36.57-.4.45-.42.33-.42.24-.4.16-.36.09-.32.05-.24.02-.16-.01h-8.22v.82h5.84l.01 2.76.02.36-.05.34-.11.31-.17.29-.25.25-.31.24-.38.2-.44.17-.51.15-.58.13-.64.09-.71.07-.77.04-.84.01-1.27-.04-1.07-.14-.9-.2-.73-.25-.59-.3-.45-.33-.34-.34-.25-.34-.16-.33-.1-.3-.04-.25-.02-.2.01-.13v-5.34l.05-.64.13-.54.21-.46.26-.38.3-.32.33-.24.35-.2.35-.14.33-.1.3-.06.26-.04.21-.02.13-.01h5.84l.69-.05.59-.14.5-.21.41-.28.33-.32.27-.35.2-.36.15-.36.1-.35.07-.32.04-.28.02-.21V6.07h2.09l.14.01zm-6.47 14.25l-.23.33-.08.41.08.41.23.33.33.23.41.08.41-.08.33-.23.23-.33.08-.41-.08-.41-.23-.33-.33-.23-.41-.08-.41.08z" />
    </svg>
  );
}

// Brand mark from Simple Icons: https://simpleicons.org/icons/nodedotjs.svg
function NodeJsIcon({ size = 14, ...props }: LucideProps) {
  return <svg {...props} width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M11.998,24c-0.321,0-0.641-0.084-0.922-0.247l-2.936-1.737c-0.438-0.245-0.224-0.332-0.08-0.383 c0.585-0.203,0.703-0.25,1.328-0.604c0.065-0.037,0.151-0.023,0.218,0.017l2.256,1.339c0.082,0.045,0.197,0.045,0.272,0l8.795-5.076 c0.082-0.047,0.134-0.141,0.134-0.238V6.921c0-0.099-0.053-0.192-0.137-0.242l-8.791-5.072c-0.081-0.047-0.189-0.047-0.271,0 L3.075,6.68C2.99,6.729,2.936,6.825,2.936,6.921v10.15c0,0.097,0.054,0.189,0.139,0.235l2.409,1.392 c1.307,0.654,2.108-0.116,2.108-0.89V7.787c0-0.142,0.114-0.253,0.256-0.253h1.115c0.139,0,0.255,0.112,0.255,0.253v10.021 c0,1.745-0.95,2.745-2.604,2.745c-0.508,0-0.909,0-2.026-0.551L2.28,18.675c-0.57-0.329-0.922-0.945-0.922-1.604V6.921 c0-0.659,0.353-1.275,0.922-1.603l8.795-5.082c0.557-0.315,1.296-0.315,1.848,0l8.794,5.082c0.57,0.329,0.924,0.944,0.924,1.603 v10.15c0,0.659-0.354,1.273-0.924,1.604l-8.794,5.078C12.643,23.916,12.324,24,11.998,24z M19.099,13.993 c0-1.9-1.284-2.406-3.987-2.763c-2.731-0.361-3.009-0.548-3.009-1.187c0-0.528,0.235-1.233,2.258-1.233 c1.807,0,2.473,0.389,2.747,1.607c0.024,0.115,0.129,0.199,0.247,0.199h1.141c0.071,0,0.138-0.031,0.186-0.081 c0.048-0.054,0.074-0.123,0.067-0.196c-0.177-2.098-1.571-3.076-4.388-3.076c-2.508,0-4.004,1.058-4.004,2.833 c0,1.925,1.488,2.457,3.895,2.695c2.88,0.282,3.103,0.703,3.103,1.269c0,0.983-0.789,1.402-2.642,1.402 c-2.327,0-2.839-0.584-3.011-1.742c-0.02-0.124-0.126-0.215-0.253-0.215h-1.137c-0.141,0-0.254,0.112-0.254,0.253 c0,1.482,0.806,3.248,4.655,3.248C17.501,17.007,19.099,15.91,19.099,13.993z" /></svg>;
}

// Brand mark from Simple Icons: https://simpleicons.org/icons/npm.svg
function NpmIcon({ size = 14, ...props }: LucideProps) {
  return <svg {...props} width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z" /></svg>;
}

const TECHNOLOGIES: {
  label: string;
  Icon: ComponentType<LucideProps>;
  names: string[];
}[] = [
  { label: "Python", Icon: PythonIcon, names: ["python", "pypi", "pip"] },
  {
    label: "Node.js",
    Icon: NodeJsIcon,
    names: ["node", "node.js", "nodejs"],
  },
  {
    label: "npm",
    Icon: NpmIcon,
    names: ["javascript", "typescript", "npm", "bun"],
  },
  { label: "Rust", Icon: Hexagon, names: ["rust", "crates.io", "cargo"] },
  { label: "Go", Icon: Code, names: ["go", "golang"] },
  { label: "Java", Icon: Coffee, names: ["java", "maven", "gradle"] },
  {
    label: "Containers",
    Icon: Boxes,
    names: ["docker", "container", "kubernetes", "gke"],
  },
  {
    label: "Database",
    Icon: Database,
    names: ["postgresql", "postgres", "mysql", "redis", "sqlite"],
  },
  { label: "Web server", Icon: Server, names: ["nginx", "apache", "httpd"] },
];

export function CveTechnologyIcons({
  finding,
}: {
  finding: CveFindingSummary;
}) {
  const technologies = new Set(
    (finding.technologies ?? []).map((value) => value.toLowerCase()),
  );
  for (const pkg of finding.packages ?? []) technologies.add(pkg.ecosystem.toLowerCase());
  if (finding.packageNames.some(name => name.toLowerCase() === "undici")) technologies.add("node.js");
  const node = ["node", "node.js", "nodejs"].some(name => technologies.has(name));
  const icons = TECHNOLOGIES.filter((technology) =>
    !(node && technology.label === "npm") && technology.names.some((name) => technologies.has(name)),
  );
  if (!technologies.size) return null;
  return (
    <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-base-content/60">
      {icons.map(({ label, Icon }) => (
        <span
          key={label}
          role="img"
          aria-label={`Affected technology: ${label}`}
          title={`Affected technology: ${label}`}
          className="inline-flex"
        >
          <Icon size={14} aria-hidden="true" />
        </span>
      ))}
      {!icons.length && (
        <span
          role="img"
          aria-label={`Affected technologies: ${[...technologies].join(", ")}`}
          title={`Affected technologies: ${[...technologies].join(", ")}`}
        >
          <Package size={14} aria-hidden="true" />
        </span>
      )}
    </span>
  );
}
