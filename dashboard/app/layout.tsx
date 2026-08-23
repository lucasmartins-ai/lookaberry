import type { Metadata } from 'next';
import { DashboardShell } from '@/components/DashboardShell';
import './globals.css';

export const metadata: Metadata = {
  title: 'LookaBerry Ops Dashboard',
  description: 'Campaign operations and cadence monitoring',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body><DashboardShell>{children}</DashboardShell></body>
    </html>
  );
}
