import { farmFieldMap } from './maps/farm-field';
import { parseMapDefinition, type MapDefinition } from './schema';

/** Every official, source-controlled map. */
export const MAP_DEFINITIONS: Readonly<Record<string, MapDefinition>> = Object.freeze({
  [farmFieldMap.id]: farmFieldMap,
});

export const DEFAULT_MAP_DEFINITION_ID = farmFieldMap.id;

export function getMapDefinition(id: string | undefined): MapDefinition | undefined {
  if (!id) return undefined;
  return MAP_DEFINITIONS[id];
}

/** Guard so a malformed official map fails in tests rather than at runtime. */
export function validateOfficialMaps(): string[] {
  const problems: string[] = [];
  for (const [id, definition] of Object.entries(MAP_DEFINITIONS)) {
    const result = parseMapDefinition(definition);
    if (!result.ok) problems.push(`${id}: ${result.issues.join('; ')}`);
    if (definition.id !== id) problems.push(`${id}: registry key does not match definition id "${definition.id}"`);
  }
  return problems;
}
