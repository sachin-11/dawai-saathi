import { redirect } from 'next/navigation';

import { LoginForm } from '@/components/admin/login-form';
import { currentAdmin } from '@/lib/gateway';
import { serverEnv } from '@/lib/server-env';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await currentAdmin()) redirect('/admin');
  const env = serverEnv();
  const { error } = await searchParams;
  return (
    <main className="mx-auto grid min-h-dvh max-w-md place-items-center px-4">
      <div className="w-full space-y-6 rounded-2xl border border-border bg-surface p-8 shadow-sm">
        <div>
          <h1 className="text-2xl font-extrabold">Dawai Saathi admin</h1>
          <p className="text-muted">
            Operators only. Patient data stays hidden until you reveal it with a reason.
          </p>
        </div>
        {error && (
          <p
            role="alert"
            className="rounded-lg bg-danger-soft p-3 text-sm font-semibold text-danger"
          >
            Sign-in was refused. Only allow-listed operator accounts can enter.
          </p>
        )}
        <LoginForm
          github={Boolean(env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET)}
          testLogin={env.ADMIN_TEST_LOGIN === 'true'}
        />
      </div>
    </main>
  );
}
