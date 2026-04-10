import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DevLoop',
  description: 'DevLoop central runtime',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <html lang="en">
      <body>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
