import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface StaffOption {
  value: string;
  label: string;
}

/**
 * All active staff in the current org, flattened to options for a
 * SearchableSelect. Used by the inventory dialogs that need a "Responsible
 * Person" / "Approved By" dropdown (Stock In, Stock Out, Damages, Adjustment,
 * Transfer).
 */
export function useStaffOptions() {
  return useQuery<StaffOption[]>({
    queryKey: ['staff', 'options'],
    queryFn: async () => {
      const res = await api.get<{
        data: { id: string; firstName: string; lastName: string | null; isActive: boolean }[];
      }>('/users', { params: { page: 1, pageSize: 1000 } });
      return (res.data.data ?? [])
        .filter((u) => u.isActive !== false)
        .map((u) => ({
          value: u.id,
          label: [u.firstName, u.lastName].filter(Boolean).join(' '),
        }));
    },
    staleTime: 5 * 60_000,
  });
}