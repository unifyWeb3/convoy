import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Convoy',
  description: 'Autonomous onchain release operator',
};

// Left rail (Runs / New Run / Docs) is implemented in CVY-009.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
