import type { ReactNode } from "react";

type NavKey = "signup" | "account";

type MeteringShellProps = {
  title: string;
  subtitle?: string;
  activeNav?: NavKey;
  maxWidth?: "3xl" | "4xl" | "7xl";
  children: ReactNode;
};

const navLinkClass = (active: boolean) =>
  [
    "font-mono text-xs uppercase tracking-widest transition-colors",
    active ? "text-pl-accent" : "text-pl-text-muted hover:text-white",
  ].join(" ");

export function MeteringShell({
  title,
  subtitle,
  activeNav,
  maxWidth = "4xl",
  children,
}: MeteringShellProps) {
  const maxW =
    maxWidth === "7xl" ? "max-w-7xl" : maxWidth === "3xl" ? "max-w-3xl" : "max-w-4xl";

  return (
    <div className="min-h-screen bg-pl-bg text-white flex flex-col">
      <header className="sticky top-0 z-50 bg-pl-bg-nav/95 border-b-2 border-pl-border backdrop-blur-sm">
        <div className={`${maxW} mx-auto px-4 py-5 sm:px-6 lg:px-8 flex flex-wrap items-center justify-between gap-4`}>
          <div className="flex flex-wrap items-center gap-5 sm:gap-6">
            <img
              src="/metering/logo.svg"
              alt="Powerloom"
              className="w-[140px] sm:w-[180px] h-auto"
            />
            <div>
              <h1 className="font-orbitron text-xl sm:text-2xl font-bold tracking-tight text-white">
                {title}
              </h1>
              {subtitle ? (
                <p className="mt-1 font-mono text-xs uppercase tracking-widest text-pl-text-muted">
                  {subtitle}
                </p>
              ) : null}
            </div>
          </div>
          <nav className="flex items-center gap-4 sm:gap-6">
            <a href="/metering" className={navLinkClass(activeNav === "signup")}>
              Sign up
            </a>
            <a href="/metering/account" className={navLinkClass(activeNav === "account")}>
              Usage
            </a>
          </nav>
        </div>
      </header>

      <main className={`flex-1 ${maxW} mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 sm:py-12 flex flex-col gap-8`}>
        {children}
      </main>
    </div>
  );
}
