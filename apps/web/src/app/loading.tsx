function LoadingLine({ width }: { width: string }) {
  return (
    <div
      aria-hidden="true"
      className="h-3 rounded-[2px] bg-[var(--surface-hover)]"
      style={{ width }}
    />
  );
}

export default function Loading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading workspace"
      className="min-h-screen"
    >
      <div className="flex min-h-28 items-center border-b border-[var(--border)] px-6 sm:px-8">
        <div className="w-full max-w-md space-y-3">
          <LoadingLine width="88px" />
          <LoadingLine width="220px" />
          <LoadingLine width="340px" />
        </div>
      </div>
      <div className="mx-auto max-w-[1440px] p-6 sm:p-8">
        <div className="grid gap-px overflow-hidden rounded-[6px] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div className="h-28 bg-[var(--surface)] p-4" key={index}>
              <LoadingLine width="72px" />
              <div className="mt-4">
                <LoadingLine width="104px" />
              </div>
            </div>
          ))}
        </div>
        <div className="mt-8 h-72 rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-4">
          <LoadingLine width="140px" />
          <div className="mt-6 space-y-5">
            <LoadingLine width="100%" />
            <LoadingLine width="92%" />
            <LoadingLine width="96%" />
          </div>
        </div>
      </div>
    </div>
  );
}
