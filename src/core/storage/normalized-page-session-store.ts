import type { NormalizedPage } from '../contracts/normalized-page';
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

/**
 * Canonical document-fingerprint formula. Exported so any caller that needs to
 * derive a fingerprint from a normalized document uses the exact same string
 * the session store will commit. Both Config Capture and Run Mode read this
 * shape through the session store; no feature should reconstruct it inline.
 */
export const buildDocumentFingerprint = (
  sourceName: string,
  pages: NormalizedPage[]
): string => {
  const surfaceSignature = pages
    .map((page) => `${page.pageIndex}:${Math.round(page.width)}x${Math.round(page.height)}`)
    .join('|');

  return `surface:${sourceName}#${surfaceSignature}`;
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
        documentFingerprint: buildDocumentFingerprint(sourceName, pages),
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

const normalizedPageSessionStore = createNormalizedPageSessionStore();

export const getNormalizedPageSessionStore = (): NormalizedPageSessionStore =>
  normalizedPageSessionStore;
