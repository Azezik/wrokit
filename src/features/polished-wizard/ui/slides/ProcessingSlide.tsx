import type { OrchestratorApi } from '../../orchestrator/useOrchestrator';

interface ProcessingSlideProps {
  orchestrator: OrchestratorApi;
}

const phaseLabel: Record<string, string> = {
  normalizing: 'Normalizing',
  structuring: 'Building structure',
  localizing: 'Locating fields',
  extracting: 'Reading text',
  appending: 'Saving to MasterDB',
  done: 'Finishing up'
};

export function ProcessingSlide({ orchestrator }: ProcessingSlideProps) {
  const progress = orchestrator.state.batchProgress;
  const completed = progress ? progress.currentIndex : 0;
  const total = progress ? progress.total : 0;
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;

  return (
    <div className="polished-wizard__slide polished-wizard__loading-stage">
      <div className="polished-wizard__spinner" aria-hidden="true" />
      <h2 className="polished-wizard__title">Processing your batch</h2>
      <p className="polished-wizard__subtitle">
        {progress
          ? `${phaseLabel[progress.phase] ?? progress.phase}: ${progress.currentName || '…'}`
          : 'Starting…'}
      </p>
      <div style={{ width: '100%', maxWidth: 360 }}>
        <div className="polished-wizard__progress-bar" aria-hidden="true">
          <div
            className="polished-wizard__progress-bar-fill"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="polished-wizard__hint" style={{ marginTop: '0.5rem' }}>
          Document {Math.min(completed + (progress?.phase === 'done' ? 0 : 1), total) || 0} of {total}
        </p>
      </div>
    </div>
  );
}
