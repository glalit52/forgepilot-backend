import type { Health, HealthDimension } from "../schemas";

/** Explainable, versioned weights (PRD §8.5). Missing data is "unknown", never healthy. */
export const HEALTH_WEIGHTS: Record<HealthDimension, number> = {
  dependencies: 0.2,
  security: 0.25,
  buildStability: 0.2,
  tests: 0.2,
  docs: 0.15,
};
export const HEALTH_SCORE_VERSION = "v1.2";

export const HEALTH_DIMENSION_LABEL: Record<HealthDimension, string> = {
  dependencies: "Dependency health",
  security: "Security posture",
  buildStability: "Build stability",
  tests: "Test reliability",
  docs: "Documentation",
};

export function computeHealthScore(h: Omit<Health, "score" | "scoreVersion">): number {
  const known = (Object.keys(HEALTH_WEIGHTS) as HealthDimension[]).filter((k) => h[k] !== null);
  const w = known.reduce((s, k) => s + HEALTH_WEIGHTS[k], 0);
  if (!w) return 0;
  return Math.round(known.reduce((s, k) => s + HEALTH_WEIGHTS[k] * (h[k] as number), 0) / w);
}

export type HealthBand = "healthy" | "at_risk" | "poor";

export function healthBand(score: number): HealthBand {
  if (score >= 80) return "healthy";
  if (score >= 60) return "at_risk";
  return "poor";
}
