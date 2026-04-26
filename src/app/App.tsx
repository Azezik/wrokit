import { AppShell } from '../core/ui/layout/AppShell';
import { ConfigCapturePage } from './pages/ConfigCapturePage';
import { HomeDashboardPage } from './pages/HomeDashboardPage';
import { WizardBuilderPage } from './pages/WizardBuilderPage';
import { RunModePage } from './pages/RunModePage';

function App() {
  return (
    <AppShell
      title="Wrokit V2"
      subtitle="Human-confirmed geometry first. UI shell and module boundaries are now explicit."
    >
      <HomeDashboardPage />
      <WizardBuilderPage />
      <ConfigCapturePage />
      <RunModePage />
    </AppShell>
  );
}

export default App;
