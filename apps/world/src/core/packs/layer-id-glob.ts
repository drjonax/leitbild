// Tiny glob matcher for MapLibre layer-id patterns contributed via
// WorldPack.mapLayerGroups[].layerIdPattern.
//
// Semantics:
//   `*` matches one ':'-separated segment (no ':' allowed within a `*`).
//   No `**`, no character classes, no `?`. Patterns are colon-delimited so
//   layer ids are partitioned cleanly.
//
// Examples:
//   `reference:roads:*:*` matches `reference:roads:major:line`
//   `reference:roads:bridges:*` matches `reference:roads:bridges:label`
//   `reference:roads:*:*` does NOT match `reference:roads:major:line:extra`
//   (segment count must match)

const escapeRegexLiteral = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

export const compileLayerIdPattern = (pattern: string): RegExp => {
  const segments = pattern.split(':')
  const reSegments = segments.map(seg => (seg === '*' ? '[^:]+' : escapeRegexLiteral(seg)))
  return new RegExp(`^${reSegments.join(':')}$`)
}

export const layerIdMatchesPattern = (layerId: string, pattern: string): boolean =>
  compileLayerIdPattern(pattern).test(layerId)

export const layerIdsMatching = (
  layerIds: ReadonlyArray<string>,
  pattern: string,
): ReadonlyArray<string> => {
  const re = compileLayerIdPattern(pattern)
  return layerIds.filter(id => re.test(id))
}
