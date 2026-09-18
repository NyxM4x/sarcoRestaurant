import type { Metadata } from "next";
import { Geist, Geist_Mono, Bangers } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * Fuente de alto impacto para el rediseño del menú (EXPERIMENTAL, rama
 * `rediseno-menu-fastfood`, 17-09-2026). Se registra como variable CSS a nivel
 * global — igual que Geist — pero NO se usa en ningún lado salvo donde se pida
 * explícitamente `font-display` (ver `ProductCard`). El dashboard y el resto
 * del sitio siguen viéndose exactamente igual.
 */
const bangers = Bangers({
  variable: "--font-bangers",
  subsets: ["latin"],
  weight: "400",
});

export const metadata: Metadata = {
  title: "Don Zarco Orders",
  description: "Sistema de pedidos por WhatsApp para Don Zarco.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable} ${bangers.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
