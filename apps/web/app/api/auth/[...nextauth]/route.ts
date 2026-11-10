import NextAuth from 'next-auth';

import { buildAuthOptions } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const handler = NextAuth(buildAuthOptions());
export { handler as GET, handler as POST };
