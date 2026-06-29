// The level used to be a single authored classroom; it is now a procedurally built
// multi-room school. The building lives in ./level.ts. This module re-exports it so
// existing imports of `@shared/classroom` (client movement, server movement/spawns,
// the map builder) keep working unchanged.
export * from "./level";
