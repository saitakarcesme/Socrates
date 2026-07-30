import Link from "next/link";

import { Button } from "@socrates/design-system";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <div className="font-mono text-xs text-[var(--text-subtle)]">404</div>
        <h1 className="mt-3 text-xl font-semibold">Surface not found</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">
          This route is not part of the current research workspace.
        </p>
        <Link href="/">
          <Button className="mt-5">Return to dashboard</Button>
        </Link>
      </div>
    </div>
  );
}
