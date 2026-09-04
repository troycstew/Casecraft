export const metadata = {
  title: "Pro Se Commons",
  description: "Pro Se Commons — real backend (in progress)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
