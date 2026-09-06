// Raw severity counts a RiskScore row is computed from — shared shape
// between RiskService's internal aggregation and the persisted counts on
// the RiskScore row itself.
export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
  informational: number;
}
