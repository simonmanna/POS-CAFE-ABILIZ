// app/pos/layout.tsx
import POSLayout from "../../layouts/POSLayout";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <POSLayout>{children}</POSLayout>;
}