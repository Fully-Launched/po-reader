import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PO Reader",
  description: "Vendor invoice to ServiceTitan Purchase Order automation",
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
