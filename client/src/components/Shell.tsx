import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

import { useUi } from "../lib/store";
import { BonesLauncher, ActionIcons } from "./BonesLauncher";
import { WorkspaceHeader } from "./WorkspaceHeader";

// Minimal stroke icons (no emoji, per the house style).
function IconLibrary() {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="6" height="16" rx="1" />
      <rect x="10" y="4" width="5" height="16" rx="1" />
      <path d="M17 5l3.2.8 -3 14L17 19" />
    </svg>
  );
}
function IconSetlists() {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h10M4 12h10M4 18h7" />
      <circle cx="18.5" cy="16.5" r="2.5" />
      <path d="M21 16.5V8l-2 .6" />
    </svg>
  );
}
function IconHome() {
  return <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l9-8 9 8v10h-6v-7H9v7H3z" /></svg>;
}
function IconGigs() {
  return <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 10h18M8 14h3M8 17h7" /></svg>;
}
function IconPeople() {
  return <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2" /><path d="M3 20c0-4 2-6 6-6s6 2 6 6M15 15c4 0 6 1.5 6 5" /></svg>;
}

const TABS = [
  { to: "/", label: "Home", match: (p: string) => p === "/", icon: <IconHome /> },
  { to: "/repertoire", label: "Repertoire", match: (p: string) => p.startsWith("/repertoire"), icon: <IconLibrary /> },
  { to: "/setlists", label: "Sets", match: (p: string) => p.startsWith("/setlists"), icon: <IconSetlists /> },
  { to: "/gigs", label: "Gigs", match: (p: string) => p.startsWith("/gigs"), icon: <IconGigs /> },
  { to: "/people", label: "People", match: (p: string) => p.startsWith("/people"), icon: <IconPeople /> },
];

/** Persistent app frame for the non-viewer screens: content + a bottom tab bar. */
export function Shell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const openQuickFind = useUi((s) => s.setQuickFindOpen);
  return (
    <div className="shell">
      <WorkspaceHeader />
      {children}
      <BonesLauncher
        actions={[{ key: "find", label: "Find a tune", icon: ActionIcons.find, onClick: () => openQuickFind(true) }]}
      />
      <nav className="nav-bar">
        {TABS.map((t) => (
          <Link key={t.to} to={t.to} className={t.match(pathname) ? "on" : ""} aria-label={t.label}>
            {t.icon}
            <span>{t.label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
