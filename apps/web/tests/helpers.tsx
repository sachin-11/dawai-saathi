import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';

import en from '@/messages/en.json';
import hi from '@/messages/hi.json';

export function renderWithIntl(ui: ReactElement, locale: 'en' | 'hi' = 'en') {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : hi}>
      {ui}
    </NextIntlClientProvider>,
  );
}
