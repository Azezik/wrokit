import { useOrchestrator } from '../orchestrator/useOrchestrator';
import type { OrchestratorStep } from '../orchestrator/types';
import { ConfigureWizardSlide } from './slides/ConfigureWizardSlide';
import { DrawBoxesSlide } from './slides/DrawBoxesSlide';
import { UploadBatchSlide } from './slides/UploadBatchSlide';
import { ProcessingSlide } from './slides/ProcessingSlide';
import { ReviewSlide } from './slides/ReviewSlide';

import './polished-wizard.css';

const STEP_ORDER: OrchestratorStep[] = [
  'configure',
  'draw',
  'upload',
  'processing',
  'review'
];

export function PolishedWizard() {
  const orchestrator = useOrchestrator();
  const { state } = orchestrator;
  const activeIndex = STEP_ORDER.indexOf(state.step);

  return (
    <div className="polished-wizard" aria-label="Wizard">
      <div className="polished-wizard__card" role="region">
        <div className="polished-wizard__progress" aria-hidden="true">
          {STEP_ORDER.map((step, index) => (
            <span
              key={step}
              className={`polished-wizard__progress-pip${
                index < activeIndex
                  ? ' polished-wizard__progress-pip--done'
                  : index === activeIndex
                    ? ' polished-wizard__progress-pip--active'
                    : ''
              }`}
            />
          ))}
        </div>

        {state.step === 'configure' ? (
          <ConfigureWizardSlide orchestrator={orchestrator} />
        ) : state.step === 'draw' ? (
          <DrawBoxesSlide orchestrator={orchestrator} />
        ) : state.step === 'upload' ? (
          <UploadBatchSlide orchestrator={orchestrator} />
        ) : state.step === 'processing' ? (
          <ProcessingSlide orchestrator={orchestrator} />
        ) : (
          <ReviewSlide orchestrator={orchestrator} />
        )}
      </div>
    </div>
  );
}
