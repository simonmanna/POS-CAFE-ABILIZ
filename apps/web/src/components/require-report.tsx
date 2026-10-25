import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3 } from 'lucide-react';
import { useCanViewReport } from '@/features/reports/access-api';
import { tx } from '@/lib/i18n/tx';

/**
 * Route gate for a configurable report page. Pairs with RequirePermission:
 * permissions say what the role may read, Settings → Report Permissions says
 * which of those reports it is shown. The API enforces the permission either
 * way.
 */
export function RequireReport({ reportId, children }: { reportId: string; children: ReactNode }) {
  const canView = useCanViewReport();
  if (canView(reportId)) return <>{children}</>;
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-3 p-10 text-center">
      <BarChart3 className="h-8 w-8 text-muted-foreground" aria-hidden />
      <h1 className="text-lg font-semibold text-foreground">{tx('This report is hidden for your role')}</h1>
      <p className="text-sm text-muted-foreground">
        {tx('An administrator can enable it under Settings → Report Permissions.')}
      </p>
      <Link to="/" className="text-sm font-medium text-primary hover:underline">
        {tx('Back to dashboard')}
      </Link>
    </div>
  );
}
