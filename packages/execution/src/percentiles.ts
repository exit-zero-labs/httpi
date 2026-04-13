/**
 * B6 percentile math. Uses linear interpolation between the two closest ranks
 * (NIST / Excel "PERCENTILE.INC" definition), matching most standard
 * libraries and the expectations encoded in the validation checklist.
 */

export function computePercentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (p <= 0) return Math.min(...values);
  if (p >= 100) return Math.max(...values);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower] ?? 0;
  const weight = rank - lower;
  const lo = sorted[lower] ?? 0;
  const hi = sorted[upper] ?? 0;
  return lo + (hi - lo) * weight;
}

export interface AggregateSummary {
  iterations: number;
  successes: number;
  failures: number;
  errorRate: number;
  latencyMs: {
    p50: number;
    p95: number;
    p99: number;
    min: number;
    max: number;
    mean: number;
  };
}

export function summarizeIterations(
  outcomes: Array<{ success: boolean; durationMs: number }>,
): AggregateSummary {
  const iterations = outcomes.length;
  const successes = outcomes.filter((o) => o.success).length;
  const failures = iterations - successes;
  const latencies = outcomes.map((o) => o.durationMs);
  const sum = latencies.reduce((a, b) => a + b, 0);
  return {
    iterations,
    successes,
    failures,
    errorRate: iterations === 0 ? 0 : failures / iterations,
    latencyMs: {
      p50: computePercentile(latencies, 50),
      p95: computePercentile(latencies, 95),
      p99: computePercentile(latencies, 99),
      min: latencies.length ? Math.min(...latencies) : 0,
      max: latencies.length ? Math.max(...latencies) : 0,
      mean: iterations === 0 ? 0 : sum / iterations,
    },
  };
}
