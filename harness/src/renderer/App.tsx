import { useEffect } from "react";
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

export default function App(): JSX.Element {
  const init = useHarness((s) => s.init);
  const handleEvent = useHarness((s) => s.handleEvent);

  useEffect(() => {
    void init();
    const off = window.harness.onRunnerEvent((e) => handleEvent(e));
    return off;
  }, [init, handleEvent]);

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
                  isActive ? "bg-edge text-gray-100" : "text-muted hover:text-gray-200"
                }`
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
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
