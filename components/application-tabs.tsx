"use client";
export const appTabs = [
  { id: "launch", label: "Launch Token" },
  { id: "tokens", label: "My Tokens" },
  { id: "fees", label: "Creator Fees" },
] as const;
export type AppTab = (typeof appTabs)[number]["id"];
export function ApplicationTabs({
  active,
  onChange,
}: {
  active: AppTab;
  onChange: (tab: AppTab) => void;
}) {
  return (
    <nav className="app-tabs" role="tablist" aria-label="Launcher sections">
      {appTabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-controls={`panel-${tab.id}`}
          aria-selected={active === tab.id}
          tabIndex={active === tab.id ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % appTabs.length
                : event.key === "ArrowLeft"
                  ? (index + appTabs.length - 1) % appTabs.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? appTabs.length - 1
                      : undefined;
            if (next === undefined) return;
            event.preventDefault();
            onChange(appTabs[next].id);
            event.currentTarget.parentElement
              ?.querySelector<HTMLButtonElement>(`#tab-${appTabs[next].id}`)
              ?.focus();
          }}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
// Panels remain mounted: hiding a tab must not discard forms, wallet state or journals.
export function ApplicationPanel({
  id,
  active,
  children,
}: {
  id: AppTab;
  active: AppTab;
  children: React.ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`panel-${id}`}
      aria-labelledby={`tab-${id}`}
      hidden={active !== id}
    >
      {children}
    </div>
  );
}
