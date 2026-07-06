// Root layout + plain inline CSS (no external CDNs, fonts, or stylesheets).
export const metadata = {
  title: "Analytics Dashboard",
  description: "A usage analytics dashboard on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
  main { max-width: 52rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { margin: 0 0 .25rem; }
  h2 { margin: 2rem 0 .75rem; font-size: 1.1rem; }
  .hint { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: .75rem; }
  .card { border: 1px solid #8884; border-radius: .6rem; padding: .9rem 1rem; }
  .card .k { font-size: .8rem; opacity: .7; }
  .card .v { font-size: 1.6rem; font-weight: 600; }
  .row { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; }
  input, select { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; }
  input.type { flex: 2; min-width: 8rem; }
  input.value { flex: 1; min-width: 6rem; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; background: #6663; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .5rem .4rem; border-bottom: 1px solid #8883; font-size: .92rem; }
  th { opacity: .7; font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .empty { opacity: .6; }
`;

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
