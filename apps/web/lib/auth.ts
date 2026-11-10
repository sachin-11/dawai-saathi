import type { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import GithubProvider from 'next-auth/providers/github';

import { serverEnv } from '@/lib/server-env';

export const SESSION_MAX_AGE_S = 30 * 60;

/** True when this e-mail may open the admin (the allowlist, compared case-insensitively). */
export function isAllowedAdmin(
  email: string | null | undefined,
  allowlist: readonly string[],
): boolean {
  return typeof email === 'string' && allowlist.includes(email.trim().toLowerCase());
}

/**
 * Admin sign-in. GitHub OAuth in real use; a credentials provider that exists ONLY when
 * ADMIN_TEST_LOGIN=true (Playwright). `serverEnv()` refuses that flag in production.
 * Authorisation is the allowlist: a GitHub account whose e-mail is not in ADMIN_EMAILS cannot sign in,
 * and the gateway checks the same list again on every call.
 */
export function buildAuthOptions(): NextAuthOptions {
  const env = serverEnv();
  const providers: NextAuthOptions['providers'] = [];
  if (env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET) {
    providers.push(
      GithubProvider({ clientId: env.AUTH_GITHUB_ID, clientSecret: env.AUTH_GITHUB_SECRET }),
    );
  }
  if (env.ADMIN_TEST_LOGIN === 'true') {
    providers.push(
      CredentialsProvider({
        name: 'Test login',
        credentials: { email: { label: 'Email', type: 'email' } },
        authorize(credentials) {
          const email = credentials?.email?.trim().toLowerCase();
          return isAllowedAdmin(email, env.ADMIN_EMAILS) && email ? { id: email, email } : null;
        },
      }),
    );
  }
  return {
    providers,
    session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_S },
    jwt: { maxAge: SESSION_MAX_AGE_S },
    pages: { signIn: '/admin/login', error: '/admin/login' },
    callbacks: {
      signIn({ user }) {
        return isAllowedAdmin(user.email, env.ADMIN_EMAILS);
      },
      jwt({ token, user }) {
        if (user?.email) token.email = user.email.toLowerCase();
        return token;
      },
      session({ session, token }) {
        if (session.user && typeof token.email === 'string') session.user.email = token.email;
        return session;
      },
    },
  };
}
