import { Panel } from '../../core/ui/components/Panel';
import { Section } from '../../core/ui/components/Section';

const moduleStatus = [
  { name: 'Wizard File', status: 'active', note: 'Wizard Builder UI is operational.' },
  { name: 'Normalized Page Intake', status: 'planned', note: 'Contract-first stage, not implemented yet.' },
  { name: 'Geometry File', status: 'planned', note: 'Human-confirmed BBOX layer reserved.' },
  { name: 'Structural Model', status: 'planned', note: 'Machine structure map remains separate.' },
  { name: 'Runtime Localization', status: 'planned', note: 'Not yet connected by design.' }
] as const;

export function HomeDashboardPage() {
  return (
    <Section
      title="Dashboard"
      description="Current module visibility and implementation status for this static-hosted shell."
    >
      <Panel>
        <ul style={{ margin: 0, paddingLeft: '1.25rem', display: 'grid', gap: '0.5rem' }}>
          {moduleStatus.map((module) => (
            <li key={module.name}>
              <strong>{module.name}</strong> — <em>{module.status}</em>: {module.note}
            </li>
          ))}
        </ul>
      </Panel>
    </Section>
  );
}
