import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PR State Bug Hunter Dashboard",
  description: "AI-powered AST static analysis tool for Pull Requests",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
