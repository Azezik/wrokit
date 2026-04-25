export interface Engine<TInput, TOutput> {
  readonly name: string;
  readonly version: string;
  run(input: TInput): Promise<TOutput>;
  cancel?(): void;
}
