export function Loader({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-base-content/70 p-4">
      <span className="loading loading-spinner loading-sm" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorBanner({ error }: { error: unknown }) {
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Something went wrong.";
  return (
    <div role="alert" className="alert alert-error text-sm">
      <span>{msg}</span>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-sm text-base-content/60 italic p-4 text-center">{children}</div>;
}
