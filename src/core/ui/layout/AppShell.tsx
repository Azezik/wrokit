import type { PropsWithChildren, ReactNode } from 'react';

interface AppShellProps extends PropsWithChildren {
  title: ReactNode;
  subtitle: ReactNode;
}

export function AppShell({ title, subtitle, children }: AppShellProps) {
  return (
    <div className="ui-app-shell">
      <header className="ui-app-shell__header">
        <h1 className="ui-app-shell__title">{title}</h1>
        <p className="ui-app-shell__subtitle">{subtitle}</p>
      </header>
      <main className="ui-app-shell__content">{children}</main>
    </div>
  );
}
