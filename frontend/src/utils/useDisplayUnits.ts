import { useSyncExternalStore } from "react";
import { getDisplayUnits, subscribeDisplayUnits } from "./units";

export function useDisplayUnits() {
  return useSyncExternalStore(
    subscribeDisplayUnits,
    getDisplayUnits,
    getDisplayUnits,
  );
}
