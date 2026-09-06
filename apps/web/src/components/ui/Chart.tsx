'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface ChartDatum {
  name: string;
  value: number;
  color: string;
}

const GRID_COLOR = '#94a3b8';
const TOOLTIP_STYLE = {
  fontSize: 12,
  borderRadius: 8,
  borderColor: 'var(--border)',
  backgroundColor: 'var(--popover)',
  color: 'var(--popover-foreground)',
};

// Thin wrappers over recharts so pages never import recharts directly —
// one place to change chart styling/library later.
export function DistributionBarChart({ data, height = 220 }: { data: ChartDatum[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} opacity={0.2} />
        <XAxis dataKey="name" tick={{ fontSize: 12, fill: GRID_COLOR }} />
        <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: GRID_COLOR }} />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--muted)' }} />
        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
          {data.map((entry) => (
            <Cell key={entry.name} fill={entry.color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DistributionPieChart({ data, height = 220 }: { data: ChartDatum[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Pie data={data} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
          {data.map((entry) => (
            <Cell key={entry.name} fill={entry.color} />
          ))}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  );
}

export interface TrendPoint {
  label: string;
  value: number;
}

// Used for "Compliance Trend"/"Discovery Trend" — client-side history
// derived from whatever data points a page has already fetched (there is
// no backend time-series endpoint for either), see DECISIONS.md.
export function TrendLineChart({
  data,
  color = 'var(--primary)',
  height = 220,
}: {
  data: TrendPoint[];
  color?: string;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} opacity={0.2} />
        <XAxis dataKey="label" tick={{ fontSize: 12, fill: GRID_COLOR }} />
        <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: GRID_COLOR }} />
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={{ r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}
