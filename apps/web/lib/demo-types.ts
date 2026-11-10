/** What the playground gets back (shape of the gateway's `POST /demo/process`). Fields we do not draw are `unknown`. */
export interface Field<T> {
  value: T | null;
  confidence: number;
}

export interface GenericAlternative {
  brand_name: string;
  is_janaushadhi: boolean;
  price_per_unit: number;
  pack_label?: string | null;
  pack_price?: number | null;
  approx_savings?: number | null;
  savings_basis?: 'course' | 'pack' | null;
}

export interface GenericSuggestion {
  alternatives?: GenericAlternative[];
  price_source_date?: string | null;
  savings_known: boolean;
  reason_if_none?: string | null;
}

export interface RxMedicine {
  raw_text?: Field<string>;
  name?: Field<string>;
  form?: Field<string>;
  strength?: Field<string>;
  dose?: Field<string>;
  frequency_code?: Field<string>;
  frequency_per_day?: Field<number>;
  timings?: Field<string[]>;
  relation_to_food?: Field<string>;
  duration_days?: Field<number>;
  as_needed?: boolean;
  low_confidence?: boolean;
  generic?: GenericSuggestion | null;
}

export interface LabRow {
  raw_test_name?: Field<string>;
  value_raw?: Field<string>;
  unit?: Field<string>;
  status?: string;
  range_basis?: 'printed' | 'flag' | 'fallback' | 'none';
  range_text?: string | null;
  lab_ref_text?: Field<string>;
  needs_confirmation?: boolean;
  section?: string | null;
  test_code?: string | null;
}

export interface DemoExtraction {
  kind: 'prescription' | 'lab_report';
  medicines?: RxMedicine[];
  results?: LabRow[];
  has_critical?: boolean;
  overall_confidence?: number | null;
  status?: string | null;
  image_quality?: string;
  used_general_range?: boolean;
}

export interface TraceEntry {
  node: string;
  latency_ms: number;
  status: 'ok' | 'error' | 'timeout' | 'fallback';
  model?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cost_usd?: number | null;
  prompt_version?: string | null;
}

export interface DemoWarning {
  type: string;
  detail: string;
}

export interface DemoReply {
  language: 'hi' | 'en';
  text: string;
  buttons: { id: string; title: string }[];
}

export interface DemoResult {
  intent: string;
  extraction?: DemoExtraction | null;
  warnings: DemoWarning[];
  reply: DemoReply;
  debug_trace?: TraceEntry[] | null;
  meta: {
    model?: string | null;
    prompt_version: string;
    latency_ms: number;
    cost_usd: number;
    provider?: string | null;
    fallback_used?: boolean;
  };
  cached: boolean;
  uploads_enabled: boolean;
}

export type DemoErrorCode =
  | 'rate_limited'
  | 'budget_exhausted'
  | 'captcha_failed'
  | 'captcha_unavailable'
  | 'unsupported_file'
  | 'file_too_large'
  | 'sample_unavailable'
  | 'ai_unavailable'
  | 'gateway_unavailable'
  | 'bad_request';

export interface DemoErrorBody {
  error: { code: DemoErrorCode; retry_after_s?: number };
}
