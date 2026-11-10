import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { AdminShellNav } from '@/components/admin/admin-nav';
import type { ThemeChoice } from '@/components/admin/theme-toggle';
import { currentAdmin } from '@/lib/gateway';

export const dynamic = 'force-dynamic';

export default async function AdminAppLayout({ children }: { children: ReactNode }) {
  const email = await currentAdmin();
  if (!email) redirect('/admin/login');
  const saved = (await cookies()).get('admin-theme')?.value;
  const theme: ThemeChoice = saved === 'light' || saved === 'dark' ? saved : 'system';
  return (
    <div className="min-h-dvh md:flex">
      <AdminShellNav email={email} theme={theme} />
      <main
        id="main"
        className="mx-auto min-w-0 w-full max-w-6xl flex-1 space-y-6 px-4 py-6 pb-28 md:px-8 md:py-8 md:pb-12"
      >
        {children}
      </main>
    </div>
  );
}
