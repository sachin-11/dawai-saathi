import { ImageResponse } from 'next/og';

export const alt = 'Dawai Saathi: prescription samjho, sasti dawai jaano, dose na bhoolo';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: 80,
        background: '#fbf7f0',
        color: '#17282b',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <div
          style={{
            width: 96,
            height: 96,
            borderRadius: 24,
            background: '#0f766e',
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 56,
            fontWeight: 800,
          }}
        >
          DS
        </div>
        <div style={{ fontSize: 64, fontWeight: 800 }}>Dawai Saathi</div>
      </div>
      <div style={{ marginTop: 48, fontSize: 56, fontWeight: 700, lineHeight: 1.2 }}>
        Prescription samjho. Sasti dawai jaano. Dose na bhoolo.
      </div>
      <div style={{ marginTop: 36, fontSize: 34, color: '#55676b' }}>
        A WhatsApp health assistant for Indian families · Hindi + English
      </div>
    </div>,
    size,
  );
}
