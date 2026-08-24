// Single source of truth for index-completeness semantics, shared by docmem_status and the
// docmem_search annotation.
export interface CoverageInput {
  expected: number | null;   // projects.expected_chunk_count
  embedded: number;          // live count of merged chunks for the project
  lastFullIndexAt: Date | null;
}

export interface Coverage {
  coverage: number; // 0..1
  complete: boolean;
}

export function computeCoverage(i: CoverageInput): Coverage {
  const { expected, embedded, lastFullIndexAt } = i;
  const coverage =
    expected != null && expected > 0
      ? Math.min(1, embedded / expected)
      : embedded > 0
        ? 1
        : 0;
  const complete = expected != null && lastFullIndexAt != null && embedded >= expected;
  return { coverage, complete };
}
