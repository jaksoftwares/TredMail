import type { Metadata, Viewport } from "next";
import { Open_Sans } from "next/font/google";
import "./globals.css";

const openSans = Open_Sans({
  variable: "--font-open-sans",
  subsets: ["latin"],
  weight: ["300", "400", "600", "700", "800"],
});

// Public console address, used to make the Open Graph image URL absolute. Set at build time.
const consoleUrl = process.env.CONSOLE_URL ?? "http://localhost:3010";

export const metadata: Metadata = {
  metadataBase: new URL(consoleUrl),
  title: { default: "TredMail", template: "%s · TredMail" },
  description: "TredMail by Dovepeak Technologies: transactional email for your applications.",
  applicationName: "TredMail",
  authors: [{ name: "Dovepeak Technologies", url: "https://dovepeakdigital.com" }],
  creator: "Dovepeak Technologies",
  publisher: "Dovepeak Technologies",
  openGraph: {
    type: "website",
    siteName: "TredMail by Dovepeak Technologies",
    title: "TredMail",
    description: "Transactional email for your applications, by Dovepeak Technologies.",
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#000027",
  colorScheme: "light",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${openSans.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
