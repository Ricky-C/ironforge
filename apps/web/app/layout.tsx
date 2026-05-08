import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthHeader } from "@/components/auth-header";
import { cn } from "@/lib/utils";
import { Providers } from "./providers";

const geist = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Ironforge",
  description:
    "A self-service Internal Developer Platform on AWS. Provision pre-configured static websites with custom subdomain, TLS, GitHub repo, and CI/CD in ~5 minutes.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Dark-first per design direction. The `dark` class triggers shadcn's
  // dark-mode token overrides in globals.css; light-mode tokens remain
  // available for any future opt-in surface. A theme toggle would flip
  // this class on <html>; not in scope for PR-1.
  return (
    <html
      lang="en"
      className={cn("dark font-sans antialiased", geist.variable, geistMono.variable)}
    >
      <body>
        <Providers>
          <AuthHeader />
          {children}
        </Providers>
      </body>
    </html>
  );
}
