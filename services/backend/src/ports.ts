import type {
  Day,
  EditInput,
  Reflection,
  Correction,
  Capture,
  Observation,
  Recap,
} from "./Wire";

export interface AuthContext {
  readonly subject: string;
  readonly deviceId: string | null;
}
export interface JournalStore<T> {
  load(): T;
  commit(state: T): void;
}
export interface ObjectStore {
  put(id: string, bytes: Uint8Array): void;
  get(id: string): Uint8Array | undefined;
  remove(id: string): void;
}
export interface ObservationProvider {
  observe(capture: Capture): Observation;
}
export interface RecapProvider {
  compose(day: Day, observations: Observation[], captures: Capture[]): Recap;
}
export interface JournalRepository {
  getDay(owner: string, dayId: string): Day;
  saveReflection(
    owner: string,
    dayId: string,
    id: string,
    edit: EditInput,
  ): Reflection;
  saveCorrection(
    owner: string,
    momentId: string,
    id: string,
    edit: EditInput,
  ): Correction;
}
