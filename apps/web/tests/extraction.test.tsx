import { render, screen, within } from '@testing-library/react';

import { ConfidenceBar } from '@/components/demo/confidence-bar';
import { ExtractionView } from '@/components/demo/extraction-view';
import { GenericsView, WarningsView } from '@/components/demo/generics-warnings';
import type { DemoExtraction } from '@/lib/demo-types';
import { renderWithIntl } from './helpers';

const f = <T,>(value: T | null, confidence = 0.95) => ({ value, confidence });

describe('ConfidenceBar', () => {
  it('shows the number and is red below the 0.75 threshold', () => {
    const { rerender } = render(<ConfidenceBar value={0.9} label="c" />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '90');
    expect(screen.getByTestId('confidence-fill').className).toContain('bg-ok');
    rerender(<ConfidenceBar value={0.5} label="c" />);
    expect(screen.getByTestId('confidence-fill').className).toContain('bg-danger');
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('treats a missing value as unknown, not as 100%', () => {
    render(<ConfidenceBar value={undefined} label="c" />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText('–')).toBeInTheDocument();
  });
});

describe('ExtractionView', () => {
  const rx: DemoExtraction = {
    kind: 'prescription',
    medicines: [
      {
        name: f('Dolo 650'),
        strength: f('650 mg'),
        dose: f('1 tablet'),
        frequency_code: f('1-0-1'),
        relation_to_food: f('after'),
        duration_days: f(5),
      },
      { name: f(null, 0.2), dose: f('1 tablet', 0.6), low_confidence: true },
    ],
  };

  it('highlights low-confidence rows and never prints a guessed name', () => {
    renderWithIntl(<ExtractionView extraction={rx} />);
    const rows = screen.getAllByTestId('medicine-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('data-low', 'false');
    expect(rows[1]).toHaveAttribute('data-low', 'true');
    expect(within(rows[1]!).getByText('Could not read clearly')).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/confirm with the pharmacist/i)).toBeInTheDocument();
    expect(within(rows[0]!).getByText('After food')).toBeInTheDocument();
  });

  it('renders lab results with a status chip and the range basis', () => {
    renderWithIntl(
      <ExtractionView
        extraction={{
          kind: 'lab_report',
          results: [
            {
              raw_test_name: f('Haemoglobin'),
              value_raw: f('6.1'),
              unit: f('g/dL'),
              status: 'critical_low',
              range_basis: 'printed',
              range_text: '12.0 - 15.5',
            },
          ],
        }}
      />,
    );
    const row = screen.getByTestId('lab-row');
    expect(within(row).getByText('Critical low')).toBeInTheDocument();
    expect(within(row).getByText('Printed on report')).toBeInTheDocument();
    expect(within(row).getByText('6.1 g/dL')).toBeInTheDocument();
  });

  it('says so when nothing was extracted', () => {
    renderWithIntl(<ExtractionView extraction={null} />);
    expect(screen.getByText('Nothing was extracted from this image.')).toBeInTheDocument();
  });
});

describe('GenericsView / WarningsView', () => {
  it('shows alternatives with a Jan Aushadhi badge and the price date, claims savings only when known', () => {
    const extraction: DemoExtraction = {
      kind: 'prescription',
      medicines: [
        {
          name: f('Telma 40'),
          generic: {
            savings_known: false,
            price_source_date: '2026-11-01',
            alternatives: [
              {
                brand_name: 'Telmisartan 40',
                is_janaushadhi: true,
                price_per_unit: 2.5,
                approx_savings: 40,
              },
            ],
          },
        },
      ],
    };
    renderWithIntl(<GenericsView extraction={extraction} />);
    expect(screen.getByText('Jan Aushadhi')).toBeInTheDocument();
    expect(screen.getByText(/Prices as of 2026-11-01/)).toBeInTheDocument();
    expect(screen.queryByText(/Approx. saving/)).toBeNull();
  });

  it('lists warnings and handles none', () => {
    const { unmount } = renderWithIntl(
      <WarningsView warnings={[{ type: 'critical_value', detail: 'Contact a doctor today.' }]} />,
    );
    expect(screen.getByText('Critical value')).toBeInTheDocument();
    expect(screen.getByText('Contact a doctor today.')).toBeInTheDocument();
    unmount();
    renderWithIntl(<WarningsView warnings={[]} />);
    expect(screen.getByText('No warnings for this document.')).toBeInTheDocument();
  });
});
