import type { MasterDbTable } from '../contracts/masterdb-table';
import { serializeMasterDbCsv } from '../engines/masterdb';

export const masterDbCsvDownloadName = (table: MasterDbTable): string => {
  const safeWizard = (table.wizardId || 'wizard').replace(/\s+/g, '-').toLowerCase();
  return `${safeWizard}.masterdb.csv`;
};

export interface MasterDbCsvDownloadEnv {
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  triggerAnchor: (url: string, fileName: string) => void;
}

const browserDownloadEnv = (): MasterDbCsvDownloadEnv => ({
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  triggerAnchor: (url, fileName) => {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
  }
});

export const downloadMasterDbCsv = (
  table: MasterDbTable,
  env: MasterDbCsvDownloadEnv = browserDownloadEnv()
): void => {
  const blob = new Blob([serializeMasterDbCsv(table)], { type: 'text/csv;charset=utf-8' });
  const url = env.createObjectUrl(blob);
  try {
    env.triggerAnchor(url, masterDbCsvDownloadName(table));
  } finally {
    env.revokeObjectUrl(url);
  }
};
