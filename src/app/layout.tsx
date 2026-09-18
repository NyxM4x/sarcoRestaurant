import type { Metadata } from "next";
import { Geist, Geist_Mono, Bangers, Luckiest_Guy } from "next/font/google";
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

/**
 * Fuente de los PRECIOS (18-09-2026). Genera `font-price`.
 *
 * Es otra y no Bangers porque en Bangers el 7 es casi un 1: la porción de papa
 * a Bs 7 se leía "Bs 1". No es de ese precio —es del glifo—, y los totales
 * llevan 7 todo el tiempo: un pedido de Bs 71 leído como Bs 11 es una
 * discusión en la puerta.
 *
 * Tampoco es la sans de siempre: se probó, y con la vitrina de comida rápida
 * los precios quedaban formales, de otra carta. Luckiest Guy mantiene el golpe
 * —gruesa, de caja alta, cómica— con los dígitos sin ambigüedad.
 */
const luckiestGuy = Luckiest_Guy({
  variable: "--font-luckiest-guy",
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
      className={`${geistSans.variable} ${geistMono.variable} ${bangers.variable} ${luckiestGuy.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
