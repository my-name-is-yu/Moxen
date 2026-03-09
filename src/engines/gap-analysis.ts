import { Goal, Gap, Checklist } from '../state/models.js';
import { debug } from '../debug.js';

const INVERSE_DIMENSIONS = new Set(['open_issues']);

export class GapAnalysisEngine {
  computeGaps(goal: Goal, checklist?: Checklist): Gap[] {
    // Checklist-aware path
    if (checklist) {
      const gaps: Gap[] = [];
      for (const item of checklist.items) {
        if (item.status === 'verified') {
          // No gap — item is fully verified
          continue;
        }
        if (item.status === 'self_verified') {
          // Partial credit — small residual gap
          gaps.push({ dimension: `checklist:${item.id}`, current: 0, target: 1, magnitude: 0.2, confidence: 1.0 });
        } else {
          // pending or failed — full gap
          gaps.push({ dimension: `checklist:${item.id}`, current: 0, target: 1, magnitude: 1.0, confidence: 1.0 });
        }
      }
      debug('gap-analysis', 'checklist gaps computed', { goal_id: goal.id, gaps_count: gaps.length });
      return gaps;
    }

    // No checklist and no explicit thresholds — emit sentinel gap
    if (goal.checklist_created === false && Object.keys(goal.achievement_thresholds).length === 0) {
      const gap: Gap = { dimension: 'checklist_missing', current: 0, target: 1, magnitude: 1.0, confidence: 1.0 };
      debug('gap-analysis', 'checklist missing gap emitted', { goal_id: goal.id });
      return [gap];
    }

    // Fallback: threshold-based gap analysis
    const gaps: Gap[] = [];
    const thresholdCount = Object.keys(goal.achievement_thresholds).length;
    debug('gap-analysis', 'computing gaps', { goal_id: goal.id, threshold_dimensions: thresholdCount });

    for (const [dim, threshold] of Object.entries(goal.achievement_thresholds)) {
      const sv = goal.state_vector[dim];

      if (!sv) {
        // No observation — assume maximum gap with low confidence
        gaps.push({ dimension: dim, current: 0, target: threshold, magnitude: 1.0, confidence: 0.3 });
        continue;
      }

      let magnitude: number;
      if (INVERSE_DIMENSIONS.has(dim)) {
        magnitude = Math.max(0, (sv.value - threshold)) / Math.max(sv.value, 1);
      } else {
        magnitude = threshold === 0 ? 0 : Math.max(0, (threshold - sv.value)) / threshold;
      }
      magnitude = Math.min(1.0, magnitude);

      gaps.push({
        dimension: dim,
        current: sv.value,
        target: threshold,
        magnitude,
        confidence: sv.confidence,
      });
    }

    const sorted = gaps.sort((a, b) => (b.magnitude * b.confidence) - (a.magnitude * a.confidence));
    debug('gap-analysis', 'gaps found', { goal_id: goal.id, gaps_count: sorted.length, max_gap: sorted[0]?.magnitude ?? 0 });
    return sorted;
  }

  maxGapScore(goal: Goal, checklist?: Checklist): number {
    const gaps = this.computeGaps(goal, checklist);
    if (gaps.length === 0) return 0;
    return Math.max(...gaps.map(g => g.magnitude * g.confidence));
  }

  isGoalSatisfied(goal: Goal, threshold = 0.05, checklist?: Checklist): boolean {
    const gaps = this.computeGaps(goal, checklist);
    return gaps.every(g => g.magnitude <= threshold);
  }
}
