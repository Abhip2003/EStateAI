import type { Metadata } from 'next';
import { AuthProvider } from '../lib/auth/AuthProvider';
import { RealtimeProvider } from '../lib/realtime/RealtimeProvider';
import { ToastProvider } from '../components/layout/ToastProvider';
import { QueryProvider } from '../lib/query/QueryProvider';
import { ThemeProvider } from '../lib/theme/ThemeProvider';
import './globals.css';

export const metadata: Metadata = {
  title: 'EstateAI',
  description: 'AI-powered digital asset security dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <QueryProvider>
            <AuthProvider>
              <RealtimeProvider>
                <ToastProvider>{children}</ToastProvider>
              </RealtimeProvider>
            </AuthProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
