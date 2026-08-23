'use client';

import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { funnelMetrics, type CampaignAnalytics } from '@/lib/types';

export function FunnelChart({ analytics }: { analytics: CampaignAnalytics }) {
  const data = funnelMetrics.map(metric => ({
    label: metric.label,
    value: analytics[metric.key],
    fill: metric.color,
  }));

  return (
    <div className="h-72 w-full" aria-label="Campaign conversion funnel">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 8, right: 20, left: 8, bottom: 8 }}>
          <CartesianGrid horizontal={false} stroke="#2a3233" />
          <XAxis type="number" allowDecimals={false} stroke="#91a09d" tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey="label" width={70} stroke="#91a09d" tickLine={false} axisLine={false} />
          <Tooltip
            cursor={{ fill: '#191e1f' }}
            contentStyle={{ background: '#121617', border: '1px solid #2a3233', borderRadius: 8, color: '#edf3f1' }}
            labelStyle={{ color: '#edf3f1' }}
          />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={22}>
            {data.map(item => <Cell key={item.label} fill={item.fill} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
