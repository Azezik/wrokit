import type { NormalizedPage } from '../contracts/normalized-page';
import { buildDocumentFingerprint } from '../page-surface/page-surface-fingerprint';
import type { ObservableStore, StoreListener } from './observable-store';

export interface NormalizedPageSessionState {
  sessionId: string;
  documentFingerprint: string;
  sourceName: string;
  pages: NormalizedPage[];
  selectedPageIndex: number;
}

export interface SetNormalizedDocumentInput {
  sourceName: string;
  pages: NormalizedPage[];
}

export interface NormalizedPageSessionStore extends ObservableStore<NormalizedPageSessionState> {
  setNormalizedDocument(input: SetNormalizedDocumentInput): Promise<void>;
  selectPage(pageIndex: number): Promise<void>;
  clearSession(): Promise<void>;
}

const generateSessionId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `nps_${crypto.randomUUID()}`;
  }

  return `nps_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

const initialState = (): NormalizedPageSessionState => ({
  sessionId: generateSessionId(),
  documentFingerprint: '',
  sourceName: '',
  pages: [],
  selectedPageIndex: 0
});

export const createNormalizedPageSessionStore = (): NormalizedPageSessionStore => {
  let state = initialState();
  const listeners = new Set<StoreListener>();

  const commit = (next: NormalizedPageSessionState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };

  return {
    getSnapshot: () => state,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setNormalizedDocument: async ({ sourceName, pages }) => {
      const selectedPageIndex = pages[0]?.pageIndex ?? 0;

      commit({
        sessionId: generateSessionId(),
        documentFingerprint: buildDocumentFingerprint({ sourceName, pages }),
        sourceName,
        pages,
        selectedPageIndex
      });
    },

    selectPage: async (pageIndex) => {
      if (!state.pages.some((page) => page.pageIndex === pageIndex)) {
        return;
      }

      commit({ ...state, selectedPageIndex: pageIndex });
    },

    clearSession: async () => {
      commit(initialState());
    }
  };
};
