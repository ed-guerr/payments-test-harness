import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { DbPage } from "./pages/DbPage";
import { RegistryPage } from "./pages/RegistryPage";
import { SuiteListPage } from "./pages/SuiteListPage";
import { SuitePage } from "./pages/SuitePage";
import { useHarness } from "./store";

const tabs = [
  { to: "/", label: "Suites" },
  { to: "/registry", label: "Protocol Registry" },
  { to: "/db", label: "Database" },
];

/** Flat 13px icons for the theme toggle (stroke = currentColor). */
function SunIcon(): JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon(): JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

type Theme = "dark" | "light";

function initialTheme(): Theme {
  try {
    return localStorage.getItem("harness-theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export default function App(): JSX.Element {
  const init = useHarness((s) => s.init);
  const handleEvent = useHarness((s) => s.handleEvent);
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    void init();
    const off = window.harness.onRunnerEvent((e) => handleEvent(e));
    return off;
  }, [init, handleEvent]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("harness-theme", theme);
    } catch {
      /* storage unavailable — theme just won't persist */
    }
  }, [theme]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-edge bg-panel px-6 py-3 flex items-center gap-8">
        <h1 className="text-sm font-semibold tracking-widest text-accent uppercase">
          Payments Test Harness
        </h1>
        <nav className="flex gap-1">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.to === "/"}
              className={({ isActive }) =>
                `px-3 py-1.5 rounded text-xs font-medium ${
                  isActive ? "bg-edge text-fg" : "text-muted hover:text-fg"
                }`
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
        <button
          onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          title="Toggle color theme"
          className="ml-auto flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-edge hover:bg-faint/40 text-dim"
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          {theme === "dark" ? "light" : "dark"}
        </button>
      </header>
      <main className="p-6">
        <Routes>
          <Route path="/" element={<SuiteListPage />} />
          <Route path="/suite/:name" element={<SuitePage />} />
          <Route path="/registry" element={<RegistryPage />} />
          <Route path="/db" element={<DbPage />} />
        </Routes>
      </main>
    </div>
  );
}
