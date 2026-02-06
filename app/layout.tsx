import type { Metadata } from "next";
import "../styles/globals.css";

export const metadata: Metadata = {
  title: "ClipGenius Studio",
  description: "AI-powered video editing studio"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

