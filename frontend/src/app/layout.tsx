import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'JARVIS // CORE PROTOCOL v2.5',
  description: 'Advanced Offline Voice and Text Assistant powered by QVAC SDK',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="mr">
      <body>{children}</body>
    </html>
  );
}
