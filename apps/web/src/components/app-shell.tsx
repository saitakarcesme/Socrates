"use client";

import {
  BookOpen,
  ChevronDown,
  FlaskConical,
  LayoutDashboard,
  Menu,
  Search,
  Settings,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { cn } from "@socrates/design-system";

import { useUiStore } from "@/store/ui-store";

const navigation = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
  { label: "Projects", href: "/projects", icon: FlaskConical },
  { label: "Learnings", href: "/learnings", icon: BookOpen },
];

function Navigation() {
  const pathname = usePathname();
  const setOpen = useUiStore((state) => state.setMobileNavigationOpen);

  return (
    <>
      <div className="flex h-14 items-center border-b border-[var(--border)] px-3">
        <div className="flex size-7 items-center justify-center rounded-[4px] border border-[var(--border-strong)] bg-white font-serif text-sm font-semibold text-black">
          S
        </div>
        <span className="ml-2 text-sm font-semibold tracking-[-0.02em]">
          Socrates
        </span>
        <button
          aria-label="Close navigation"
          className="ml-auto text-[var(--text-muted)] lg:hidden"
          onClick={() => setOpen(false)}
          type="button"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="border-b border-[var(--border)] p-2">
        <button
          className="flex h-8 w-full items-center gap-2 rounded-[4px] px-2 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          type="button"
        >
          <Search className="size-3.5" />
          Search
          <kbd className="ml-auto rounded-[3px] border border-[var(--border)] px-1.5 py-0.5 font-mono text-[9px]">
            /
          </kbd>
        </button>
      </div>

      <nav aria-label="Primary" className="flex-1 p-2">
        <div className="mb-2 px-2 pt-2 text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-subtle)]">
          Workspace
        </div>
        {navigation.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href.split("/").slice(0, 2).join("/"));
          const Icon = item.icon;

          return (
            <Link
              className={cn(
                "mb-0.5 flex h-8 items-center gap-2 rounded-[4px] px-2 text-[13px] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]",
                active && "bg-[var(--surface-hover)] text-[var(--text)]",
              )}
              href={item.href}
              key={item.href}
              onClick={() => setOpen(false)}
            >
              <Icon className="size-3.5" strokeWidth={1.8} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-[var(--border)] p-2">
        <Link
          className={cn(
            "flex h-8 items-center gap-2 rounded-[4px] px-2 text-[13px] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]",
            pathname === "/settings" &&
              "bg-[var(--surface-hover)] text-[var(--text)]",
          )}
          href="/settings"
          onClick={() => setOpen(false)}
        >
          <Settings className="size-3.5" strokeWidth={1.8} />
          Settings
        </Link>
        <button
          className="mt-1 flex h-10 w-full items-center gap-2 rounded-[4px] px-2 text-left hover:bg-[var(--surface-hover)]"
          type="button"
        >
          <span className="flex size-6 items-center justify-center rounded-[3px] bg-neutral-800 text-[10px] font-medium">
            SK
          </span>
          <span className="min-w-0">
            <span className="block truncate text-xs text-[var(--text)]">
              Sam K.
            </span>
            <span className="block text-[10px] text-[var(--text-subtle)]">
              Personal workspace
            </span>
          </span>
          <ChevronDown className="ml-auto size-3 text-[var(--text-subtle)]" />
        </button>
      </div>
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const open = useUiStore((state) => state.mobileNavigationOpen);
  const setOpen = useUiStore((state) => state.setMobileNavigationOpen);

  return (
    <div className="min-h-screen bg-[var(--canvas)] text-[var(--text)]">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[232px] flex-col border-r border-[var(--border)] bg-[var(--sidebar)] lg:flex">
        <Navigation />
      </aside>

      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/70"
            onClick={() => setOpen(false)}
            type="button"
          />
          <aside className="relative flex h-full w-[264px] flex-col border-r border-[var(--border)] bg-[var(--sidebar)]">
            <Navigation />
          </aside>
        </div>
      ) : null}

      <div className="lg:pl-[232px]">
        <header className="sticky top-0 z-20 flex h-12 items-center border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--canvas)_94%,transparent)] px-4 backdrop-blur-md lg:hidden">
          <button
            aria-label="Open navigation"
            onClick={() => setOpen(true)}
            type="button"
          >
            <Menu className="size-4" />
          </button>
          <span className="ml-3 text-sm font-semibold">Socrates</span>
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}
