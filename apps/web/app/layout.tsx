import type { ReactNode } from 'react';
import '@xyflow/react/dist/style.css';
import './globals.css';

export const metadata = {
  title: 'Convoy — Onchain release control',
  description: 'Plan, critique, gate, execute, and prove onchain release batches.',
  icons: { icon: '/icon.svg' },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
