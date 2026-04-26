import { Panel } from '../../core/ui/components/Panel';
import { Section } from '../../core/ui/components/Section';

const moduleStatus = [
  { name: 'Wizard File', status: 'active', note: 'Wizard Builder UI is operational.' },
  {
    name: 'Normalized Page Intake',
    status: 'active',
    note: 'Intake is unified into Config Capture — upload, normalization, and BBOX drawing happen in one flow.'
  },
  {
    name: 'Geometry File',
    status: 'active',
    note: 'Config Mode BBOX capture, validation, and import/export now wired.'
  },
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
