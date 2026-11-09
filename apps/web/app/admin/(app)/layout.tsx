import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { AdminNav } from '@/components/admin/admin-nav';
import { currentAdmin } from '@/lib/gateway';

export const dynamic = 'force-dynamic';

export default async function AdminAppLayout({ children }: { children: ReactNode }) {
  const email = await currentAdmin();
  if (!email) redirect('/admin/login');
  return (
    <div className="mx-auto flex min-h-dvh max-w-7xl flex-col gap-4 px-4 py-4 md:flex-row">
      <AdminNav email={email} />
      <main id="main" className="min-w-0 flex-1 space-y-6 pb-12">
        {children}
      </main>
    </div>
  );
}
