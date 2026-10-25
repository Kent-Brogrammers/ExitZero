import { useEffect, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import type { SimulationMetrics } from "../types/simulation";

export function PopulationChart({ metrics }: { metrics: SimulationMetrics }) {
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const bounds = element.getBoundingClientRect();
      setSize((old) =>
        old.width === bounds.width && old.height === bounds.height
          ? old
          : { width: bounds.width, height: bounds.height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={container}
      className="chart"
      role="img"
      aria-label={`${metrics.evacuated} evacuated and ${metrics.remaining} remaining. Trapped occupants are included in remaining.`}
    >
      {size.width > 0 && size.height > 0 && (
        <BarChart
          width={size.width}
          height={size.height}
          data={[
            { name: "Evacuated", occupants: metrics.evacuated },
            { name: "Remaining", occupants: metrics.remaining },
          ]}
          margin={{ top: 12, right: 12, bottom: 0, left: -24 }}
        >
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="name" tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
          <Tooltip />
          <Bar
            dataKey="occupants"
            fill="#347d69"
            radius={[4, 4, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      )}
    </div>
  );
}
