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
      <head>
        {/* The 2.47.0/iconfont/... path 404s -- that version/path never existed on
            cdnjs (versions jump 1.35.0 -> 3.10.0, and the CSS file moved out of an
            "iconfont/" subdirectory). This silently broke every icon in the app,
            not just the confirmation screen's checkmark -- found while fixing that. */}
        <link
          rel="stylesheet"
          href="https://cdnjs.cloudflare.com/ajax/libs/tabler-icons/3.47.0/tabler-icons.min.css"
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
