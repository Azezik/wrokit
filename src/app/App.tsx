import { useState } from 'react';

import { AppShell } from '../core/ui/layout/AppShell';
import { PolishedWizardPage } from './pages/PolishedWizardPage';
import { ConfigCapturePage } from './pages/ConfigCapturePage';
import { HomeDashboardPage } from './pages/HomeDashboardPage';
import { WizardBuilderPage } from './pages/WizardBuilderPage';
import { RunModePage } from './pages/RunModePage';

type Tab = 'wizard' | 'debugging';

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('wizard');

  return (
    <AppShell
      title="Wrokit V2"
      subtitle="Human-confirmed geometry first. UI shell and module boundaries are now explicit."
    >
      <nav className="ui-tabs" role="tablist" aria-label="Top-level interface">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'wizard'}
          className={`ui-tabs__tab${activeTab === 'wizard' ? ' ui-tabs__tab--active' : ''}`}
          onClick={() => setActiveTab('wizard')}
        >
          Wizard
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'debugging'}
          className={`ui-tabs__tab${activeTab === 'debugging' ? ' ui-tabs__tab--active' : ''}`}
          onClick={() => setActiveTab('debugging')}
        >
          Debugging
        </button>
      </nav>

      {activeTab === 'wizard' ? (
        <PolishedWizardPage />
      ) : (
        <>
          <HomeDashboardPage />
          <WizardBuilderPage />
          <ConfigCapturePage />
          <RunModePage />
        </>
      )}
    </AppShell>
  );
}

export default App;
