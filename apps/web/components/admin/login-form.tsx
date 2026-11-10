'use client';

import { signIn } from 'next-auth/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

export function LoginForm({ github, testLogin }: { github: boolean; testLogin: boolean }) {
  const [email, setEmail] = useState('');
  return (
    <div className="space-y-4">
      {github && (
        <Button className="w-full" onClick={() => signIn('github', { callbackUrl: '/admin' })}>
          Sign in with GitHub
        </Button>
      )}
      {testLogin && (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void signIn('credentials', { email, callbackUrl: '/admin' });
          }}
        >
          <label className="block text-sm font-semibold" htmlFor="test-email">
            Test login (non-production only)
          </label>
          <input
            id="test-email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="min-h-12 w-full rounded-xl border border-border bg-bg px-3"
          />
          <Button type="submit" variant="secondary" className="w-full">
            Sign in
          </Button>
        </form>
      )}
      {!github && !testLogin && (
        <p className="text-sm text-muted">
          No sign-in provider is configured (AUTH_GITHUB_ID / AUTH_GITHUB_SECRET).
        </p>
      )}
    </div>
  );
}
