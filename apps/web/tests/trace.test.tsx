import { screen } from '@testing-library/react';

import { summariseTrace, TraceView } from '@/components/demo/trace-view';
import type { TraceEntry } from '@/lib/demo-types';
import { renderWithIntl } from './helpers';

const trace: TraceEntry[] = [
  { node: 'prepare_image', latency_ms: 40, status: 'ok' },
  {
    node: 'vision_extract_rx',
    latency_ms: 2000,
    status: 'ok',
    model: 'm-vision',
    tokens_in: 1200,
    tokens_out: 300,
    cost_usd: 0.02,
    prompt_version: 'rx_extract_v1',
  },
  { node: 'composer', latency_ms: 500, status: 'fallback', cost_usd: 0.001 },
  { node: 'verifier', latency_ms: 5, status: 'ok' },
];

describe('trace summary', () => {
  it('adds latency and cost and tracks the visited nodes', () => {
    const s = summariseTrace(trace);
    expect(s.totalLatencyMs).toBe(2545);
    expect(s.totalCostUsd).toBeCloseTo(0.021);
    expect(s.maxLatencyMs).toBe(2000);
    expect(s.visited.has('verifier')).toBe(true);
    expect(s.verifier).toBe('ok');
  });

  it('reports the verifier falling back to the template', () => {
    expect(
      summariseTrace([...trace, { node: 'rx_fallback', latency_ms: 1, status: 'ok' }]).verifier,
    ).toBe('fallback');
    expect(summariseTrace([{ node: 'templates', latency_ms: 1, status: 'ok' }]).verifier).toBe(
      'skipped',
    );
  });
});

describe('TraceView', () => {
  it('draws one row per node, proportional latency bars and the model, prompt and tokens', () => {
    renderWithIntl(<TraceView trace={trace} />);
    expect(screen.getAllByTestId('trace-row')).toHaveLength(4);
    const bars = screen.getAllByTestId('latency-bar');
    expect(bars[1]).toHaveStyle({ width: '100%' });
    expect(Number.parseFloat(bars[0]!.style.width)).toBeLessThan(5);
    expect(screen.getByText('m-vision')).toBeInTheDocument();
    expect(screen.getByText('rx_extract_v1')).toBeInTheDocument();
    expect(screen.getByText('1200 / 300')).toBeInTheDocument();
    expect(screen.getByText(/^2.5[45] s$/)).toBeInTheDocument();
    expect(screen.getByText('fallback')).toBeInTheDocument();
  });

  it('highlights visited nodes in the graph', () => {
    const { container } = renderWithIntl(<TraceView trace={trace} />);
    const visited = [...container.querySelectorAll('svg g[data-visited="true"]')].map(
      (g) => g.textContent,
    );
    expect(visited).toEqual(
      expect.arrayContaining(['prepare_image', 'vision_extract_rx', 'composer', 'verifier']),
    );
    expect(visited).not.toContain('lab_gate');
  });

  it('handles a missing trace', () => {
    renderWithIntl(<TraceView trace={null} />);
    expect(screen.getByText('No trace was returned for this run.')).toBeInTheDocument();
  });
});
