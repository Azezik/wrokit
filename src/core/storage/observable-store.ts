export type StoreListener = () => void;

export interface ObservableStore<TSnapshot> {
  getSnapshot(): TSnapshot;
  subscribe(listener: StoreListener): () => void;
}
