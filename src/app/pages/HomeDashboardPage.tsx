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
  {
    name: 'Structural Model',
    status: 'active',
    note: 'Border + Refined Border auto-compute on NormalizedPage upload via the OpenCV.js CV adapter; debug overlay toggle in Config Capture.'
  },
  {
    name: 'Runtime Localization',
    status: 'active',
    note: 'Run Mode now computes runtime structure and redraws predicted field BBOXes from saved Geometry + StructuralModel.'
  },
  {
    name: 'OCRBOX (Localized BBOX OCR)',
    status: 'active',
    note: 'Isolated engine: crops only inside saved or predicted Field BBOXes (with a small symmetric padding clamp) and runs Tesseract.js. Per-field text preview mounts under the viewport in Config and Run.'
  },
  {
    name: 'MasterDB (CSV Ledger)',
    status: 'active',
    note: 'Isolated engine: compiles each document’s OCRBOX result into one row of a wizard-locked CSV. Supports upload-existing, append, and download in both Config and Run.'
  }
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
