import graph from '@/lib/generated/graph.json';

interface GraphNode {
  id: string;
  layer: number;
  index: number;
  of: number;
}
interface GraphEdge {
  from: string;
  to: string;
}

const WIDTH = 960;
const ROW = 62;
const NODE_W = 150;
const NODE_H = 30;
const PAD = 24;

const nodes = graph.nodes as GraphNode[];
const edges = graph.edges as GraphEdge[];

function position(node: GraphNode): { x: number; y: number } {
  return { x: ((node.index + 0.5) / node.of) * WIDTH, y: PAD + node.layer * ROW };
}

/**
 * The LangGraph pipeline, drawn from `docs/architecture/graph.mmd` (parsed at build time, so it can
 * never drift from the code). With `visited`, the nodes a request went through are highlighted.
 * Server-renderable: no client JS.
 */
export function GraphDiagram({
  visited,
  label,
  visitedLabel,
  notVisitedLabel,
}: {
  visited?: ReadonlySet<string>;
  label: string;
  visitedLabel?: string;
  notVisitedLabel?: string;
}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const height = PAD * 2 + (graph.layers - 1) * ROW + NODE_H;
  const marking = visited !== undefined;
  return (
    <div>
      <div className="overflow-x-auto rounded-xl border border-border bg-surface p-2">
        <svg
          role="img"
          aria-label={label}
          viewBox={`0 0 ${WIDTH} ${height}`}
          className="mx-auto h-auto w-full min-w-[40rem]"
        >
          <title>{label}</title>
          {edges.map((edge) => {
            const a = byId.get(edge.from);
            const b = byId.get(edge.to);
            if (!a || !b) return null;
            const p = position(a);
            const q = position(b);
            const on = marking && visited.has(edge.from) && visited.has(edge.to);
            return (
              <path
                key={`${edge.from}-${edge.to}`}
                d={`M${p.x},${p.y + NODE_H / 2} C${p.x},${p.y + ROW / 1.4} ${q.x},${q.y - ROW / 1.4} ${q.x},${q.y - NODE_H / 2}`}
                fill="none"
                stroke={on ? 'var(--primary)' : 'var(--border)'}
                strokeWidth={on ? 2.5 : 1}
                opacity={marking && !on ? 0.5 : 1}
              />
            );
          })}
          {nodes.map((node) => {
            const { x, y } = position(node);
            const on = marking ? visited.has(node.id) : false;
            const special = node.id === '__start__' || node.id === '__end__';
            return (
              <g
                key={node.id}
                data-visited={on}
                transform={`translate(${x - NODE_W / 2},${y - NODE_H / 2})`}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={special ? 15 : 8}
                  fill={on ? 'var(--primary-soft)' : 'var(--surface)'}
                  stroke={on ? 'var(--primary)' : 'var(--border)'}
                  strokeWidth={on ? 2.5 : 1.2}
                />
                <text
                  x={NODE_W / 2}
                  y={NODE_H / 2 + 4}
                  textAnchor="middle"
                  fontSize="12"
                  fontWeight={on ? 700 : 500}
                  fill={on || !marking ? 'var(--ink)' : 'var(--muted)'}
                >
                  {node.id.replace(/__/g, '')}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {marking && visitedLabel && notVisitedLabel && (
        <p className="mt-2 flex gap-4 text-xs text-muted">
          <span>
            <span
              aria-hidden
              className="mr-1 inline-block size-3 rounded border-2 border-primary bg-primary-soft align-middle"
            />
            {visitedLabel}
          </span>
          <span>
            <span
              aria-hidden
              className="mr-1 inline-block size-3 rounded border border-border bg-surface align-middle"
            />
            {notVisitedLabel}
          </span>
        </p>
      )}
    </div>
  );
}
