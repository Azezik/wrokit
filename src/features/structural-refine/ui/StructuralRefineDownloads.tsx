import { downloadStructuralRefineAnalytics } from '../../../core/io/structural-refine-analytics-io';
import { downloadStructuralModel } from '../../../core/io/structural-model-io';
import { Button } from '../../../core/ui/components/Button';
import type { OrchestratorApi } from '../../polished-wizard/orchestrator/useOrchestrator';

interface StructuralRefineDownloadsProps {
  orchestrator: OrchestratorApi;
}

export function StructuralRefineDownloads({ orchestrator }: StructuralRefineDownloadsProps) {
  const outputs = orchestrator.state.lastRefineOutputs;
  if (!outputs) {
    return null;
  }

  const handleDownloadAnalytics = () => {
    downloadStructuralRefineAnalytics(outputs.analytics);
  };

  const handleDownloadRefinedModel = () => {
    downloadStructuralModel(outputs.refinedModel);
  };

  return (
    <div className="sr-downloads">
      <div className="sr-downloads__divider" aria-hidden="true" />
      <Button type="button" onClick={handleDownloadAnalytics}>
        Download refine analytics
      </Button>
      <Button type="button" onClick={handleDownloadRefinedModel}>
        Download refined model
      </Button>
    </div>
  );
}
