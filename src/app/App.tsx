import { AppShell } from '../core/ui/layout/AppShell';
import { ConfigCapturePage } from './pages/ConfigCapturePage';
import { HomeDashboardPage } from './pages/HomeDashboardPage';
import { WizardBuilderPage } from './pages/WizardBuilderPage';

function App() {
  return (
    <AppShell
      title="Wrokit V2"
      subtitle="Human-confirmed geometry first. UI shell and module boundaries are now explicit."
    >
      <HomeDashboardPage />
      <WizardBuilderPage />
      <ConfigCapturePage />
    </AppShell>
  );
}

export default App;
