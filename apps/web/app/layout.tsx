import type { Metadata } from "next";
import { Bricolage_Grotesque, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/components/shell/theme-provider";

// Load the declared typefaces via next/font so the UI renders in its real
// identity instead of silently falling back to system fonts. Exposed as CSS
// variables that `--font-sans` / `--font-mono` / `--font-display` consume.
// Inter carries the dense product UI; Bricolage Grotesque is the display
// voice (wordmark, landing, page titles); JetBrains Mono stamps ticket IDs
// and trace data.
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-bricolage",
});

export const metadata: Metadata = {
  title: "DevPilot - the board your agents run",
  description:
    "Drop tickets on a board. Your crew of AI agents picks them up, hands them off role to role, and ships them - every step durable, watchable, and replayable.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable} ${bricolage.variable}`}
    >
      <head>
        {/* Set the .dark class before first paint to avoid a light flash. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="bg-background min-h-screen font-sans antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
