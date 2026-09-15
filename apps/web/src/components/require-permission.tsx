import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';

/**
 * Route-level permission gate. The API still enforces every permission; this
 * keeps people from landing on a page that can only answer "forbidden".
 * `permission` may be a list — any one of them is enough.
 */
export function RequirePermission({ permission, children }: { permission: string | string[]; children: ReactNode }) {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const needed = Array.isArray(permission) ? permission : [permission];
  if (needed.some((p) => hasPermission(p))) return <>{children}</>;
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-3 p-10 text-center">
      <ShieldAlert className="h-8 w-8 text-muted-foreground" aria-hidden />
      <h1 className="text-lg font-semibold text-foreground">You don’t have access to this page</h1>
      <p className="text-sm text-muted-foreground">Ask a manager or administrator to grant access if you need it.</p>
      <Link to="/" className="text-sm font-medium text-primary hover:underline">Back to dashboard</Link>
    </div>
  );
}
